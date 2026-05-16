/**
 * 渠道配置前端服务 —— 薄封装 channel:* IPC
 * 所有 CRUD 走主进程 SQLite；API Key 在主进程 safeStorage 加密后落库。
 */
import { electronService } from './electronService';
import type {
  ChannelConfig,
  MediaCategory,
  MediaModelSelection,
  MediaDefaults,
  ChannelModelDefinition,
  PollingConfig,
  ChannelCapability,
} from '../providers/channel/types';

interface IpcOk<T> {
  ok: true;
  data: T;
}
interface IpcFail {
  ok: false;
  code: string;
  message: string;
}
type IpcResult<T> = IpcOk<T> | IpcFail;

/**
 * 主进程返回的渠道 DTO —— 与 electron/service/settings/ChannelConfigService.ts 的 ChannelConfigDTO 对齐
 */
interface ChannelConfigDTO {
  id: string;
  category: MediaCategory;
  providerType: string;
  name: string;
  description: string | null;
  baseUrl: string | null;
  hasApiKey: boolean;
  providerConfig: Record<string, unknown>;
  models: ChannelModelDefinition[];
  capabilities: ChannelCapability[];
  polling: PollingConfig | null;
  extras: Record<string, unknown>;
  defaultModelId: string | null;
  source: 'builtin' | 'plugin';
  pluginId: string | null;
  enabled: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

interface MediaDefaultDTO {
  category: MediaCategory;
  channelId: string;
  modelId: string | null;
  payload: Record<string, unknown>;
  updatedAt: number;
}

export interface ChannelConfigServerInput {
  id?: string;
  category: MediaCategory;
  providerType: string;
  name: string;
  description?: string | null;
  baseUrl?: string | null;
  providerConfig?: Record<string, unknown>;   // 可含明文 apiKey，主进程自动加密
  models?: ChannelModelDefinition[];
  capabilities?: ChannelCapability[];
  polling?: PollingConfig | null;
  extras?: Record<string, unknown>;
  defaultModelId?: string | null;
  source?: 'builtin' | 'plugin';
  pluginId?: string | null;
  enabled?: boolean;
  isDefault?: boolean;
  sortOrder?: number;
  createdAt?: number;
  updatedAt?: number;
}

/* ---------- 内部工具 ---------- */

function isElectron(): boolean {
  return electronService.isElectron();
}

async function invoke<T>(channel: string, args?: unknown): Promise<T> {
  if (!isElectron()) {
    throw new Error(`channelConfigService: IPC '${channel}' requires Electron runtime`);
  }
  const res = (await electronService.ipc.invoke(channel, args)) as IpcResult<T>;
  if (!res || typeof res !== 'object' || !('ok' in res)) {
    throw new Error(`channelConfigService: unexpected IPC response from '${channel}'`);
  }
  if (res.ok === false) {
    throw new Error(`${channel} failed: [${res.code}] ${res.message}`);
  }
  return res.data;
}

/**
 * 将后端 DTO 转为前端 ChannelConfig 结构。
 *
 * Secret Intent 约定（Round3）：
 * - apiKey 不再以 '$ENC$' 占位符形式回传；前端 form 里 apiKey 字段仅承载"新输入值"。
 * - 已存储的凭据通过 `providerConfig.hasApiKey: true` 提示 UI 显示"已加密存储" placeholder。
 * - 保存时：apiKey 为空字符串 → 不更新；有值 → 作为新 key 覆盖。
 */
function dtoToFrontend(dto: ChannelConfigDTO): ChannelConfig {
  return {
    id: dto.id,
    name: dto.name,
    description: dto.description ?? undefined,
    category: dto.category,
    providerType: dto.providerType,
    providerConfig: {
      ...dto.providerConfig,
      ...(dto.hasApiKey ? { hasApiKey: true } : {}),
      ...(dto.baseUrl ? { baseUrl: dto.baseUrl } : {}),
    },
    defaultModelId: dto.defaultModelId ?? undefined,
    models: dto.models ?? [],
    capabilities: dto.capabilities?.length ? dto.capabilities : undefined,
    polling: dto.polling ?? undefined,
    enabled: dto.enabled,
    isDefault: dto.isDefault || undefined,
    source: dto.source,
    pluginId: dto.pluginId ?? undefined,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

/**
 * 将前端 ChannelConfig 拆解成后端 Input：
 *   baseUrl 从 providerConfig.baseUrl 拆出
 *   apiKey 空串 / '$ENC$' 视作"不更新 apiKey"（防御历史残余）
 *   `hasApiKey` UI flag 剥离，不应落库
 */
function frontendToInput(
  cfg: Omit<ChannelConfig, 'id' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: number; updatedAt?: number },
): ChannelConfigServerInput {
  const providerConfig: Record<string, unknown> = { ...(cfg.providerConfig ?? {}) };
  const baseUrlRaw = providerConfig.baseUrl;
  const baseUrl = typeof baseUrlRaw === 'string' ? baseUrlRaw : null;
  delete providerConfig.baseUrl;
  delete providerConfig.hasApiKey;

  // Secret Intent：空 / 占位符 / 非 string → 不更新 apiKey（后端保留密文）
  const keyRaw = providerConfig.apiKey;
  if (
    typeof keyRaw !== 'string'
    || keyRaw.length === 0
    || keyRaw === '$ENC$'
  ) {
    delete providerConfig.apiKey;
  }

  return {
    id: cfg.id,
    category: cfg.category,
    providerType: cfg.providerType,
    name: cfg.name,
    description: cfg.description ?? null,
    baseUrl,
    providerConfig,
    models: cfg.models ?? [],
    capabilities: cfg.capabilities ?? [],
    polling: cfg.polling ?? null,
    extras: {},
    defaultModelId: cfg.defaultModelId ?? null,
    source: cfg.source ?? 'builtin',
    pluginId: cfg.pluginId ?? null,
    enabled: cfg.enabled,
    isDefault: cfg.isDefault ?? false,
    sortOrder: 0,
    createdAt: cfg.createdAt,
    updatedAt: cfg.updatedAt,
  };
}

/* ---------- 对外 API ---------- */

export async function listChannels(category?: MediaCategory): Promise<ChannelConfig[]> {
  const dtos = await invoke<ChannelConfigDTO[]>('channel:list', category ? { category } : undefined);
  return dtos.map(dtoToFrontend);
}

export async function getChannel(id: string): Promise<ChannelConfig | null> {
  const dto = await invoke<ChannelConfigDTO | null>('channel:get', { id });
  return dto ? dtoToFrontend(dto) : null;
}

export async function countChannels(): Promise<number> {
  return invoke<number>('channel:count');
}

export async function createChannel(
  cfg: Omit<ChannelConfig, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
): Promise<ChannelConfig> {
  const input = frontendToInput(cfg);
  const dto = await invoke<ChannelConfigDTO>('channel:create', input);
  return dtoToFrontend(dto);
}

export async function updateChannel(
  id: string,
  patch: Partial<Omit<ChannelConfig, 'id' | 'createdAt'>>,
): Promise<ChannelConfig> {
  // 将 patch 包装为 Input（仅带入变更字段）
  const base: ChannelConfig = {
    id,
    name: patch.name ?? '',
    category: (patch.category ?? 'llm') as MediaCategory,
    providerType: patch.providerType ?? 'custom',
    providerConfig: patch.providerConfig ?? {},
    models: patch.models ?? [],
    enabled: patch.enabled ?? true,
    source: patch.source ?? 'builtin',
    description: patch.description,
    defaultModelId: patch.defaultModelId,
    capabilities: patch.capabilities,
    polling: patch.polling,
    isDefault: patch.isDefault,
    pluginId: patch.pluginId,
    createdAt: 0,
    updatedAt: 0,
  };
  const input = frontendToInput(base);
  // 清洗：patch 未提供的字段不覆盖
  const cleanedPatch: Partial<ChannelConfigServerInput> = {};
  if (patch.category !== undefined) cleanedPatch.category = patch.category;
  if (patch.providerType !== undefined) cleanedPatch.providerType = patch.providerType;
  if (patch.name !== undefined) cleanedPatch.name = patch.name;
  if (patch.description !== undefined) cleanedPatch.description = patch.description ?? null;
  if (patch.providerConfig !== undefined) {
    cleanedPatch.providerConfig = input.providerConfig;
    cleanedPatch.baseUrl = input.baseUrl;
  }
  if (patch.models !== undefined) cleanedPatch.models = patch.models;
  if (patch.capabilities !== undefined) cleanedPatch.capabilities = patch.capabilities;
  if (patch.polling !== undefined) cleanedPatch.polling = patch.polling ?? null;
  if (patch.defaultModelId !== undefined) cleanedPatch.defaultModelId = patch.defaultModelId ?? null;
  if (patch.source !== undefined) cleanedPatch.source = patch.source;
  if (patch.pluginId !== undefined) cleanedPatch.pluginId = patch.pluginId ?? null;
  if (patch.enabled !== undefined) cleanedPatch.enabled = patch.enabled;
  if (patch.isDefault !== undefined) cleanedPatch.isDefault = patch.isDefault ?? false;

  const dto = await invoke<ChannelConfigDTO>('channel:update', { id, patch: cleanedPatch });
  return dtoToFrontend(dto);
}

export async function deleteChannel(id: string): Promise<boolean> {
  return invoke<boolean>('channel:delete', { id });
}

export async function bulkImportChannels(
  configs: ChannelConfigServerInput[],
): Promise<{ imported: number }> {
  return invoke<{ imported: number }>('channel:bulkImport', { configs });
}

/* --- Media Defaults --- */

export async function getMediaDefault(category: MediaCategory): Promise<MediaModelSelection | null> {
  const dto = await invoke<MediaDefaultDTO | null>('channel:getDefault', { category });
  if (!dto) return null;
  return {
    channelId: dto.channelId,
    modelId: dto.modelId ?? '',
  };
}

export async function listMediaDefaults(): Promise<MediaDefaults> {
  const dtos = await invoke<MediaDefaultDTO[]>('channel:listDefaults');
  const result: MediaDefaults = {};
  for (const d of dtos) {
    result[d.category] = { channelId: d.channelId, modelId: d.modelId ?? '' };
  }
  return result;
}

export async function setMediaDefault(
  category: MediaCategory,
  selection: MediaModelSelection,
): Promise<MediaDefaultDTO> {
  return invoke<MediaDefaultDTO>('channel:setDefault', {
    category,
    channelId: selection.channelId,
    modelId: selection.modelId ?? null,
  });
}

export async function deleteMediaDefault(category: MediaCategory): Promise<boolean> {
  return invoke<boolean>('channel:deleteDefault', { category });
}
