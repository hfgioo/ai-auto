/**
 * ChannelConfigService — 渠道配置业务编排
 * 负责 CRUD + safeStorage 加解密 + 序列化
 *
 * 对外 DTO 字段与前端 ChannelConfig 一一对齐：
 *   providerType / providerConfig / source / pluginId / defaultModelId ...
 * apiKey 不回传明文（仅 hasApiKey: boolean）；执行侧通过 getDecryptedApiKey() 内部解密。
 */
import { safeStorage } from 'electron';
import { v4 as uuid } from 'uuid';
import { settingsDB } from '../storage/SettingsDB';
import { SqliteChannelConfigRepository } from '../storage/repositories/SqliteChannelConfigRepository';
import { SqliteMediaDefaultsRepository } from '../storage/repositories/SqliteMediaDefaultsRepository';
import type {
  ChannelConfigRow,
  ChannelSource,
  MediaCategory,
  MediaDefaultRow,
} from '../storage/repositories/settingsInterfaces';

/* ---------- 公开 DTO ---------- */

export interface ChannelConfigDTO {
  id: string;
  category: MediaCategory;
  providerType: string;
  name: string;
  description: string | null;
  baseUrl: string | null;
  hasApiKey: boolean;
  providerConfig: Record<string, unknown>;   // 不含 apiKey；仅回传 hasApiKey
  models: unknown[];
  capabilities: string[];
  polling: unknown | null;
  extras: Record<string, unknown>;
  defaultModelId: string | null;
  source: ChannelSource;
  pluginId: string | null;
  enabled: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelConfigInput {
  id?: string;                                // 允许调用方指定（例如迁移/激活固定 id）
  category: MediaCategory;
  providerType: string;
  name: string;
  description?: string | null;
  baseUrl?: string | null;
  providerConfig?: Record<string, unknown>;   // 可包含 apiKey（明文），服务内部会剥离
  models?: unknown[];
  capabilities?: string[];
  polling?: unknown | null;
  extras?: Record<string, unknown>;
  defaultModelId?: string | null;
  source?: ChannelSource;
  pluginId?: string | null;
  enabled?: boolean;
  isDefault?: boolean;
  sortOrder?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface MediaDefaultDTO {
  category: MediaCategory;
  channelId: string;
  modelId: string | null;
  payload: Record<string, unknown>;
  updatedAt: number;
}

/* ---------- Service ---------- */

const configRepo = new SqliteChannelConfigRepository();
const defaultsRepo = new SqliteMediaDefaultsRepository();

function encryptApiKey(plain: string): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available — cannot store API key securely');
  }
  return safeStorage.encryptString(plain);
}

function decryptApiKey(cipher: Buffer): string {
  return safeStorage.decryptString(cipher);
}

/**
 * 从 providerConfig 中剥离 apiKey（敏感），其余序列化成 JSON。
 */
function extractApiKey(providerConfig?: Record<string, unknown>): {
  apiKey: string | null;
  rest: Record<string, unknown>;
} {
  if (!providerConfig) return { apiKey: null, rest: {} };
  const { apiKey, ...rest } = providerConfig as Record<string, unknown> & { apiKey?: unknown };
  const apiKeyStr =
    typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : null;
  return { apiKey: apiKeyStr, rest };
}

function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function rowToDTO(row: ChannelConfigRow): ChannelConfigDTO {
  return {
    id: row.id,
    category: row.category,
    providerType: row.channel_def_id,
    name: row.name,
    description: row.description,
    baseUrl: row.base_url,
    hasApiKey: row.api_key_cipher != null && row.api_key_cipher.length > 0,
    providerConfig: safeJsonParse<Record<string, unknown>>(row.provider_config_json, {}),
    models: safeJsonParse<unknown[]>(row.models_json, []),
    capabilities: safeJsonParse<string[]>(row.capabilities_json, []),
    polling: row.polling_json ? safeJsonParse<unknown>(row.polling_json, null) : null,
    extras: safeJsonParse<Record<string, unknown>>(row.extras_json, {}),
    defaultModelId: row.default_model_id,
    source: row.source,
    pluginId: row.plugin_id,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildRow(input: ChannelConfigInput, existing?: ChannelConfigRow | null): ChannelConfigRow {
  const now = Date.now();
  const { apiKey, rest } = extractApiKey(input.providerConfig);

  const apiKeyCipher: Buffer | null = (() => {
    if (apiKey != null) return encryptApiKey(apiKey);
    if (existing) return existing.api_key_cipher;
    return null;
  })();

  return {
    id: input.id ?? existing?.id ?? uuid(),
    category: input.category ?? existing?.category ?? 'llm',
    channel_def_id: input.providerType ?? existing?.channel_def_id ?? 'custom',
    name: input.name ?? existing?.name ?? '',
    description: input.description ?? existing?.description ?? null,
    base_url: input.baseUrl ?? existing?.base_url ?? null,
    api_key_cipher: apiKeyCipher,
    // 仅当 input.providerConfig 显式提供时才重写；undefined 时保留 existing，避免 update 清空
    provider_config_json: input.providerConfig !== undefined
      ? JSON.stringify(rest)
      : (existing?.provider_config_json ?? '{}'),
    models_json: input.models !== undefined
      ? JSON.stringify(input.models)
      : (existing?.models_json ?? '[]'),
    capabilities_json: input.capabilities !== undefined
      ? JSON.stringify(input.capabilities)
      : (existing?.capabilities_json ?? '[]'),
    polling_json: input.polling !== undefined
      ? (input.polling === null ? null : JSON.stringify(input.polling))
      : (existing?.polling_json ?? null),
    extras_json: input.extras !== undefined
      ? JSON.stringify(input.extras)
      : (existing?.extras_json ?? '{}'),
    default_model_id: input.defaultModelId ?? existing?.default_model_id ?? null,
    source: input.source ?? existing?.source ?? 'builtin',
    plugin_id: input.pluginId ?? existing?.plugin_id ?? null,
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing?.enabled ?? 1),
    is_default: input.isDefault !== undefined ? (input.isDefault ? 1 : 0) : (existing?.is_default ?? 0),
    sort_order: input.sortOrder ?? existing?.sort_order ?? 0,
    created_at: input.createdAt ?? existing?.created_at ?? now,
    updated_at: input.updatedAt ?? now,
  };
}

/* --- CRUD --- */

export function listChannelConfigs(category?: MediaCategory): ChannelConfigDTO[] {
  return configRepo.list(category).map(rowToDTO);
}

export function getChannelConfig(id: string): ChannelConfigDTO | null {
  const row = configRepo.getById(id);
  return row ? rowToDTO(row) : null;
}

export function createChannelConfig(input: ChannelConfigInput): ChannelConfigDTO {
  const row = buildRow(input, null);
  configRepo.insert(row);
  return rowToDTO(row);
}

export function updateChannelConfig(
  id: string,
  patch: Partial<ChannelConfigInput>,
): ChannelConfigDTO {
  const existing = configRepo.getById(id);
  if (!existing) {
    throw new Error(`channel_configs not found: ${id}`);
  }
  const merged = buildRow({ ...patch, id } as ChannelConfigInput, existing);
  configRepo.update(id, merged);
  return rowToDTO(configRepo.getById(id)!);
}

export function deleteChannelConfig(id: string): boolean {
  return settingsDB.transaction(() => {
    const existing = configRepo.getById(id);
    if (!existing) return false;
    // 级联清理所有引用该 channel 的 media_defaults（跨 category）
    defaultsRepo.deleteByChannelId(id);
    const removed = configRepo.delete(id);
    if (!removed) {
      throw new Error(`channel_configs delete failed: ${id}`);
    }
    return true;
  });
}

export function bulkImportChannelConfigs(
  inputs: ChannelConfigInput[],
): { imported: number } {
  return settingsDB.transaction(() => {
    let imported = 0;
    for (const input of inputs) {
      const existing = input.id ? configRepo.getById(input.id) : null;
      const row = buildRow(input, existing);
      if (existing) {
        configRepo.update(row.id, row);
      } else {
        configRepo.insert(row);
      }
      imported += 1;
    }
    return { imported };
  });
}

export function countChannelConfigs(): number {
  return configRepo.count();
}

/* --- Media Defaults --- */

export function listMediaDefaults(): MediaDefaultDTO[] {
  return defaultsRepo.list().map((row) => ({
    category: row.category,
    channelId: row.channel_id,
    modelId: row.model_id,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
    updatedAt: row.updated_at,
  }));
}

export function getMediaDefault(category: MediaCategory): MediaDefaultDTO | null {
  const row = defaultsRepo.get(category);
  if (!row) return null;
  return {
    category: row.category,
    channelId: row.channel_id,
    modelId: row.model_id,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
    updatedAt: row.updated_at,
  };
}

export function setMediaDefault(
  category: MediaCategory,
  channelId: string,
  modelId?: string | null,
  payload?: Record<string, unknown>,
): MediaDefaultDTO {
  return settingsDB.transaction(() => {
    const channel = configRepo.getById(channelId);
    if (!channel) {
      throw new Error(`channel_configs not found: ${channelId}`);
    }
    if (channel.category !== category) {
      throw new Error(
        `channel ${channelId} category mismatch: expected ${category}, got ${channel.category}`,
      );
    }
    const models = safeJsonParse<Array<{ id?: string }>>(channel.models_json, []);
    const requiresModel = category !== 'image-hosting';
    const effectiveModelId =
      (modelId ?? null)
      || channel.default_model_id
      || models[0]?.id
      || null;
    if (requiresModel && !effectiveModelId) {
      throw new Error(`media default requires modelId for category ${category}`);
    }
    if (effectiveModelId && !models.some((m) => m?.id === effectiveModelId)) {
      throw new Error(`model ${effectiveModelId} not found under channel ${channelId}`);
    }

    const row: MediaDefaultRow = {
      category,
      channel_id: channelId,
      model_id: effectiveModelId,
      payload_json: JSON.stringify(payload ?? {}),
      updated_at: Date.now(),
    };
    defaultsRepo.set(row);
    return {
      category: row.category,
      channelId: row.channel_id,
      modelId: row.model_id,
      payload: payload ?? {},
      updatedAt: row.updated_at,
    };
  });
}

export function deleteMediaDefault(category: MediaCategory): boolean {
  return defaultsRepo.delete(category);
}

/* --- 内部：主进程直接读取解密后的 apiKey（不经 IPC） --- */

export function getDecryptedApiKey(channelConfigId: string): string | null {
  const row = configRepo.getById(channelConfigId);
  if (!row?.api_key_cipher) return null;
  return decryptApiKey(row.api_key_cipher);
}
