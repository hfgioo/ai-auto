/**
 * Electron 插件运行时
 * 负责加载和管理 Electron 侧插件（backend 模块）
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import { app } from 'electron';
import { EventEmitter } from 'events';
import { getPluginProviderConfigPath, getPluginsRuntimeDir } from '../paths';
import type {
  PluginManifest,
  PluginModule,
  LoadedPlugin,
  ElectronPluginAPI,
  ProviderDefinition,
  MCPServerDefinition,
  MCPToolHandler,
  MCPResourceHandler,
  WorkerAgentDefinition,
  SpawnOptions,
  ChildProcessHandle,
} from './types';
import { MEDIA_PROVIDER_CONTRACT_VERSION, requiresMediaContractVersion } from './types';
import { providerRegistry, mcpRegistry, agentRegistry } from './registries';
import { syncProviders, syncAllMCP, capabilityRegistry } from './capability';
import {
  validatePluginCompatibility,
  formatCompatibilityErrors,
  requirePluginScope,
  validateManifestShape,
  type CompatibilityReport,
} from './compatibility';
import {
  createChannelConfig,
  getDecryptedApiKey,
  listChannelConfigs,
  updateChannelConfig,
} from '../settings/ChannelConfigService';
import type {
  ChannelConfigDTO,
  ChannelConfigInput,
} from '../settings/ChannelConfigService';
import type { MediaCategory } from '../storage/repositories/settingsInterfaces';

// 仅作为兼容迁移来源：旧版插件配置文件（provider-configs.json）。
class LegacyProviderConfigStore {
  private configPath = '';
  private configs: Map<string, Record<string, unknown>> = new Map();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.configPath = getPluginProviderConfigPath();
    await this.load();
    this.initialized = true;
  }

  private async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      const data = JSON.parse(content);
      this.configs = new Map(
        Object.entries(data).filter((entry): entry is [string, Record<string, unknown>] => {
          const [, value] = entry;
          return value != null && typeof value === 'object' && !Array.isArray(value);
        }),
      );
    } catch {
      this.configs = new Map();
    }
  }

  private async save(): Promise<void> {
    const data = Object.fromEntries(this.configs);
    await fs.writeFile(this.configPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  async get(type: string): Promise<Record<string, unknown> | null> {
    await this.init();
    return this.configs.get(type) || null;
  }

  async remove(type: string): Promise<void> {
    await this.init();
    if (!this.configs.delete(type)) return;
    await this.save();
  }
}

const legacyProviderConfigStore = new LegacyProviderConfigStore();

function resolvePluginProviderCategory(manifest: PluginManifest, type: string): MediaCategory {
  const category = manifest.providerMeta?.channelType;
  if (!category) {
    throw new Error(`Plugin "${manifest.id}" provider "${type}" 缺少 providerMeta.channelType，无法持久化配置`);
  }
  return category;
}

function pickLatestPluginChannelConfig(
  pluginId: string,
  type: string,
): ChannelConfigDTO | null {
  const matches = listChannelConfigs().filter(
    (config) => config.pluginId === pluginId && config.providerType === type,
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.updatedAt - a.updatedAt);
  return matches[0];
}

function buildPluginRuntimeConfig(dto: ChannelConfigDTO): Record<string, unknown> {
  const config: Record<string, unknown> = { ...(dto.providerConfig || {}) };
  if (dto.baseUrl) {
    config.baseUrl = dto.baseUrl;
  }
  try {
    const apiKey = getDecryptedApiKey(dto.id);
    if (apiKey) {
      config.apiKey = apiKey;
    }
  } catch (err: any) {
    console.warn('[PluginRuntime] Failed to decrypt plugin provider apiKey', {
      channelId: dto.id,
      providerType: dto.providerType,
      error: err?.message || String(err),
    });
  }
  return config;
}

function splitRuntimeProviderConfig(config: Record<string, unknown>): {
  baseUrl: string | null;
  providerConfig: Record<string, unknown>;
} {
  const providerConfig: Record<string, unknown> = { ...(config || {}) };
  const baseUrlRaw = providerConfig.baseUrl;
  const baseUrl = typeof baseUrlRaw === 'string' ? baseUrlRaw : null;
  delete providerConfig.baseUrl;
  delete providerConfig.hasApiKey;

  const keyRaw = providerConfig.apiKey;
  if (typeof keyRaw !== 'string' || keyRaw.length === 0) {
    delete providerConfig.apiKey;
  }

  return { baseUrl, providerConfig };
}

function buildPluginChannelInput(
  manifest: PluginManifest,
  type: string,
  config: Record<string, unknown>,
): ChannelConfigInput {
  const normalized = splitRuntimeProviderConfig(config);
  return {
    category: resolvePluginProviderCategory(manifest, type),
    providerType: type,
    name: manifest.name || type,
    description: manifest.description ?? null,
    baseUrl: normalized.baseUrl,
    providerConfig: normalized.providerConfig,
    models: [],
    capabilities: manifest.providerMeta?.capabilities || [],
    polling: null,
    defaultModelId: null,
    source: 'plugin',
    pluginId: manifest.id,
    enabled: true,
    isDefault: false,
    sortOrder: 0,
  };
}

function upsertPluginProviderConfig(
  manifest: PluginManifest,
  type: string,
  config: Record<string, unknown>,
): ChannelConfigDTO {
  const existing = pickLatestPluginChannelConfig(manifest.id, type);
  if (existing) {
    const normalized = splitRuntimeProviderConfig(config);
    return updateChannelConfig(existing.id, {
      baseUrl: normalized.baseUrl,
      providerConfig: normalized.providerConfig,
      source: 'plugin',
      pluginId: manifest.id,
    });
  }
  return createChannelConfig(buildPluginChannelInput(manifest, type, config));
}

async function getPluginProviderConfig(
  manifest: PluginManifest,
  type: string,
): Promise<Record<string, unknown> | null> {
  const existing = pickLatestPluginChannelConfig(manifest.id, type);
  if (existing) {
    return buildPluginRuntimeConfig(existing);
  }

  const legacy = await legacyProviderConfigStore.get(type);
  if (!legacy) return null;

  try {
    const migrated = upsertPluginProviderConfig(manifest, type, legacy);
    await legacyProviderConfigStore.remove(type);
    console.info('[PluginRuntime] Migrated legacy provider config to SQLite', {
      pluginId: manifest.id,
      providerType: type,
      channelId: migrated.id,
    });
    return buildPluginRuntimeConfig(migrated);
  } catch (err: any) {
    console.warn('[PluginRuntime] Failed to migrate legacy provider config, fallback to legacy payload', {
      pluginId: manifest.id,
      providerType: type,
      error: err?.message || String(err),
    });
    return legacy;
  }
}

async function savePluginProviderConfig(
  manifest: PluginManifest,
  type: string,
  config: Record<string, unknown>,
): Promise<void> {
  upsertPluginProviderConfig(manifest, type, config);
  await legacyProviderConfigStore.remove(type);
}

class ElectronPluginRuntime extends EventEmitter {
  private plugins = new Map<string, LoadedPlugin>();
  private pluginsDir: string = '';

  async init(): Promise<void> {
    this.pluginsDir = getPluginsRuntimeDir();
    await fs.mkdir(this.pluginsDir, { recursive: true });
  }

  /**
   * 加载插件
   */
  async loadPlugin(manifest: PluginManifest): Promise<LoadedPlugin> {
    const pluginId = manifest.id || '<unknown>';

    // 必填字段校验。errors 必定阻断加载，避免 require 时才崩出非定向错误。
    const shapeReport = validateManifestShape(manifest);
    for (const w of shapeReport.warnings) {
      console.warn(`[PluginRuntime] manifest warning for "${pluginId}": ${w}`);
    }
    if (shapeReport.errors.length > 0) {
      const message = shapeReport.errors.join('; ');
      console.error(`[PluginRuntime] manifest invalid for "${pluginId}": ${message}`);
      const failed: LoadedPlugin = {
        manifest,
        module: null,
        status: 'error',
        error: `manifest invalid: ${message}`,
      };
      this.plugins.set(pluginId, failed);
      throw new Error(`manifest invalid: ${message}`);
    }

    // 检查是否已加载
    if (this.plugins.has(pluginId)) {
      const existing = this.plugins.get(pluginId)!;
      if (existing.status === 'active') {
        return existing;
      }
    }

    const plugin: LoadedPlugin = {
      manifest,
      module: null,
      status: 'installed',
    };

    try {
      // 只有有 backend 入口的插件才需要加载模块
      if (manifest.entry.backend) {
        const modulePath = path.join(this.pluginsDir, pluginId, manifest.entry.backend);

        // 检查模块文件是否存在
        try {
          await fs.access(modulePath);
        } catch {
          throw new Error(`Backend module not found: ${modulePath}`);
        }

        // 动态加载模块
        // 使用 require 而非 import 以支持 CommonJS
        // 强制清 require cache：内置插件每次启动会被 _syncBuiltinPlugins 覆盖，
        // 但 dev 模式下 electron watch 可能因端口/SingletonLock 冲突导致主进程未真正重启，
        // 旧的 require cache 还会持有上一次的 backend module。每次 load 前清掉，确保拿到最新代码。
        try {
          const resolved = require.resolve(modulePath);
          if (require.cache[resolved]) {
            delete require.cache[resolved];
          }
        } catch {
          // resolve 失败说明从未 require 过，忽略
        }
        const module = require(modulePath) as PluginModule;
        plugin.module = module;
        plugin.status = 'loaded';
        plugin.loadedAt = Date.now();

        console.log(`[PluginRuntime] Loaded plugin: ${pluginId} (modulePath=${modulePath})`);
      } else {
        // 没有 backend 入口，标记为已加载
        plugin.status = 'loaded';
        plugin.loadedAt = Date.now();
      }

      this.plugins.set(pluginId, plugin);
      return plugin;
    } catch (err: any) {
      plugin.status = 'error';
      plugin.error = err.message;
      this.plugins.set(pluginId, plugin);
      console.error(`[PluginRuntime] Failed to load plugin ${pluginId}:`, err);
      throw err;
    }
  }

  /**
   * 激活插件
   */
  async activatePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin "${pluginId}" not loaded`);
    }

    if (plugin.status === 'active') {
      return; // 已激活
    }

    if (plugin.status === 'error') {
      throw new Error(`Plugin "${pluginId}" is in error state: ${plugin.error}`);
    }

    // 兼容性校验：在调用 onActivate 之前拦截 minAppVersion / sdkVersion 不兼容
    const report: CompatibilityReport = validatePluginCompatibility(plugin.manifest);
    if (report.warnings.length > 0) {
      for (const w of report.warnings) {
        console.warn(`[PluginRuntime] ${w.message}`);
      }
    }
    if (report.fatal.length > 0) {
      const message = formatCompatibilityErrors(report);
      plugin.status = 'error';
      plugin.error = message;
      console.error(`[PluginRuntime] Activation aborted (incompatible): ${message}`);
      throw new Error(message);
    }

    try {
      // 创建插件 API
      const api = this.createPluginAPI(plugin.manifest);

      // 调用 onActivate
      if (plugin.module?.onActivate) {
        await plugin.module.onActivate(api);
      }

      // 根据插件类型进行特殊处理
      await this.handlePluginActivation(plugin, api);

      plugin.status = 'active';
      this.emit('activated', pluginId);
      console.log(`[PluginRuntime] Activated plugin: ${pluginId}`);

      // 同步 Capability（插件激活后新能力可用）
      syncProviders();
      syncAllMCP();
    } catch (err: any) {
      plugin.status = 'error';
      plugin.error = err.message;
      console.error(`[PluginRuntime] Failed to activate plugin ${pluginId}:`, err);
      throw err;
    }
  }

  /**
   * 根据插件类型进行特殊激活处理
   */
  private async handlePluginActivation(plugin: LoadedPlugin, _api: ElectronPluginAPI): Promise<void> {
    const { manifest, module } = plugin;
    console.log(`[PluginRuntime] handlePluginActivation: ${manifest.id}, category: ${manifest.category}`);
    console.log(`[PluginRuntime] module.createProvider exists: ${!!module?.createProvider}`);
    console.log(`[PluginRuntime] manifest.providerMeta exists: ${!!manifest.providerMeta}`);

    switch (manifest.category) {
      case 'provider':
        // Provider 插件：如果提供了 createProvider 工厂
        if (module?.createProvider && manifest.providerMeta) {
          const kind = manifest.providerMeta.channelType;
          const def: ProviderDefinition = {
            type: manifest.id,
            kind,
            name: manifest.name,
            capabilities: manifest.providerMeta.capabilities,
            factory: module.createProvider,
            defaultConfig: manifest.providerMeta.defaultConfig,
            pluginId: manifest.id,
            // 媒体 Provider 必填契约版本；image-hosting / llm 不强制
            contractVersion: requiresMediaContractVersion(kind)
              ? MEDIA_PROVIDER_CONTRACT_VERSION
              : undefined,
          };
          console.log(`[PluginRuntime] Registering provider: ${def.type}, kind: ${def.kind}`);
          providerRegistry.register(def);
        } else {
          console.log(`[PluginRuntime] Provider plugin ${manifest.id} missing createProvider or providerMeta`);
        }
        break;

      case 'mcp':
        // MCP 插件：如果提供了 createMCPServer 工厂
        if (module?.createMCPServer) {
          const server = module.createMCPServer();
          server.pluginId = manifest.id;
          mcpRegistry.registerServer(server);
        }
        break;

      case 'agent':
        // Agent 插件：如果提供了 createAgent 工厂
        if (module?.createAgent) {
          const agent = module.createAgent();
          agent.pluginId = manifest.id;
          agentRegistry.register(agent);
        }
        break;
    }
  }

  /**
   * 停用插件
   */
  async deactivatePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || plugin.status !== 'active') {
      return;
    }

    try {
      // 调用 onDeactivate
      if (plugin.module?.onDeactivate) {
        await plugin.module.onDeactivate();
      }

      // 清理注册的资源
      providerRegistry.unregisterByPlugin(pluginId);
      mcpRegistry.unregisterByPlugin(pluginId);
      agentRegistry.unregisterByPlugin(pluginId);

      plugin.status = 'loaded';
      this.emit('deactivated', pluginId);
      console.log(`[PluginRuntime] Deactivated plugin: ${pluginId}`);

      // 同步 Capability（插件停用后能力不再可用）
      syncProviders();
      syncAllMCP();
    } catch (err: any) {
      console.error(`[PluginRuntime] Error deactivating plugin ${pluginId}:`, err);
    }
  }

  /**
   * 卸载插件
   */
  async unloadPlugin(pluginId: string): Promise<void> {
    await this.deactivatePlugin(pluginId);

    const plugin = this.plugins.get(pluginId);
    if (plugin?.module) {
      // 清除 require 缓存
      const modulePath = path.join(this.pluginsDir, pluginId, plugin.manifest.entry.backend || '');
      delete require.cache[require.resolve(modulePath)];
    }

    this.plugins.delete(pluginId);
    this.emit('unloaded', pluginId);
    console.log(`[PluginRuntime] Unloaded plugin: ${pluginId}`);
  }

  /**
   * 创建插件 API
   */
  private createPluginAPI(manifest: PluginManifest): ElectronPluginAPI {
    const pluginId = manifest.id;
    const pluginDir = path.join(this.pluginsDir, pluginId);
    const dataDir = path.join(pluginDir, 'data');

    return {
      core: {
        getVersion: () => app.getVersion(),
        getPluginDir: () => pluginDir,
        getDataDir: () => dataDir,
      },

      fs: {
        readFile: async (filePath: string) => {
          requirePluginScope(manifest, 'storage:limited', 'fs.readFile');
          const fullPath = this.resolveSandboxPath(dataDir, filePath);
          return fs.readFile(fullPath, 'utf-8');
        },
        writeFile: async (filePath: string, content: string) => {
          requirePluginScope(manifest, 'storage:limited', 'fs.writeFile');
          const fullPath = this.resolveSandboxPath(dataDir, filePath);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, content, 'utf-8');
        },
        deleteFile: async (filePath: string) => {
          requirePluginScope(manifest, 'storage:limited', 'fs.deleteFile');
          const fullPath = this.resolveSandboxPath(dataDir, filePath);
          await fs.unlink(fullPath);
        },
        exists: async (filePath: string) => {
          requirePluginScope(manifest, 'storage:limited', 'fs.exists');
          const fullPath = this.resolveSandboxPath(dataDir, filePath);
          try {
            await fs.access(fullPath);
            return true;
          } catch {
            return false;
          }
        },
        listDir: async (dirPath: string) => {
          requirePluginScope(manifest, 'storage:limited', 'fs.listDir');
          const fullPath = this.resolveSandboxPath(dataDir, dirPath);
          return fs.readdir(fullPath);
        },
      },

      net: {
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          requirePluginScope(manifest, 'network:external', 'net.fetch');
          return globalThis.fetch(input, init);
        }) as typeof fetch,
      },

      spawn: (command: string, args?: string[], options?: SpawnOptions): ChildProcessHandle => {
        requirePluginScope(manifest, 'spawn:process', 'spawn');
        return this.createChildProcess(command, args, options);
      },

      channels: {
        registerProvider: async (def: ProviderDefinition) => {
          def.pluginId = pluginId;
          providerRegistry.register(def);
        },
        unregisterProvider: async (type: string) => {
          providerRegistry.unregister(type);
        },
        listProviders: (kind?: string) => {
          if (kind) {
            return providerRegistry.listByKind(kind as any);
          }
          return providerRegistry.list();
        },
        getProviderConfig: async (type: string) => {
          return getPluginProviderConfig(manifest, type);
        },
        updateProviderConfig: async (type: string, config: Record<string, unknown>) => {
          await savePluginProviderConfig(manifest, type, config);
        },
      },

      mcp: {
        registerServer: async (server: MCPServerDefinition) => {
          server.pluginId = pluginId;
          mcpRegistry.registerServer(server);
        },
        unregisterServer: async (name: string) => {
          mcpRegistry.unregisterServer(name);
        },
        registerTool: async (tool: MCPToolHandler) => {
          tool.definition.pluginId = pluginId;
          mcpRegistry.tools.register(tool);
        },
        unregisterTool: async (name: string) => {
          mcpRegistry.tools.unregister(name);
        },
        registerResource: async (resource: MCPResourceHandler) => {
          resource.definition.pluginId = pluginId;
          mcpRegistry.resources.register(resource);
        },
        unregisterResource: async (uri: string) => {
          mcpRegistry.resources.unregister(uri);
        },
        listTools: () => mcpRegistry.tools.listDefinitions(),
        listResources: () => mcpRegistry.resources.listDefinitions(),
      },

      agents: {
        registerWorker: async (worker: WorkerAgentDefinition) => {
          worker.pluginId = pluginId;
          agentRegistry.register(worker);
        },
        unregisterWorker: async (id: string) => {
          agentRegistry.unregister(id);
        },
        listWorkers: () => agentRegistry.list(),
      },

      capability: {
        list: (filter?: { type?: string; tags?: string[] }) =>
          capabilityRegistry.list(filter as any),
        resolve: (requirements: string[]) =>
          capabilityRegistry.resolve(requirements),
        invoke: (id: string, args: unknown) =>
          capabilityRegistry.invoke(id, args),
      },

      log: {
        debug: (...args) => console.debug(`[Plugin:${pluginId}]`, ...args),
        info: (...args) => console.info(`[Plugin:${pluginId}]`, ...args),
        warn: (...args) => console.warn(`[Plugin:${pluginId}]`, ...args),
        error: (...args) => console.error(`[Plugin:${pluginId}]`, ...args),
      },
    };
  }

  /**
   * 解析沙箱路径（防止路径遍历）
   */
  private resolveSandboxPath(baseDir: string, filePath: string): string {
    const resolved = path.resolve(baseDir, filePath);
    if (!resolved.startsWith(baseDir)) {
      throw new Error('Path traversal detected');
    }
    return resolved;
  }

  /**
   * 创建子进程句柄
   */
  private createChildProcess(command: string, args?: string[], options?: SpawnOptions): ChildProcessHandle {
    const child = spawn(command, args || [], {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      shell: process.platform === 'win32',
    });

    const handle: ChildProcessHandle = {
      pid: child.pid || 0,
      stdout: this.createAsyncIterable(child.stdout),
      stderr: this.createAsyncIterable(child.stderr),
      stdin: {
        write: (data: string) => child.stdin?.write(data),
        end: () => child.stdin?.end(),
      },
      kill: (signal?: string) => child.kill(signal as any),
      wait: () => new Promise((resolve, reject) => {
        child.on('exit', (code) => resolve(code || 0));
        child.on('error', reject);
      }),
    };

    // 超时处理
    if (options?.timeout) {
      setTimeout(() => child.kill(), options.timeout);
    }

    return handle;
  }

  /**
   * 将流转换为异步可迭代对象
   */
  private async *createAsyncIterable(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
    if (!stream) return;

    for await (const chunk of stream) {
      yield chunk.toString();
    }
  }

  /**
   * 获取已加载插件
   */
  getPlugin(pluginId: string): LoadedPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * 获取所有已加载插件
   */
  listPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * 获取活跃插件
   */
  listActivePlugins(): LoadedPlugin[] {
    return this.listPlugins().filter(p => p.status === 'active');
  }
}

export const pluginRuntime = new ElectronPluginRuntime();
