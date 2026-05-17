/**
 * Koma 官方 - 即梦（Koma 即梦上游）ITV Provider
 *
 * 协议对齐上游 OpenAI 视频 API 兼容网关：
 *   - 客户端发 **OpenAI 标准视频 API** JSON（prompt / model / seconds / size / images / metadata）
 *   - 网关把 OpenAI 标准字段转成Koma 即梦上游 multipart（first_frame、ratio、video_resolution 等）
 *   - 客户端**不需要**发 multipart / 不要构造Koma 即梦 raw 字段
 *
 * 上游路径（OpenAI 视频 API 标准，与 sora2 一致）：
 *   POST /v1/videos              创建任务
 *   GET  /v1/videos/{id}         查询任务（响应 OpenAIVideo：id / status / progress / metadata.url）
 *
 * 字段约定：
 *   - 时长字段使用 OpenAI 标准的 `seconds`（字符串），new-api 内部会换算为Koma 即梦 duration（int）。
 *   - 结果 URL 从响应的 metadata.url / metadata.result_urls[0] 读取（OpenAIVideo 把上游的
 *     result_urls 透传到了 metadata，不在顶层）。
 *
 * 模型：
 *   - seedance-2.0       duration 4-15 s
 *   - seedance-2.0-fast  duration 4-15 s
 *
 * 当前阶段Koma 即梦上游强制锁 480p，所以 size 始终送 480p 档位（按 aspectRatio 选 854x480 / 480x854）。
 *
 * 注意：本 provider 使用即梦专用 multipart 协议，独立类型避免与 grok2api 混用字段格式；
 *       baseUrl 由用户在渠道配置中提供。
 */

import type {
  ITVConfig,
  ITVOptions,
  ProviderStartResult,
  ProviderTaskSnapshot,
} from '../../types';
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

// 与 Grok2API 对齐的最大参考图数量；Koma 即梦上游对全能引用模式无明确硬上限，
// 这里取 7 张（Grok 限制）作为安全档位，避免 prompt 编译阶段引用过多被截断不一致。
const SUIHE_MAX_REFERENCE_IMAGES = 7;

const logger = createLogger('SuiheITVProvider');

interface SuiheCreateResponse {
  // OpenAI 视频 API 风格响应（new-api 透传上游 task_id 到此字段）
  id?: string;
  task_id?: string;
  status?: string;
  model?: string;
  created_at?: number | string;
  error?: { code?: string; message?: string };
}

interface SuiheTaskResponse extends SuiheCreateResponse {
  // OpenAIVideo（new-api 标准视频任务响应）
  progress?: number | string;
  metadata?: {
    url?: string;
    result_urls?: string[];
    [k: string]: unknown;
  };
  // 兼容字段：网关或上游变体可能直接挂在顶层
  result_urls?: string[];
  fail_reason?: string;
  progress_pct?: number | string;
  progress_text?: string;
  task_type?: string;
  // 兼容 sora 风格
  result?: { type?: string; data?: Array<{ url?: string }> };
}

const MODEL_DURATION_MAX: Record<string, number> = {
  'seedance-2.0': 15,
  'seedance-2.0-fast': 15,
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

// Koma 即梦上游接受的比例白名单（来自 400 错误响应 supported 字段）
const SUIHE_SUPPORTED_RATIOS = new Set([
  '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9',
]);

function normalizeSuiheRatio(aspectRatio?: string): string {
  const normalized = String(aspectRatio || '').trim();
  if (SUIHE_SUPPORTED_RATIOS.has(normalized)) return normalized;
  if (normalized === 'portrait') return '9:16';
  if (normalized === 'landscape') return '16:9';
  if (normalized === 'square') return '1:1';
  // 默认横屏，避免送出 240:427 等非白名单比例
  return '16:9';
}

/**
 * 选 size：必须 gcd 后落到 SUIHE_SUPPORTED_RATIOS 白名单内的尺寸。
 *
 * 关键：上游网关会用 gcd 简化 size 推 ratio，比如 480x854 → gcd(480,854)=2 → "240:427"
 * 不在Koma 即梦白名单里 → 上游 400。所以必须送标准 OpenAI Sora 尺寸（720x1280 / 1280x720 / 1024x1024）
 * 这些 gcd 化后正好命中标准比例。
 *
 * video_resolution 由网关侧强制锁 480p，客户端送的 size 仅用于推 ratio，
 * 实际渲染分辨率与 size 像素值无关。
 */
function pickSize(ratio: string): string {
  if (ratio === '9:16') return '720x1280';
  if (ratio === '1:1') return '1024x1024';
  if (ratio === '4:3') return '1024x768';
  if (ratio === '3:4') return '768x1024';
  if (ratio === '3:2') return '1080x720';
  if (ratio === '2:3') return '720x1080';
  if (ratio === '21:9') return '2520x1080';
  // 16:9
  return '1280x720';
}

function clampDuration(model: string, raw: unknown, fallback: number): number {
  const max = MODEL_DURATION_MAX[model] ?? 15;
  const n = typeof raw === 'number' ? raw : Number(raw);
  const v = Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.min(Math.max(v, 4), max);
}

export class SuiheITVProvider implements ITVProvider {
  type = 'koma-suihe-itv' as const;
  config: ITVConfig;

  // 网关接受 OpenAI images:[url]，所以远程 URL 与 data-url 都可由网关下载后转发；
  // 但为减少网关压力，前端优先 remote-url。
  assetTransports = {
    primaryImage: ['remote-url', 'data-url'] as const,
    additionalReferences: ['remote-url'] as const,
    referenceImages: ['remote-url'] as const,
    startFrame: ['remote-url', 'data-url'] as const,
    endFrame: ['remote-url', 'data-url'] as const,
  };

  constructor(config: ITVConfig) {
    // 默认走 Koma 即梦协议：prompt 编译占位符为 @image_file_N / @video_file_N / @audio_file_N，
    // 网关按 metadata.image_urls / video_urls / audio_urls 分发到上游 multipart 各类字段。
    // 老配置如显式设了 grok-image-index 仍然兼容（图片走 @Image N 路径，视频 / 音频不上传）。
    this.config = { ...config, promptProtocol: config.promptProtocol ?? 'koma-jimeng' };
  }

  private getBaseUrl(): string {
    const url = String(this.config.baseUrl || '').trim();
    if (!url) {
      throw new Error('SuiheITVProvider 缺少 baseUrl，请在渠道配置中填写');
    }
    return url;
  }

  private getHeaders(): Record<string, string> {
    return buildChannelAuthRequest({
      channelId: this.config.profileId,
      apiKey: this.config.apiKey,
      mode: 'bearer-header',
      headers: { 'Content-Type': 'application/json' },
    }).headers;
  }

  private getAuthOnlyHeaders(): Record<string, string> {
    return buildChannelAuthRequest({
      channelId: this.config.profileId,
      apiKey: this.config.apiKey,
      mode: 'bearer-header',
    }).headers;
  }

  private getModelName(): string {
    const value = String(this.config.modelName || '').trim();
    if (!value) throw new Error('模型名称未配置');
    return value;
  }

  validate(): boolean {
    const hasCredential = Boolean(this.config.profileId) || Boolean(this.config.apiKey);
    return hasCredential && Boolean(String(this.config.modelName || '').trim());
  }

  async testConnection(): Promise<boolean> {
    if (!this.validate()) return false;
    try {
      // 仅探测鉴权是否通畅，不真正下任务（避免 testConnection 触发计费）。
      const response = await safeFetch(joinUrl(this.getBaseUrl(), '/v1/models'), {
        method: 'GET',
        headers: this.getAuthOnlyHeaders(),
      });
      return response.status !== 401 && response.status !== 403;
    } catch (err) {
      logger.warn('Suihe testConnection failed', { error: err instanceof Error ? err.message : err });
      return false;
    }
  }

  async start(request: ITVRequest): Promise<ProviderStartResult<ITVResult>> {
    if (!this.validate()) throw new Error('Koma 即梦 API Key 或模型未配置');
    assertSupportedVideoCapabilities(request, 'Koma 即梦', [
      'video.text-to-video',
      'video.image-to-video',
      'video.start-end-to-video',
      'video.reference-to-video',
    ]);

    const options = request.options as ITVOptions | undefined;
    const model = this.getModelName();
    const duration = clampDuration(model, options?.duration ?? this.config.defaultDuration, 5);
    // 必须先归一到 Koma 即梦白名单比例，再用它选 size —— 避免 size→ratio 落到 240:427 等非白名单值
    const ratio = normalizeSuiheRatio(options?.aspectRatio);
    const size = pickSize(ratio);

    // OpenAI 视频 API 标准用 `seconds`（字符串）；new-api 内部会回填到 duration。
    const body: Record<string, unknown> = {
      model,
      prompt: String(request.prompt || '').trim(),
      seconds: String(duration),
      size,
    };

    // 读 koma-jimeng 协议编译器拆好的按 kind 的 URL 列表（仅 koma-jimeng 协议下有值），
    // 优先走分类透传：网关分发到 image_file_N / video_file_N / audio_file_N。
    const komaAssets = (request.metadata?.komaJimengAssets ?? null) as
      | { image_urls?: string[]; video_urls?: string[]; audio_urls?: string[] }
      | null;
    const hasKomaClassified = Boolean(
      komaAssets
      && ((komaAssets.image_urls?.length ?? 0)
        + (komaAssets.video_urls?.length ?? 0)
        + (komaAssets.audio_urls?.length ?? 0) > 0),
    );

    // 老路径（grok-image-index 协议或仅图场景）：所有引用图汇总到 images[]，
    // function_mode 告诉网关走哪条 multipart 字段路径（first_frame / omni_reference /
    // first_last_frames）。
    const seenUrls = new Set<string>();
    const imageUrls: string[] = [];
    const pushUrl = (value?: string) => {
      if (!value || seenUrls.has(value)) return;
      if (imageUrls.length >= SUIHE_MAX_REFERENCE_IMAGES) return;
      seenUrls.add(value);
      imageUrls.push(value);
    };

    let functionMode: string | undefined;
    if (request.capability === 'video.image-to-video') {
      pushUrl(request.primaryImage?.value);
      for (const ref of request.additionalReferences || []) pushUrl(ref?.value);
      functionMode = 'first_frame';
    } else if (request.capability === 'video.reference-to-video') {
      for (const ref of request.referenceImages || []) pushUrl(ref?.value);
      if (imageUrls.length > 0 || hasKomaClassified) functionMode = 'omni_reference';
    } else if (request.capability === 'video.start-end-to-video') {
      pushUrl(request.startFrame?.value);
      functionMode = 'first_last_frames';
    }

    // 关键：koma-jimeng 协议下 prompt 占位符固定为 @image_file_N / @video_file_N / @audio_file_N，
    // 网关字段命名只有 function_mode='omni_reference' 时才匹配（image_file_N 等）。其它模式
    // （first_frame / first_last_frames）会把图上传成 first_frame / frame_N，与 prompt 不匹配
    // → 上游模型找不到占位符对应文件 → 失败。所以这里强制 omni_reference 覆盖 capability
    // 默认值，保证 prompt 与字段名一致。
    if (hasKomaClassified) {
      functionMode = 'omni_reference';
    }

    // metadata.ratio 在网关侧优先级高于 size 推断 —— 作为防御性兜底。
    // function_mode、end_frame_url 等扩展字段全部走 metadata 透传。
    const metadata: Record<string, unknown> = { ratio };
    if (functionMode) metadata.function_mode = functionMode;
    if (request.capability === 'video.start-end-to-video' && request.endFrame?.value) {
      metadata.end_frame_url = request.endFrame.value;
    }

    if (hasKomaClassified) {
      // Koma 即梦分类协议：URL 按 kind 拆 metadata，避免和 images[] 双写。
      if (komaAssets?.image_urls?.length) metadata.image_urls = komaAssets.image_urls;
      if (komaAssets?.video_urls?.length) metadata.video_urls = komaAssets.video_urls;
      if (komaAssets?.audio_urls?.length) metadata.audio_urls = komaAssets.audio_urls;
    } else if (imageUrls.length > 0) {
      body.images = imageUrls;
    }
    body.metadata = metadata;

    logger.info('Koma 即梦 start request', {
      provider: this.config.provider,
      capability: request.capability,
      model,
      body: sanitizeBodyForLog(body),
    });

    // OpenAI 标准创建任务路径：POST /v1/videos（非 /v1/videos/generations）
    const response = await safeFetch(joinUrl(this.getBaseUrl(), '/v1/videos'), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok) {
      logger.error('Suihe start failed', { status: response.status, response: raw.slice(0, 1200) });
      throw new Error(`即梦视频任务创建失败 (HTTP ${response.status}): ${raw.slice(0, 600)}`);
    }
    let data: SuiheCreateResponse;
    try {
      data = JSON.parse(raw) as SuiheCreateResponse;
    } catch {
      throw new Error('即梦上游返回非 JSON 响应');
    }
    const taskId = data.id || data.task_id;
    if (!taskId) {
      throw new Error(data.error?.message || '即梦上游未返回 task_id');
    }
    return { mode: 'async', taskId };
  }

  async getTaskSnapshot(taskId: string): Promise<ProviderTaskSnapshot<ITVResult>> {
    // OpenAI 标准 fetch 路径：GET /v1/videos/{id}（不是 /v1/videos/generations/{id}）
    const response = await safeFetch(
      joinUrl(this.getBaseUrl(), `/v1/videos/${encodeURIComponent(taskId)}`),
      { method: 'GET', headers: this.getAuthOnlyHeaders() },
    );
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return { state: 'failed', progress: 0, error: errorText || `查询失败 HTTP ${response.status}` };
    }
    let data: SuiheTaskResponse;
    try {
      data = (await response.json()) as SuiheTaskResponse;
    } catch {
      return { state: 'failed', progress: 0, error: '查询返回非 JSON' };
    }

    // 状态映射：兼容 OpenAI 标准（queued/in_progress/completed/failed）+ Koma 即梦枚举（pending/submitted/generating/post_processing/success/failed）
    const status = String(data.status || '').toLowerCase();
    let state: ProviderTaskSnapshot<ITVResult>['state'];
    if (status === 'success' || status === 'completed' || status === 'succeeded') state = 'succeeded';
    else if (status === 'failed' || status === 'error') state = 'failed';
    else if (status === 'pending' || status === 'submitted' || status === 'queued') state = 'queued';
    else state = 'running';

    // 进度：OpenAIVideo 顶层 progress 是 number；Koma 即梦原生还可能给 progress_pct/progress_text
    const pctRaw = data.progress_pct ?? data.progress;
    const progress = typeof pctRaw === 'number'
      ? Math.max(0, Math.min(100, Math.round(pctRaw)))
      : typeof pctRaw === 'string'
        ? Math.max(0, Math.min(100, Math.round(Number(pctRaw) || 0)))
        : (state === 'succeeded' ? 100 : 0);

    // OpenAIVideo 把上游的 result_urls 透传到 metadata；同时兼容顶层 result_urls 与 sora result.data[0].url
    const resultUrl = data.metadata?.url
      || (Array.isArray(data.metadata?.result_urls) && data.metadata?.result_urls?.[0])
      || (Array.isArray(data.result_urls) && data.result_urls[0])
      || data.result?.data?.[0]?.url;

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
      return { state: 'failed', progress, error: data.fail_reason || data.error?.message || '任务失败' };
    }
    return { state, progress };
  }
}
