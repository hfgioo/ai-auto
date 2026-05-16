/**
 * Electron 后端插件 API 类型定义
 * 与 electron/service/plugin/types.ts 完全对齐
 */

import type {
  MCPServerDefinition,
  MCPToolDefinition,
  MCPToolHandler,
  MCPResourceDefinition,
  MCPResourceHandler,
} from './mcp';
import type { WorkerAgentDefinition } from './agent';
import type { ProviderDefinition } from './provider';

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

// Electron 后端插件 API
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
    list: (filter?: { type?: string; tags?: string[] }) => unknown[];
    resolve: (requirements: string[]) => unknown[];
    invoke: (id: string, args: unknown) => Promise<unknown>;
  };

  // 日志
  log: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

// 插件模块导出接口（后端）
export interface PluginBackendModule {
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
