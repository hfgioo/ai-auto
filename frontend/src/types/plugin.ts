/**
 * 插件系统类型定义
 */

// 插件分类
export type PluginCategory = 'provider' | 'global' | 'tool' | 'mcp' | 'agent';

// 权限作用域
export type PluginScope =
  | 'settings:read'
  | 'settings:write'
  | 'projects:read'
  | 'projects:write'
  | 'prompts:override'
  | 'storage:limited'
  | 'network:external'
  | 'mcp:server'
  | 'mcp:tool'
  | 'mcp:resource'
  | 'agent:register'
  | 'spawn:process';

// 插件作者信息
export interface PluginAuthor {
  name: string;
  url?: string;
  email?: string;
}

// 引擎兼容性
export interface PluginEngine {
  minAppVersion: string;
  sdkVersion: string;
}

// 入口配置
export interface PluginEntry {
  backend?: string;   // 后端 JS 入口（保留，未来扩展）
  frontend?: string;  // 前端入口（兼容旧插件：UI + 逻辑）
  logic?: string;     // 纯逻辑入口（Provider 类 + onActivate）
  ui?: string;        // 纯 UI 入口（React 组件）
}

// 全局插件导航配置
export interface GlobalPluginNavigation {
  icon: string;      // 图标名称 (mdi:xxx 或 antd icon)
  label: string;     // 显示文本
  order?: number;    // 排序权重，越小越靠前
}

// 全局插件元数据
export interface GlobalPluginMeta {
  entryRoute: string;            // 路由路径，如 /plugins/com.example.my-plugin
  navigation: GlobalPluginNavigation;
}

// Provider 插件元数据
export interface ProviderPluginMeta {
  channelType: 'tti' | 'itv' | 'tts' | 'llm' | 'image-hosting';  // 主渠道类型
  capabilities: string[];     // 支持的能力列表，如 ['itv', 'character-extract']
  configPanel?: boolean;      // 是否有自定义配置面板
  supportedActions?: string[];  // 支持的操作 (兼容旧字段)
}

// 工具插件元数据
export interface ToolPluginMeta {
  menuLabel: string;             // 工具菜单显示名称
  menuIcon?: string;
  shortcut?: string;             // 快捷键
}

// 自定义面板定义
export interface CustomPanelDefinition {
  id: string;
  title: string;
  endpoint?: {
    method: 'GET' | 'POST';
    path: string;
  };
  component?: string;            // 组件名称
}

// 插件清单 (manifest.json)
export interface PluginManifest {
  id: string;                    // 唯一标识，如 com.example.my-plugin
  name: string;                  // 显示名称
  version: string;               // 语义版本
  description?: string;
  author?: PluginAuthor;
  icon?: string;                 // 图标路径 (相对于插件根目录)

  category: PluginCategory;
  engine: PluginEngine;
  scopes: PluginScope[];
  entry: PluginEntry;

  // 按分类的元数据
  globalMeta?: GlobalPluginMeta;
  providerMeta?: ProviderPluginMeta;
  toolMeta?: ToolPluginMeta;

  // 自定义面板
  panels?: CustomPanelDefinition[];
}

// 已安装的插件
export interface InstalledPlugin extends PluginManifest {
  rootPath: string;              // 插件安装路径
  isEnabled: boolean;            // 是否启用
  installedAt: number;           // 安装时间戳
  lastUpdatedAt?: number;        // 最后更新时间
  isBuiltin?: boolean;           // 是否为内置插件（不允许删除）
}

// 插件加载状态
export type PluginLoadStatus = 'loading' | 'loaded' | 'error' | 'disabled';

// 运行时插件状态
export interface PluginRuntimeState {
  id: string;
  status: PluginLoadStatus;
  error?: string;
  component?: React.ComponentType<{ api: PluginAPI }>;
}

// ========== Plugin API ==========

// 主机信息
export interface HostInfo {
  appVersion: string;
  platform: 'win32' | 'darwin' | 'linux';
  electronVersion: string;
}

// 项目过滤器
export interface ProjectFilter {
  status?: 'active' | 'archived';
  search?: string;
}

// 项目信息
export interface PluginProject {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

// 提示词模板
export interface PluginPromptTemplate {
  id: string;
  name: string;
  template: string;
  variables: string[];
}

// 提示词覆盖
export interface PromptOverride {
  templateId: string;
  newTemplate: string;
  priority?: number;
}

// 渠道配置
export interface PluginChannelConfig {
  id: string;
  type: 'tti' | 'itv' | 'tts' | 'llm' | 'image-hosting';
  name: string;
  config: Record<string, any>;
}

// 渠道测试结果
export interface ChannelTestResult {
  success: boolean;
  latency?: number;
  error?: string;
}

// 对话框选项
export interface DialogOptions {
  title?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  multiple?: boolean;
  directory?: boolean;
}

// 模态框选项
export interface ModalOptions {
  title: string;
  content: React.ReactNode | string;
  okText?: string;
  cancelText?: string;
  width?: number;
}

// 菜单项
export interface MenuItem {
  key: string;
  label: string;
  icon?: string;
  onClick: () => void;
}

// 插件 API 接口
export interface PluginAPI {
  // 核心功能
  core: {
    getVersion(): Promise<string>;
    getHostInfo(): Promise<HostInfo>;
    on(event: 'registryUpdated' | 'projectChanged' | 'settingsChanged', handler: Function): void;
    off(event: string, handler: Function): void;
  };

  // 设置访问
  settings: {
    get(keys?: string[]): Promise<Record<string, any>>;
    set(patch: Record<string, any>): Promise<void>;
  };

  // 项目访问
  projects: {
    list(filter?: ProjectFilter): Promise<PluginProject[]>;
    get(projectId: string): Promise<PluginProject>;
    update(projectId: string, mutation: Partial<PluginProject>): Promise<void>;
  };

  // 提示词系统
  prompts: {
    getTemplate(id: string): Promise<PluginPromptTemplate>;
    listTemplates(): Promise<PluginPromptTemplate[]>;
    override(payload: PromptOverride): Promise<void>;
  };

  // 渠道管理（Provider 注入）
  channels: {
    /** 注册 Provider */
    registerProvider(def: any): Promise<void>;
    /** 反注册 Provider */
    unregisterProvider(type: string): Promise<void>;
    /** 更新 Provider 配置 */
    updateProviderConfig(type: string, config: Record<string, any>): Promise<void>;
    /** 获取 Provider 配置 */
    getProviderConfig(type: string): Promise<Record<string, any> | null>;
    /** 列出所有 Provider */
    listProviders(kind?: string): Promise<any[]>;
    /** 测试 Provider */
    testProvider(kind: string, type: string, config: Record<string, any>): Promise<ChannelTestResult>;
    test(channelId: string): Promise<ChannelTestResult>;
    invoke(channelId: string, action: string, params: any): Promise<any>;
  };

  // 存储 (沙箱内)
  storage: {
    readFile(path: string): Promise<ArrayBuffer>;
    writeFile(path: string, data: ArrayBuffer): Promise<void>;
    deleteFile(path: string): Promise<void>;
    listFiles(dir: string): Promise<string[]>;
    openDialog(options: DialogOptions): Promise<string[]>;
  };

  // UI 交互
  ui: {
    showMessage(type: 'success' | 'error' | 'info' | 'warning', content: string): void;
    showModal(options: ModalOptions): Promise<boolean>;
    registerMenuItem(item: MenuItem): void;
    removeMenuItem(key: string): void;
  };
}

// 插件导出接口
export interface PluginExports {
  default: React.ComponentType<{ api: PluginAPI }>;
  onActivate?: (api: PluginAPI) => void | Promise<void>;
  onDeactivate?: () => void | Promise<void>;
}

// 插件验证结果
export interface PluginValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest?: PluginManifest;
}

// 插件导入选项
export interface PluginImportOptions {
  skipValidation?: boolean;
  overwrite?: boolean;
}

// 插件导入结果
export interface PluginImportResult {
  success: boolean;
  plugin?: InstalledPlugin;
  error?: string;
}
