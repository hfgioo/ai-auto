/**
 * LLM Provider 工厂和导出
 *
 * 重构（P0#1 阶段 C）：把 LLM 渠道（openai/deepseek/qwen/zhipu/moonshot/gemini/claude）
 * 注册到 ProviderRegistry，让 channel/catalog.ts 与 store/settings/presets.ts
 * 用同一套派生逻辑列出 LLM 渠道。
 *
 * 注意：所有 LLM 调用最终走 IPCLLMProvider → 主进程 LLMExecutionEngine，
 * 这里 def.factory 仅用于"统一接口"，不真正承担工厂分发职责。
 */
import type { ModelConfig } from '../../types';
import type { LLMProvider } from './types';
import { IPCLLMProvider, isLLMIPCAvailable } from './IPCLLMProvider';
import type { ProviderDefinition } from '../registry.types';
import { llmRegistry } from '../registry';

export type { LLMProvider, ChatMessage } from './types';
export { IPCLLMProvider } from './IPCLLMProvider';

interface LLMChannelDef {
  type: string;                                                  // 渠道 ID（'openai' / 'gemini' / ...）
  name: string;                                                  // UI 显示名
  presetBaseUrl?: string;                                        // 默认 baseUrl，可选
  runtimeProtocol: 'openai-compatible' | 'gemini' | 'claude';   // 主进程路由协议
}

// 内置 LLM 渠道注册三个标准协议；不预填 baseUrl，由用户在添加渠道时自行填写。
const BUILTIN_LLM_CHANNELS: LLMChannelDef[] = [
  { type: 'openai', name: 'OpenAI',  runtimeProtocol: 'openai-compatible' },
  { type: 'claude', name: 'Claude',  runtimeProtocol: 'claude' },
  { type: 'gemini', name: 'Gemini',  runtimeProtocol: 'gemini' },
];

function registerBuiltinLLMProviders() {
  for (const ch of BUILTIN_LLM_CHANNELS) {
    if (llmRegistry.has(ch.type)) continue;
    const def: ProviderDefinition<LLMProvider> = {
      type: ch.type,
      kind: 'llm',
      name: ch.name,
      runtimeProviderType: ch.runtimeProtocol,
      capabilities: ['llm'],
      ...(ch.presetBaseUrl ? { presetBaseUrl: ch.presetBaseUrl } : {}),
      auth: { apiKey: 'required', baseUrl: 'optional' },
      // factory 在此处不会被工厂分发使用（LLM 始终走 createLLMProvider → IPC），
      // 仅为接口完整性提供一个直通实现。
      factory: (config) => new IPCLLMProvider({
        ...(config as ModelConfig),
        provider: ch.runtimeProtocol,
      } as ModelConfig),
    };
    llmRegistry.register(def);
  }
}

// 初始化时注册
registerBuiltinLLMProviders();

/**
 * 创建 LLM Provider
 * 所有 LLM 调用都必须走 Electron IPC → 主进程
 */
export function createLLMProvider(config: ModelConfig): LLMProvider {
  if (!isLLMIPCAvailable()) {
    throw new Error('[LLMProvider] Electron IPC is required — direct LLM access has been removed');
  }

  return new IPCLLMProvider(config);
}
