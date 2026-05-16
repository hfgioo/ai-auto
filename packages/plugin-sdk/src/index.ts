/**
 * @koma/plugin-sdk
 * Koma 插件开发 SDK - 类型定义和全局变量声明
 */

// 插件 API 相关类型
export type {
  PluginAPI,
  PluginCategory,
  PluginScope,
  PluginAuthor,
  PluginEngine,
  PluginEntry,
  PluginManifest,
  PluginExports,
  InstalledPlugin,
  PluginLoadStatus,
  PluginRuntimeState,
  PluginValidationResult,
  PluginImportOptions,
  PluginImportResult,
  // API 子类型
  HostInfo,
  ProjectFilter,
  PluginProject,
  PluginPromptTemplate,
  PromptOverride,
  PluginChannelConfig,
  ChannelTestResult,
  DialogOptions,
  ModalOptions,
  MenuItem,
  // 元数据类型
  GlobalPluginMeta,
  GlobalPluginNavigation,
  ProviderPluginMeta,
  ToolPluginMeta,
  CustomPanelDefinition,
  // MCP/Agent 元数据（新增）
  MCPMeta,
  AgentMeta,
} from './plugin';

// MCP 相关类型（新增）
export type {
  MCPTransportType,
  MCPToolDefinition,
  MCPToolHandler,
  MCPResourceDefinition,
  MCPResourceHandler,
  MCPServerDefinition,
} from './mcp';

// Agent 相关类型（新增）
export type {
  AgentInput,
  AgentEvent,
  WorkerAgentDefinition,
} from './agent';

// 后端插件 API 类型（新增）
export type {
  ElectronPluginAPI,
  PluginBackendModule,
  SpawnOptions,
  ChildProcessHandle,
} from './backend';

// Provider 相关类型
export type {
  ProviderDefinition,
  ProviderContext,
  ProviderAuthRequirements,
  ProviderModelDefinition,
  ChannelKind,
  ChannelCapability,
  PollingConfig,
  ProviderAssetInput,
  ProviderStartResult,
  ProviderTaskSnapshot,
  TTSRequest,
} from './provider';
export {
  MEDIA_PROVIDER_CONTRACT_VERSION,
  requiresMediaContractVersion,
} from './provider';

// TTI Provider 类型
export type {
  TTIProvider,
  TTIOptions,
  TTIRequest,
  ImageResult,
} from './tti';

// ITV Provider 类型
export type {
  ITVProvider,
  ITVOptions,
  ITVRequest,
  ITVResult,
  ProgressInfo,
  CharacterExtractionParams,
  CharacterProgressInfo,
  RemixOptions,
} from './itv';

// 图床 Provider 类型
export type {
  ImageHostingProvider,
  ImageHostingUploadOptions,
  ImageHostingUploadResult,
  ImageHostingProviderDefinition,
} from './imageHosting';

// 全局变量声明
export type {} from './globals';
