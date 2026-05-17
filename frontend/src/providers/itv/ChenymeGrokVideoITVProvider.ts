/**
 * Chenyme Grok2API Video ITV Provider
 *
 * 适配 https://github.com/chenyme/grok2api 这一分支的 `/v1/videos` 端点：
 *   - 创建任务：POST {baseUrl}/v1/videos    multipart/form-data
 *       字段：model / prompt / seconds / size / resolution_name / preset
 *             input_reference[]  (最多 7 张参考图，每个值是远程 URL 或文件)
 *       响应：{ id | task_id, status, ... }
 *   - 查询任务：GET  {baseUrl}/v1/videos/{id}
 *       响应：{ id, status, progress, metadata.url | result_urls[] | ... }
 *
 * 与其它 ITV provider 的关系：
 *   - 与项目内的 `grok2api-imagine-itv` (Grok2ApiImagineITVProvider) 区分：
 *     后者发 application/json + image_reference[] 字段，
 *     适配的是另一个 grok2api fork（旧 / 不同协议）；本 provider 不与之共用任何字段命名。
 *   - 与 `openai-video` 区分：后者发 OpenAI Sora 风格 JSON（无 size/resolution_name/preset 必填）。
 *
 * 字段值规范（chenyme/grok2api README）：
 *   - seconds:          6 | 10 | 12 | 16 | 20
 *   - size:             720x1280 | 1280x720 | 1024x1024 | 1024x1792 | 1792x1024
 *   - resolution_name:  480p | 720p
 *   - preset:           fun | normal | spicy | custom
 *
 * 上述字段名与值取值范围全部由用户在渠道配置 / 模型 defaults 提供；本 provider 做最简归一化
 * （如把 "9:16" 映射为 720x1280，把 "high" / "高清" 映射为 720p），其余值原样透传。
 *
 * 兼容性说明：
 *   chenyme/grok2api 实际接受 input_reference[] 同时支持文本 URL 与上传文件两种形态。
 *   本 provider 与项目其它 provider 行为一致，要求资源已经被 ensureRemoteUrlForMultipleSources
 *   归一为远程 URL（assetTransports = ['remote-url']），把每个 URL 作为 multipart 字符串字段
 *   `input_reference[]` 提交。
 */

import type {
  ITVConfig,
  ITVOptions,
  ProviderStartResult,
  ProviderTaskSnapshot,
} from '../../types';
import { isImageToVideoRequest, isReferenceToVideoRequest } from '../../types';
import { createLogger } from '../../store/logger';
import { sanitizeBodyForLog } from '../../utils/logFormatting';
import { safeFetch } from '../../utils/safeFetch';
import { buildChannelAuthRequest } from '../channel/auth';
import {
  assertSupportedVideoCapabilities,
  type ITVProvider,
  type ITVRequest,
  type ITVResult,
} from './types';

const logger = createLogger('ChenymeGrokVideoITV');

// chenyme/grok2api 文档约束。
const SECONDS_WHITELIST = new Set(['6', '10', '12', '16', '20']);
const SIZE_WHITELIST = new Set([
  '720x1280',
  '1280x720',
  '1024x1024',
  '1024x1792',
  '1792x1024',
]);
const RESOLUTION_WHITELIST = new Set(['480p', '720p']);
const PRESET_WHITELIST = new Set(['fun', 'normal', 'spicy', 'custom']);
const MAX_REFERENCE_IMAGES = 7;

const DEFAULT_SECONDS = '10';
const DEFAULT_SIZE = '1280x720';
const DEFAULT_RESOLUTION = '720p';
const DEFAULT_PRESET = 'normal';

interface VideoCreateResponse {
  id?: string;
  task_id?: string;
  status?: string;
  error?: { code?: string; message?: string };
}

interface VideoTaskResponse extends VideoCreateResponse {
  progress?: number | string;
  metadata?: {
    url?: string;
    result_urls?: string[];
    [k: string]: unknown;
  };
  result_urls?: string[];
  fail_reason?: string;
  message?: string;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 把任意时长输入归一到 chenyme/grok2api 接受的白名单值，越界向下吸附。 */
function normalizeSeconds(input: unknown, fallback: string): string {
  const num = readNumber(input);
  if (num == null) return fallback;
  const sortedAllowed = Array.from(SECONDS_WHITELIST).map(Number).sort((a, b) => a - b);
  // 选最接近的白名单值，等距时取较小值（避免无端拉长）
  let best = sortedAllowed[0];
  let bestDelta = Math.abs(num - best);
  for (const candidate of sortedAllowed) {
    const delta = Math.abs(num - candidate);
    if (delta < bestDelta || (delta === bestDelta && candidate < best)) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return String(best);
}

/** 输入 "WxH" / "9:16" / "horizontal" 等 → 白名单 size。 */
function normalizeSize(input: unknown, fallback: string): string {
  const raw = readString(input);
  if (!raw) return fallback;
  if (SIZE_WHITELIST.has(raw)) return raw;
  // 比例 → size
  const match = raw.match(/^(\d{1,3})\s*[:x×]\s*(\d{1,3})$/u);
  if (match) {
    const w = Number(match[1]);
    const h = Number(match[2]);
    if (w > 0 && h > 0) {
      const ratio = w / h;
      if (Math.abs(ratio - 1) < 0.05) return '1024x1024';
      if (Math.abs(ratio - 16 / 9) < 0.05) return '1280x720';
      if (Math.abs(ratio - 9 / 16) < 0.05) return '720x1280';
      if (Math.abs(ratio - 1.75) < 0.1) return '1792x1024';
      if (Math.abs(ratio - 1 / 1.75) < 0.1) return '1024x1792';
    }
  }
  // "WxH" 但不在白名单：回退默认
  return fallback;
}

/** 输入 "720p" / "high" / "1080p" 等 → 白名单 resolution_name。 */
function normalizeResolution(input: unknown, fallback: string): string {
  const raw = readString(input)?.toLowerCase();
  if (!raw) return fallback;
  if (RESOLUTION_WHITELIST.has(raw)) return raw;
  if (['hd', 'high', '720', '720p', '1080p', '高清'].includes(raw)) return '720p';
  if (['low', 'sd', '480', '480p', '标清'].includes(raw)) return '480p';
  return fallback;
}

function normalizePreset(input: unknown, fallback: string): string {
  const raw = readString(input)?.toLowerCase();
  if (!raw) return fallback;
  return PRESET_WHITELIST.has(raw) ? raw : fallback;
}

export class ChenymeGrokVideoITVProvider implements ITVProvider {
  type = 'chenyme-grok2api-itv' as const;
  config: ITVConfig;

  // 与项目其它 ITV provider 一致：参考图统一要求远程 URL，
  // 主进程管线会把本地图片先上传到图床。
  assetTransports = {
    primaryImage: ['remote-url'] as const,
    additionalReferences: ['remote-url'] as const,
    referenceImages: ['remote-url'] as const,
  };

  constructor(config: ITVConfig) {
    this.config = config;
  }

  private getBaseUrl(): string {
    const value = String(this.config.baseUrl || '').trim();
    if (!value) throw new Error('Chenyme grok2api 渠道缺少 baseUrl');
    return value;
  }

  private getModelName(): string {
    const value = String(this.config.modelName || '').trim();
    if (!value) throw new Error('Chenyme grok2api 渠道未配置模型');
    return value;
  }

  /** multipart 请求**不能**手动设置 Content-Type，让浏览器/IPC 主进程自动加 boundary。 */
  private getMultipartHeaders(): Record<string, string> {
    return buildChannelAuthRequest({
      channelId: this.config.profileId,
      apiKey: this.config.apiKey,
      mode: 'bearer-header',
    }).headers;
  }

  private getAuthOnlyHeaders(): Record<string, string> {
    return buildChannelAuthRequest({
      channelId: this.config.profileId,
      apiKey: this.config.apiKey,
      mode: 'bearer-header',
    }).headers;
  }

  validate(): boolean {
    const hasCredential = Boolean(this.config.profileId) || Boolean(this.config.apiKey);
    return hasCredential
      && Boolean(String(this.config.baseUrl || '').trim())
      && Boolean(String(this.config.modelName || '').trim());
  }

  async testConnection(): Promise<boolean> {
    if (!this.validate()) return false;
    try {
      const response = await safeFetch(joinUrl(this.getBaseUrl(), '/v1/models'), {
        method: 'GET',
        headers: this.getAuthOnlyHeaders(),
      });
      return response.status !== 401 && response.status !== 403;
    } catch (err) {
      logger.warn('Chenyme grok2api testConnection 失败', {
        error: err instanceof Error ? err.message : err,
      });
      return false;
    }
  }

  async start(request: ITVRequest): Promise<ProviderStartResult<ITVResult>> {
    if (!this.validate()) throw new Error('Chenyme grok2api 凭据/模型/baseUrl 未配置完整');
    assertSupportedVideoCapabilities(request, 'Chenyme grok2api', [
      'video.text-to-video',
      'video.image-to-video',
      'video.reference-to-video',
    ]);

    const options = request.options as ITVOptions | undefined;
    const model = this.getModelName();

    const seconds = normalizeSeconds(
      options?.duration ?? this.config.defaultDuration,
      DEFAULT_SECONDS,
    );
    const size = normalizeSize(
      options?.aspectRatio ?? options?.resolution ?? this.config.defaultResolution,
      DEFAULT_SIZE,
    );
    const resolutionName = normalizeResolution(
      options?.resolution ?? this.config.defaultResolution,
      DEFAULT_RESOLUTION,
    );
    const preset = normalizePreset(
      (options as Record<string, unknown> | undefined)?.preset
        ?? (this.config as unknown as Record<string, unknown>).defaultPreset,
      DEFAULT_PRESET,
    );

    // 收集参考图 URL（去重 + 截 7 张）
    const seen = new Set<string>();
    const references: string[] = [];
    const pushRef = (value?: string) => {
      if (!value) return;
      if (seen.has(value)) return;
      if (references.length >= MAX_REFERENCE_IMAGES) return;
      seen.add(value);
      references.push(value);
    };
    if (isImageToVideoRequest(request)) {
      pushRef(request.primaryImage?.value);
      for (const ref of request.additionalReferences || []) pushRef(ref?.value);
    } else if (isReferenceToVideoRequest(request)) {
      for (const ref of request.referenceImages || []) pushRef(ref?.value);
    }
    if (request.capability !== 'video.text-to-video' && references.length === 0) {
      throw new Error('Chenyme grok2api 图生视频/参考视频需要至少一张参考图');
    }

    const formData = new FormData();
    formData.append('model', model);
    formData.append('prompt', String(request.prompt || '').trim());
    formData.append('seconds', seconds);
    formData.append('size', size);
    formData.append('resolution_name', resolutionName);
    formData.append('preset', preset);
    for (const url of references) {
      // chenyme/grok2api 接受 input_reference[] 同时支持 URL 文本与文件上传；
      // 与项目其它 provider 行为一致，传 URL。
      formData.append('input_reference[]', url);
    }

    logger.info('Chenyme grok2api 视频任务创建', {
      capability: request.capability,
      model,
      seconds,
      size,
      resolution_name: resolutionName,
      preset,
      referencesCount: references.length,
      body: sanitizeBodyForLog({
        model,
        prompt: String(request.prompt || '').trim(),
        seconds,
        size,
        resolution_name: resolutionName,
        preset,
      }),
    });

    const response = await safeFetch(joinUrl(this.getBaseUrl(), '/v1/videos'), {
      method: 'POST',
      headers: this.getMultipartHeaders(),
      body: formData,
    });
    const raw = await response.text();
    if (!response.ok) {
      logger.error('Chenyme grok2api 视频任务创建失败', {
        status: response.status,
        response: raw.slice(0, 1200),
      });
      throw new Error(`Chenyme grok2api 视频任务创建失败 (HTTP ${response.status}): ${raw.slice(0, 600)}`);
    }
    let data: VideoCreateResponse;
    try {
      data = JSON.parse(raw) as VideoCreateResponse;
    } catch {
      throw new Error('Chenyme grok2api 上游返回非 JSON 响应');
    }
    const taskId = data.id || data.task_id;
    if (!taskId) {
      throw new Error(data.error?.message || 'Chenyme grok2api 上游未返回 task_id');
    }
    return { mode: 'async', taskId };
  }

  async getTaskSnapshot(taskId: string): Promise<ProviderTaskSnapshot<ITVResult>> {
    const response = await safeFetch(
      joinUrl(this.getBaseUrl(), `/v1/videos/${encodeURIComponent(taskId)}`),
      { method: 'GET', headers: this.getAuthOnlyHeaders() },
    );
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return {
        state: 'failed',
        progress: 0,
        error: `查询视频任务失败 (${response.status}): ${errorText.slice(0, 600)}`,
      };
    }
    let data: VideoTaskResponse;
    try {
      data = (await response.json()) as VideoTaskResponse;
    } catch {
      return { state: 'failed', progress: 0, error: '查询返回非 JSON' };
    }

    const status = String(data.status || '').toLowerCase();
    let state: ProviderTaskSnapshot<ITVResult>['state'];
    if (['completed', 'succeeded', 'success', 'done'].includes(status)) state = 'succeeded';
    else if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) state = 'failed';
    else if (['queued', 'pending', 'created', 'submitted'].includes(status)) state = 'queued';
    else state = 'running';

    const progressRaw = data.progress;
    const progress = typeof progressRaw === 'number'
      ? Math.max(0, Math.min(100, Math.round(progressRaw)))
      : typeof progressRaw === 'string'
        ? Math.max(0, Math.min(100, Math.round(Number(progressRaw) || 0)))
        : (state === 'succeeded' ? 100 : 0);

    const resultUrl = data.metadata?.url
      || (Array.isArray(data.metadata?.result_urls) && data.metadata?.result_urls?.[0])
      || (Array.isArray(data.result_urls) && data.result_urls[0])
      || undefined;

    if (state === 'succeeded') {
      if (!resultUrl) {
        return { state: 'failed', progress: 100, error: '任务完成但未返回视频地址' };
      }
      return {
        state: 'succeeded',
        progress: 100,
        output: { source: resultUrl, taskId },
      };
    }
    if (state === 'failed') {
      return {
        state: 'failed',
        progress,
        error: data.fail_reason || data.error?.message || data.message || '任务失败',
      };
    }
    return { state, progress };
  }
}
