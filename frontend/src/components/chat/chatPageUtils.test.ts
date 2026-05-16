import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../types';
import type { ModelCapability } from '../../providers/channel/types';
import {
  buildLLMConfigFromContext,
  resolveConfiguredChannelModel,
  serializeMediaSelection,
} from '../../providers/channel/resolver';
import {
  buildChatSessionConfig,
  CHAT_AUTH_ERROR_MESSAGE,
  formatChatErrorMessage,
  resolveInitialChatLLMSelection,
} from './chatPageUtils';

function createSettings(options?: { defaultEnabled?: boolean; defaultModelCapabilities?: ModelCapability[] }): AppSettings {
  return {
    channelConfigs: [
      {
        id: 'legacy-openai',
        name: '旧 OpenAI',
        category: 'llm',
        providerType: 'openai',
        providerConfig: {
          baseUrl: 'https://api.openai.com/v1',
          hasApiKey: true,
        },
        defaultModelId: 'gpt-4o',
        models: [
          {
            id: 'gpt-4o',
            label: 'gpt-4o',
            providerModelName: 'gpt-4o',
            capabilities: options?.defaultModelCapabilities ?? ['llm.chat'],
          },
        ],
        enabled: options?.defaultEnabled ?? true,
        source: 'builtin',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    mediaDefaults: {
      llm: {
        channelId: 'legacy-openai',
        modelId: 'gpt-4o',
      },
    },
    promptTemplates: {},
  };
}

describe('chatPageUtils', () => {
  it('使用 settings.mediaDefaults.llm 作为初始选择', () => {
    const settings = createSettings();
    const selection = resolveInitialChatLLMSelection(settings);

    expect(serializeMediaSelection(selection)).toBe('legacy-openai::gpt-4o');

    const context = resolveConfiguredChannelModel(settings, 'llm', selection, 'llm.chat');
    expect(context).toBeDefined();

    const selectedConfig = buildLLMConfigFromContext(context!);
    expect(selectedConfig.profileId).toBe('legacy-openai');
    expect(selectedConfig.baseUrl).toBe('https://api.openai.com/v1');

    const sessionConfig = buildChatSessionConfig(selectedConfig);
    expect(sessionConfig).toMatchObject({
      llmProfileId: 'legacy-openai',
      modelProvider: 'openai-compatible',
      modelName: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('默认渠道不可用时返回 undefined', () => {
    const selection = resolveInitialChatLLMSelection(
      createSettings({ defaultEnabled: false }),
    );

    expect(serializeMediaSelection(selection)).toBeUndefined();
  });

  it('默认渠道模型不支持 llm.chat 时返回 undefined', () => {
    const selection = resolveInitialChatLLMSelection(
      createSettings({ defaultModelCapabilities: [] }),
    );

    expect(serializeMediaSelection(selection)).toBeUndefined();
  });

  it('鉴权错误显示友好提示且不保留 API Key', () => {
    const formatted = formatChatErrorMessage(
      new Error('401 Incorrect API key provided: sk-xxxx. You can find your API key at https://platform.openai.com/account/api-keys.'),
    );

    expect(formatted).toBe(CHAT_AUTH_ERROR_MESSAGE);
    expect(formatted).not.toContain('sk-xxxx');
  });

  it('非鉴权错误会脱敏常见 API Key 片段', () => {
    const formatted = formatChatErrorMessage(
      'provider failed with sk-abcdefghijklmnop xai-abcdefghi AIzaSyA1234567890abcdef and Bearer secret-token-123456',
    );

    expect(formatted).toContain('[REDACTED_API_KEY]');
    expect(formatted).not.toContain('sk-abcdefghijklmnop');
    expect(formatted).not.toContain('xai-abcdefghi');
    expect(formatted).not.toContain('AIzaSyA1234567890abcdef');
    expect(formatted).not.toContain('secret-token-123456');
  });
});
