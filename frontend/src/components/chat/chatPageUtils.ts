import type { SessionConfig } from '../../chat/ipc';
import type { AppSettings, LLMModelConfig } from '../../types';
import type { MediaModelSelection } from '../../providers/channel/types';
import {
  getDefaultMediaSelection,
} from '../../providers/channel/resolver';

export const CHAT_AUTH_ERROR_MESSAGE = '模型鉴权失败，请检查当前 LLM 渠道配置';
const UNKNOWN_CHAT_ERROR_MESSAGE = '发生未知错误';
const REDACTED_API_KEY = '[REDACTED_API_KEY]';

type LLMConfigForSession = Pick<
  LLMModelConfig,
  'profileId' | 'provider' | 'modelName' | 'apiKey' | 'baseUrl'
>;

export function resolveInitialChatLLMSelection(
  settings: AppSettings,
): MediaModelSelection | undefined {
  return getDefaultMediaSelection(settings, 'llm', 'llm.chat');
}

export function buildChatSessionConfig(
  selectedConfig?: LLMConfigForSession | null,
): SessionConfig {
  if (!selectedConfig) {
    return {};
  }

  return {
    llmProfileId: selectedConfig.profileId,
    modelProvider: selectedConfig.provider,
    modelName: selectedConfig.modelName,
    // 显式携带 undefined，避免会话浅合并时残留上一个渠道的 key/baseUrl。
    apiKey: selectedConfig.apiKey || undefined,
    baseUrl: selectedConfig.baseUrl || undefined,
  };
}

function errorToSearchableText(error: unknown): string {
  if (error instanceof Error) {
    const extra = error as Error & {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
    };
    const parts = [
      error.name,
      extra.code,
      extra.status,
      extra.statusCode,
      error.message,
      extra.cause instanceof Error ? extra.cause.message : extra.cause,
    ];
    return parts.filter((part) => part !== undefined && part !== null && String(part).trim()).join(' ');
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const nested = record.error && typeof record.error === 'object'
      ? record.error as Record<string, unknown>
      : undefined;
    const parts = [
      record.name,
      record.code,
      record.status,
      record.statusCode,
      record.type,
      record.message,
      nested?.code,
      nested?.type,
      nested?.message,
    ];
    const compact = parts.filter((part) => part !== undefined && part !== null && String(part).trim()).join(' ');
    if (compact) {
      return compact;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return error === undefined || error === null ? '' : String(error);
}

function isAuthenticationError(rawMessage: string): boolean {
  const normalized = rawMessage.toLowerCase();
  return /\b401\b/.test(normalized)
    || normalized.includes('incorrect api key')
    || normalized.includes('invalid api key')
    || normalized.includes('model_authentication')
    || normalized.includes('authentication')
    || normalized.includes('authenticationerror')
    || normalized.includes('unauthorized')
    || normalized.includes('credential');
}

export function redactChatErrorSecrets(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, REDACTED_API_KEY)
    .replace(/\bxai-[A-Za-z0-9_-]{4,}\b/g, REDACTED_API_KEY)
    .replace(/\bAIza[A-Za-z0-9_-]{8,}\b/g, REDACTED_API_KEY)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED_API_KEY}`);
}

export function formatChatErrorMessage(error: unknown): string {
  const rawMessage = errorToSearchableText(error);
  if (isAuthenticationError(rawMessage)) {
    return CHAT_AUTH_ERROR_MESSAGE;
  }

  const sanitized = redactChatErrorSecrets(rawMessage).trim();
  return sanitized || UNKNOWN_CHAT_ERROR_MESSAGE;
}
