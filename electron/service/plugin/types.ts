/**
 * 统一插件系统类型定义（Electron 运行时副本）
 * 支持 Provider / Global / Tool / MCP / Agent 五种插件类型
 *
 * Provider 部分的规格真源：packages/plugin-sdk/src/provider.ts。
 * 修改 ProviderDefinition / MEDIA_PROVIDER_CONTRACT_VERSION /
 * requiresMediaContractVersion 时必须先在 SDK 落地，并同步：
 *   - frontend/src/providers/registry.types.ts
 *   - 本文件
 * 然后升级 packages/plugin-sdk/package.json:version。
 */

// ========== 基础类型 ==========

export type PluginCategory = 'provider' | 'global' | 'tool' | 'mcp' | 'agent';

export type PluginStatus = 'installed' | 'loaded' | 'active' | 'error' | 'disabled';

export type MCPTransportType = 'stdio' | 'sse' | 'websocket' | 'internal';

// ========== Manifest 定义 ==========

export interface PluginEngine {
  minAppVersion: string;
  sdkVersion: string;
  /**
   * 主程序版本上限。超过则插件不被激活。
   * 缺省视为无上限（兼容旧插件）。
   */
  maxAppVersion?: string;
  /**
   * 插件依赖的 API 契约版本。
   * 主程序声明 SUPPORTED_API_VERSIONS 列表；缺省视为 'v1'。
   */
  apiVersion?: string;
}

export interface PluginEntry {
  frontend?: string;  // 前端 UI bundle
  backend?: string;   // Electron 后端模块
  logic?: string;     // 业务逻辑（已废弃，兼容）
  ui?: string;        // UI 入口（已废弃，兼容）
}

// Provider 元数据
export interface ProviderMeta {
  channelType: 'tti' | 'itv' | 'tts' | 'llm' | 'image-hosting';
  capabilities: string[];
  configPanel?: boolean;
  defaultConfig?: Record<string, unknown>;
}

// Global 元数据
export interface GlobalMeta {
  entryRoute: string;
  navigation: {
    icon: string;
    label: string;
    order?: number;
  };
}

// MCP 元数据
export interface MCPMeta {
  transport: MCPTransportType;
  // stdio 模式需要
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse/websocket 模式需要
  url?: string;
  // 工具声明（用于 UI 展示，实际定义在插件代码中）
  tools?: Array<{
    name: string;
    description: string;
  }>;
  // 资源声明
  resources?: Array<{
    uri: string;
    description: string;
  }>;
}

// Agent 元数据
export interface AgentMeta {
  capabilities: string[];
  tools?: string[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

// 完整 Manifest
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  category: PluginCategory;
  engine: PluginEngine;
  scopes: string[];
  entry: PluginEntry;
  // 分类特定元数据
  providerMeta?: ProviderMeta;
  globalMeta?: GlobalMeta;
  mcpMeta?: MCPMeta;
  agentMeta?: AgentMeta;
  /**
   * 对 manifest 中除 signature 字段外的规范化 JSON（键名按字典序递归排序后 JSON.stringify）
   * 用 ed25519 签名后的 base64。
   *   - marketplace 安装路径下，缺失/不通过即拒绝
   *   - 本地手动安装路径下仅警告
   */
  signature?: string;
  [key: string]: any;
}

// ========== 运行时类型 ==========

// MCP 工具定义
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName?: string;  // 来源服务器
  pluginId?: string;    // 来源插件
}

// MCP 工具处理器
export interface MCPToolHandler {
  definition: MCPToolDefinition;
  handler: (args: unknown) => Promise<unknown>;
}

// MCP 资源定义
export interface MCPResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  pluginId?: string;
}

// MCP 资源处理器
export interface MCPResourceHandler {
  definition: MCPResourceDefinition;
  handler: (uri: string) => Promise<{ content: string; mimeType?: string }>;
}

// MCP 服务器定义
export interface MCPServerDefinition {
  name: string;
  transport: MCPTransportType;
  tools: MCPToolHandler[];
  resources?: MCPResourceHandler[];
  pluginId?: string;
}

// 凭据/连接要求声明 + 模型定义：直接从 SDK type-import，不再维护本地副本。
// 主进程仅做类型层引用，编译后 erase，无运行时 SDK 依赖。
import type {
  ProviderAuthRequirements,
  ProviderModelDefinition,
} from '@komastudio/plugin-sdk';
export type {
  ProviderAuthRequirements,
  ProviderModelDefinition,
} from '@komastudio/plugin-sdk';

export interface PluginPollingConfig {
  interval: number;
  maxDuration: number;
  initialDelay?: number;
}

// Provider 定义
export interface ProviderDefinition {
  type: string;
  kind: 'tti' | 'itv' | 'tts' | 'llm' | 'image-hosting';
  name: string;
  description?: string;
  capabilities: string[];
  factory: (config: unknown, ctx: unknown) => unknown;
  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  pluginId?: string;
  /**
   * 媒体 Provider 契约版本。tti/itv/tts 必填，需与运行时
   * MEDIA_PROVIDER_CONTRACT_VERSION（'media-request-v1'）一致；
   * 由 Electron 端 ProviderRegistry 在注册时强制校验。
   */
  contractVersion?: string;
  models?: ProviderModelDefinition[];
  polling?: PluginPollingConfig;
  presetBaseUrl?: string;
  auth?: ProviderAuthRequirements;
  runtimeProviderType?: string;
}

/**
 * 媒体 Provider 契约版本。Electron 与前端必须保持完全一致；
 * 升级契约时同步修改 frontend/src/providers/registry.types.ts。
 */
export const MEDIA_PROVIDER_CONTRACT_VERSION = 'media-request-v1';

export function requiresMediaContractVersion(kind: ProviderDefinition['kind']): boolean {
  return kind === 'tti' || kind === 'itv' || kind === 'tts';
}

// Agent Worker 定义
export interface WorkerAgentDefinition {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  tools?: string[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  // 调用方法
  invoke?: (input: AgentInput) => AsyncGenerator<AgentEvent>;
  pluginId?: string;
}

// Agent 输入
export interface AgentInput {
  message: string;
  context?: Record<string, unknown>;
  tools?: MCPToolDefinition[];
}

// Agent 事件
export interface AgentEvent {
  type: 'chunk' | 'tool_call' | 'tool_result' | 'done' | 'error';
  data: unknown;
}

// ========== 插件 API ==========

export interface ElectronPluginAPI {
  // 核心信息
  core: {
    getVersion: () => string;
    getPluginDir: () => string;
    getDataDir: () => string;
  };

  // 文件系统（沙箱内）
  fs: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
    deleteFile: (path: string) => Promise<void>;
    exists: (path: string) => Promise<boolean>;
    listDir: (path: string) => Promise<string[]>;
  };

  // 网络
  net: {
    fetch: typeof fetch;
  };

  // 子进程（需要 spawn 权限）
  spawn: (command: string, args?: string[], options?: SpawnOptions) => ChildProcessHandle;

  // Provider 能力
  channels: {
    registerProvider: (def: ProviderDefinition) => Promise<void>;
    unregisterProvider: (type: string) => Promise<void>;
    listProviders: (kind?: string) => ProviderDefinition[];
    getProviderConfig: (type: string) => Promise<Record<string, unknown> | null>;
    updateProviderConfig: (type: string, config: Record<string, unknown>) => Promise<void>;
  };

  // MCP 能力
  mcp: {
    registerServer: (server: MCPServerDefinition) => Promise<void>;
    unregisterServer: (name: string) => Promise<void>;
    registerTool: (tool: MCPToolHandler) => Promise<void>;
    unregisterTool: (name: string) => Promise<void>;
    registerResource: (resource: MCPResourceHandler) => Promise<void>;
    unregisterResource: (uri: string) => Promise<void>;
    listTools: () => MCPToolDefinition[];
    listResources: () => MCPResourceDefinition[];
  };

  // Agent 能力
  agents: {
    registerWorker: (worker: WorkerAgentDefinition) => Promise<void>;
    unregisterWorker: (id: string) => Promise<void>;
    listWorkers: () => WorkerAgentDefinition[];
  };

  // Capability 统一能力
  capability: {
    list: (filter?: { type?: string; tags?: string[] }) => any[];
    resolve: (requirements: string[]) => any[];
    invoke: (id: string, args: unknown) => Promise<any>;
  };

  // 日志
  log: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

// 子进程选项
export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

// 子进程句柄
export interface ChildProcessHandle {
  pid: number;
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  stdin: {
    write: (data: string) => void;
    end: () => void;
  };
  kill: (signal?: string) => void;
  wait: () => Promise<number>;
}

// ========== 插件实例 ==========

export interface PluginModule {
  // 生命周期
  onActivate?: (api: ElectronPluginAPI) => Promise<void>;
  onDeactivate?: () => Promise<void>;
  // Provider 工厂（provider 类型插件）
  createProvider?: (config: unknown, ctx: unknown) => unknown;
  // MCP 服务器（mcp 类型插件）
  createMCPServer?: () => MCPServerDefinition;
  // Agent Worker（agent 类型插件）
  createAgent?: () => WorkerAgentDefinition;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  module: PluginModule | null;
  status: PluginStatus;
  error?: string;
  loadedAt?: number;
}

// ========== 注册表接口 ==========

export interface IRegistry<T> {
  register: (item: T) => void;
  unregister: (id: string) => void;
  get: (id: string) => T | undefined;
  list: () => T[];
  clear: () => void;
}
