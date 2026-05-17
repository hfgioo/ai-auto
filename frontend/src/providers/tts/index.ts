/**
 * TTS Provider 模块导出
 * 重构版：注册到 ProviderRegistry
 */
export * from './types';
export { EdgeTTSProvider } from './EdgeTTSProvider';
export { OpenAITTSProvider } from './OpenAITTSProvider';
export { FishAudioProvider } from './FishAudioProvider';
export { GPTSoVITSProvider } from './GPTSoVITSProvider';
export { KomaTTSProvider, KOMA_TTS_VOICES } from './KomaTTSProvider';
export {
  KOMA_TTS_VOICE_CATEGORY_LABEL,
  KOMA_TTS_DEFAULT_VOICE_ID,
  findKomaTTSVoice,
  type KomaTTSVoiceMeta,
  type KomaTTSVoiceCategory,
} from './komaTTSVoices';
export { TTSService, ttsService } from './TTSService';
export type { DialogueSegment, SynthesizedDialogue } from './TTSService';

import type { TTSConfig } from '../../types';
import type { TTSProvider } from './types';
import { EdgeTTSProvider } from './EdgeTTSProvider';
import { OpenAITTSProvider } from './OpenAITTSProvider';
import { FishAudioProvider } from './FishAudioProvider';
import { GPTSoVITSProvider } from './GPTSoVITSProvider';
import { KomaTTSProvider, KOMA_TTS_VOICES } from './KomaTTSProvider';
import type { ProviderDefinition } from '../registry.types';
import { MEDIA_PROVIDER_CONTRACT_VERSION } from '../registry.types';
import { ttsRegistry } from '../registry';

// configSchema 定义
const edgeTTSSchema = {
  type: 'object',
  properties: {
    defaultVoice: { title: '默认音色', type: 'string', default: 'zh-CN-XiaoxiaoNeural' },
    defaultSpeed: { title: '语速', type: 'number', default: 1.0, minimum: 0.5, maximum: 2.0 },
  },
};

const openAITTSSchema = {
  type: 'object',
  properties: {
    apiKey: { title: 'API Key', type: 'string', format: 'password' },
    baseUrl: { title: 'API URL', type: 'string', default: 'https://api.openai.com/v1' },
    model: { title: '模型', type: 'string', enum: ['tts-1', 'tts-1-hd'], default: 'tts-1' },
    defaultVoice: { title: '默认音色', type: 'string', enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'], default: 'alloy' },
  },
  required: ['apiKey'],
};

const fishAudioSchema = {
  type: 'object',
  properties: {
    apiKey: { title: 'API Key', type: 'string', format: 'password' },
    baseUrl: { title: 'API URL', type: 'string', default: 'https://api.fish.audio' },
    defaultVoice: { title: '默认音色 ID', type: 'string' },
  },
  required: ['apiKey'],
};

const gptSovitsSchema = {
  type: 'object',
  properties: {
    baseUrl: { title: '服务地址', type: 'string', default: 'http://127.0.0.1:9880' },
    defaultVoice: { title: '默认参考音频路径', type: 'string' },
    defaultSpeed: { title: '语速', type: 'number', default: 1.0 },
  },
};

const komaTTSSchema = {
  type: 'object',
  properties: {
    apiKey: { title: 'API Key', type: 'string', format: 'password' },
    baseUrl: { title: 'API URL', type: 'string' },
    model: { title: '模型', type: 'string', default: 'qwen-tts' },
    defaultVoice: {
      title: '默认音色',
      type: 'string',
      enum: KOMA_TTS_VOICES.map((v) => v.id),
      default: KOMA_TTS_VOICES[0]?.id ?? 'cherry',
    },
  },
  required: ['apiKey', 'baseUrl'],
};

// 注册内置 TTS Provider
function registerBuiltinTTSProviders() {
  const builtins: ProviderDefinition<TTSProvider>[] = [
    {
      type: 'edge-tts',
      kind: 'tts',
      name: 'Edge TTS (免费)',
      description: '微软 Edge 免费语音合成',
      factory: (config) => new EdgeTTSProvider(config as TTSConfig),
      contractVersion: MEDIA_PROVIDER_CONTRACT_VERSION,
      capabilities: ['tts'],
      configSchema: edgeTTSSchema,
      auth: { apiKey: 'none', baseUrl: 'none' },
    },
    {
      type: 'openai-tts',
      kind: 'tts',
      name: 'OpenAI TTS',
      description: 'OpenAI 官方语音合成',
      factory: (config) => new OpenAITTSProvider(config as TTSConfig),
      contractVersion: MEDIA_PROVIDER_CONTRACT_VERSION,
      capabilities: ['tts'],
      configSchema: openAITTSSchema,
      presetBaseUrl: 'https://api.openai.com/v1',
      auth: { apiKey: 'required', baseUrl: 'optional' },
    },
    {
      type: 'fish-audio',
      kind: 'tts',
      name: 'Fish Audio',
      description: 'Fish Audio 语音合成',
      factory: (config) => new FishAudioProvider(config as TTSConfig),
      contractVersion: MEDIA_PROVIDER_CONTRACT_VERSION,
      capabilities: ['tts'],
      configSchema: fishAudioSchema,
      presetBaseUrl: 'https://api.fish.audio',
      auth: { apiKey: 'required', baseUrl: 'optional' },
    },
    {
      type: 'gpt-sovits',
      kind: 'tts',
      name: 'GPT-SoVITS (本地)',
      description: '本地部署的 GPT-SoVITS 服务',
      factory: (config) => new GPTSoVITSProvider(config as TTSConfig),
      contractVersion: MEDIA_PROVIDER_CONTRACT_VERSION,
      capabilities: ['tts'],
      configSchema: gptSovitsSchema,
      presetBaseUrl: 'http://127.0.0.1:9880',
      auth: { apiKey: 'none', baseUrl: 'required' },
    },
    {
      type: 'koma-tts',
      kind: 'tts',
      name: 'Qwen TTS（OpenAI 兼容）',
      description: 'OpenAI 兼容协议（/v1/audio/speech）下的 qwen-tts 语音合成',
      factory: (config) => new KomaTTSProvider(config as TTSConfig),
      contractVersion: MEDIA_PROVIDER_CONTRACT_VERSION,
      capabilities: ['tts'],
      configSchema: komaTTSSchema,
      auth: { apiKey: 'required', baseUrl: 'required' },
    },
  ];

  for (const def of builtins) {
    if (!ttsRegistry.has(def.type)) {
      ttsRegistry.register(def);
    }
  }
}

// 初始化时注册
registerBuiltinTTSProviders();

/**
 * 创建 TTS Provider
 * 从 Registry 获取，不再使用 switch-case
 */
export function createTTSProvider(config: TTSConfig): TTSProvider {
  const def = ttsRegistry.get(config.provider);
  if (!def) {
    throw new Error(`未知的语音合成服务商: ${config.provider}`);
  }
  // 使用包装函数保持 fetch 的上下文，避免 "Illegal invocation" 错误
  return def.factory(config, { sandboxedFetch: (...args: Parameters<typeof fetch>) => fetch(...args) });
}
