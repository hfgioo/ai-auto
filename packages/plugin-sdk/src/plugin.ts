/**
 * 插件系统类型定义
 */
import type { ComponentType } from 'react';
import type { MCPMeta } from './mcp';
import type { AgentMeta } from './agent';

export type { MCPMeta, AgentMeta };

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
  | 'network:external';

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
  /** 主程序版本上限，缺省视为无上限 */
  maxAppVersion?: string;
  /** 插件 API 契约版本，缺省视为 'v1' */
  apiVersion?: string;
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
  icon: string;
  label: string;
  order?: number;
}

// 全局插件元数据
export interface GlobalPluginMeta {
  entryRoute: string;
  navigation: GlobalPluginNavigation;
}

// Provider 插件元数据
export interface ProviderPluginMeta {
  channelType: 'tti' | 'itv' | 'tts' | 'llm';
  capabilities: string[];
  configPanel?: boolean;
  supportedActions?: string[];
}

// 工具插件元数据
export interface ToolPluginMeta {
  menuLabel: string;
  menuIcon?: string;
  shortcut?: string;
}

// 自定义面板定义
export interface CustomPanelDefinition {
  id: string;
  title: string;
  endpoint?: {
    method: 'GET' | 'POST';
    path: string;
  };
  component?: string;
}

// 插件清单 (manifest.json)
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: PluginAuthor;
  icon?: string;

  category: PluginCategory;
  engine: PluginEngine;
  scopes: PluginScope[];
  entry: PluginEntry;

  globalMeta?: GlobalPluginMeta;
  providerMeta?: ProviderPluginMeta;
  toolMeta?: ToolPluginMeta;
  mcpMeta?: MCPMeta;
  agentMeta?: AgentMeta;

  panels?: CustomPanelDefinition[];

  dependencies?: Record<string, string>; // pluginId -> version range

  /**
   * 对 manifest 除 signature 外字段的 ed25519 签名（base64）。
   * 由 marketplace 发布流程 (scripts/sign-plugin-manifest.cjs) 生成。
   * 本地手动安装可缺省。
   */
  signature?: string;
}

// 已安装的插件
export interface InstalledPlugin extends PluginManifest {
  rootPath: string;
  isEnabled: boolean;
  installedAt: number;
  lastUpdatedAt?: number;
}

// 插件加载状态
export type PluginLoadStatus = 'loading' | 'loaded' | 'error' | 'disabled';

// 运行时插件状态
export interface PluginRuntimeState {
  id: string;
  status: PluginLoadStatus;
  error?: string;
  component?: ComponentType<{ api: PluginAPI }>;
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
  type: 'tti' | 'itv' | 'tts' | 'llm';
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
  content: any;
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
  core: {
    getVersion(): Promise<string>;
    getHostInfo(): Promise<HostInfo>;
    on(event: 'registryUpdated' | 'projectChanged' | 'settingsChanged', handler: Function): void;
    off(event: string, handler: Function): void;
  };

  settings: {
    get(keys?: string[]): Promise<Record<string, any>>;
    set(patch: Record<string, any>): Promise<void>;
  };

  projects: {
    list(filter?: ProjectFilter): Promise<PluginProject[]>;
    get(projectId: string): Promise<PluginProject>;
    update(projectId: string, mutation: Partial<PluginProject>): Promise<void>;
  };

  prompts: {
    getTemplate(id: string): Promise<PluginPromptTemplate>;
    listTemplates(): Promise<PluginPromptTemplate[]>;
    override(payload: PromptOverride): Promise<void>;
  };

  channels: {
    registerProvider(def: any): Promise<void>;
    unregisterProvider(type: string): Promise<void>;
    updateProviderConfig(type: string, config: Record<string, any>): Promise<void>;
    getProviderConfig(type: string): Promise<Record<string, any> | null>;
    listProviders(kind?: string): Promise<any[]>;
    testProvider(kind: string, type: string, config: Record<string, any>): Promise<ChannelTestResult>;
    test(channelId: string): Promise<ChannelTestResult>;
    invoke(channelId: string, action: string, params: any): Promise<any>;
  };

  storage: {
    readFile(path: string): Promise<ArrayBuffer>;
    writeFile(path: string, data: ArrayBuffer): Promise<void>;
    deleteFile(path: string): Promise<void>;
    listFiles(dir: string): Promise<string[]>;
    openDialog(options: DialogOptions): Promise<string[]>;
  };

  ui: {
    showMessage(type: 'success' | 'error' | 'info' | 'warning', content: string): void;
    showModal(options: ModalOptions): Promise<boolean>;
    registerMenuItem(item: MenuItem): void;
    removeMenuItem(key: string): void;
  };
}

// 插件导出接口
export interface PluginExports {
  default: ComponentType<{ api: PluginAPI }>;
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
