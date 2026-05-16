/**
 * 插件 API 实现
 * 为插件提供系统能力访问
 * 重构版：支持 Provider 类注入
 */
import type {
  PluginAPI,
  InstalledPlugin,
  HostInfo,
  ProjectFilter,
  PluginProject,
  PluginPromptTemplate,
  PromptOverride,
  ChannelTestResult,
  DialogOptions,
  ModalOptions,
  MenuItem,
} from '../../types/plugin';
import { validateOperation, validateStoragePath, createSandboxedFetch, hasScope } from './PluginSandbox';
import { electronService } from '../electronService';
import { message, Modal } from 'antd';
import { createLogger } from '../../store/logger';
import type { ChannelCapability } from '../../providers/registry.types';
import type { ChannelModelDefinition } from '../../providers/channel/types';
import { isModelCapability } from '../../providers/channel/types';

function inferPluginCategory(kind: string): 'tti' | 'itv' | 'tts' | 'image-hosting' {
  switch (kind) {
    case 'itv':
      return 'itv';
    case 'tts':
      return 'tts';
    case 'image-hosting':
      return 'image-hosting';
    default:
      return 'tti';
  }
}

function inferPluginCategoryFromCapabilities(
  capabilities: string[] | undefined,
): 'tti' | 'itv' | 'tts' | 'image-hosting' {
  if (capabilities?.includes('image-hosting')) {
    return 'image-hosting';
  }
  if (capabilities?.includes('tts')) {
    return 'tts';
  }
  if (capabilities?.includes('itv')) {
    return 'itv';
  }
  return 'tti';
}

const logger = createLogger('PluginAPI');
import {
  registerProvider,
  unregisterProvider,
  unregisterProvidersByPlugin,
  listProviders,
  createProviderInstance,
  type ProviderDefinition,
  type ChannelKind,
} from '../../providers/registry';
import {
  getPromptTemplate,
  loadPromptTemplates,
  saveCustomTemplate,
} from '../../store/promptTemplates';
import { loadSettings, saveSettings } from '../../store/settings/core';
import { listProjects, loadProject, saveProject } from '../../store/projectStore';
import {
  getChannelConfigs,
  updateChannelConfig,
  addChannelConfig,
  deleteChannelsByPlugin,
  deleteChannelByProviderType,
} from '../../store/settings/channelConfig';
import packageJson from '../../../package.json';

// 事件监听器
const eventListeners = new Map<string, Map<string, Set<Function>>>();

// 动态菜单项
const dynamicMenuItems = new Map<string, MenuItem[]>();

// 插件注册的 Provider 类型（用于卸载时清理）
const pluginProviderTypes = new Map<string, string[]>();

function normalizeProviderModels(def: ProviderDefinition<any>): ChannelModelDefinition[] | undefined {
  if (def.kind === 'image-hosting') {
    return undefined;
  }

  if (!def.models?.length) {
    throw new Error(`插件 Provider "${def.type}" 必须声明至少一个模型`);
  }

  return def.models.map((model) => {
    if (!model.id || !model.label) {
      throw new Error(`插件 Provider "${def.type}" 的模型必须包含 id 和 label`);
    }

    const capabilities = (model.capabilities || []).filter(isModelCapability);
    if (!capabilities.length) {
      throw new Error(`插件 Provider "${def.type}" 的模型 "${model.id}" 缺少有效能力声明`);
    }

    return {
      id: model.id,
      label: model.label,
      description: model.description,
      capabilities,
      defaults: model.defaults,
    };
  });
}

function resolveProviderChannelCapabilities(def: ProviderDefinition<any>): ChannelCapability[] {
  return (def.capabilities?.length ? def.capabilities : [def.kind]) as ChannelCapability[];
}

function findRegisteredPluginProviderDefinition(
  type: string,
  pluginId: string,
): ProviderDefinition<any> | undefined {
  return listProviders().find((def) => def.type === type && def.pluginId === pluginId);
}

/**
 * 创建插件专用的 API 实例
 */
export function createPluginAPI(plugin: InstalledPlugin): PluginAPI {
  const pluginId = plugin.id;

  return {
    // ========== Core ==========
    core: {
      async getVersion() {
        return packageJson.version;
      },

      async getHostInfo(): Promise<HostInfo> {
        return {
          appVersion: packageJson.version,
          platform: process.platform as 'win32' | 'darwin' | 'linux',
          electronVersion: process.versions.electron || 'unknown',
        };
      },

      on(event, handler) {
        if (!eventListeners.has(pluginId)) {
          eventListeners.set(pluginId, new Map());
        }
        const pluginEvents = eventListeners.get(pluginId)!;
        if (!pluginEvents.has(event)) {
          pluginEvents.set(event, new Set());
        }
        pluginEvents.get(event)!.add(handler);
      },

      off(event, handler) {
        const pluginEvents = eventListeners.get(pluginId);
        if (pluginEvents?.has(event)) {
          pluginEvents.get(event)!.delete(handler);
        }
      },
    },

    // ========== Settings ==========
    settings: {
      async get(keys?: string[]) {
        const result = validateOperation(plugin, 'settings.get', 'settings:read');
        if (!result.allowed) {
          throw new Error(result.reason);
        }

        // 从 globalStore 读取设置（简化版：返回基础状态）
        const state = await loadSettings();

        if (!keys || keys.length === 0) {
          const countByCategory = (category: string) => (
            (state.channelConfigs || []).filter(channel => channel.category === category).length
          );
          // 返回所有设置（排除敏感信息）
          return {
            llmConfigCount: countByCategory('llm'),
            ttiConfigCount: countByCategory('tti'),
            itvConfigCount: countByCategory('itv'),
            ttsConfigCount: countByCategory('tts'),
          };
        }

        // 返回指定的设置
        const result2: Record<string, any> = {};
        for (const key of keys) {
          if (key in state && !isSensitiveKey(key)) {
            result2[key] = (state as any)[key];
          }
        }
        return result2;
      },

      async set(patch: Record<string, any>) {
        const result = validateOperation(plugin, 'settings.set', 'settings:write');
        if (!result.allowed) {
          throw new Error(result.reason);
        }

        // 过滤敏感字段
        const safePatch: Record<string, any> = {};
        for (const [key, value] of Object.entries(patch)) {
          if (!isSensitiveKey(key)) {
            safePatch[key] = value;
          }
        }

        // 应用设置变更 - 加载当前设置并合并
        const current = await loadSettings();
        await saveSettings({ ...current, ...safePatch });

        // 触发事件
        emitPluginEvent('settingsChanged', safePatch);
      },
    },

    // ========== Projects ==========
    projects: {
      async list(_filter?: ProjectFilter): Promise<PluginProject[]> {
        const result = validateOperation(plugin, 'projects.list', 'projects:read');
        if (!result.allowed) {
          throw new Error(result.reason);
        }

        const projects = await listProjects();

        return projects.map(p => ({
          id: p.id,
          name: p.title,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt || p.createdAt,
        }));
      },

      async get(projectId: string): Promise<PluginProject> {
        const result = validateOperation(plugin, 'projects.get', 'projects:read');
        if (!result.allowed) {
          throw new Error(result.reason);
        }

        const project = await loadProject(projectId);

        if (!project) {
          throw new Error(`项目不存在: ${projectId}`);
        }

        return {
          id: project.id,
          name: project.title,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt || project.createdAt,
        };
      },

      async update(projectId: string, mutation: Partial<PluginProject>) {
        const result = validateOperation(plugin, 'projects.update', 'projects:write');
        if (!result.allowed) {
          throw new Error(result.reason);
        }

        const currentProject = await loadProject(projectId);
        if (currentProject) {
          const updated = {
            ...currentProject,
            updatedAt: mutation.updatedAt ?? Date.now(),
            ...(typeof mutation.name === 'string' ? { title: mutation.name } : {}),
          };
          await saveProject(updated);
        }

        emitPluginEvent('projectChanged', { projectId, mutation });
      },
    },

    // ========== Prompts ==========
    prompts: {
      async getTemplate(id: string): Promise<PluginPromptTemplate> {
        // Cast to PromptTemplateType - caller must ensure valid template id
        const template = await getPromptTemplate(id as any);

        return {
          id: template.id,
          name: template.name,
          template: template.template,
          variables: (template.variables || []).map(variableItem => variableItem.name),
        };
      },

      async listTemplates(): Promise<PluginPromptTemplate[]> {
        const templates = await loadPromptTemplates();

        return Object.values(templates).map(t => ({
          id: t.id,
          name: t.name,
          template: t.template,
          variables: (t.variables || []).map(variableItem => variableItem.name),
        }));
      },

      async override(payload: PromptOverride) {
        const result = validateOperation(plugin, 'prompts.override', 'prompts:override');
        if (!result.allowed) {
          throw new Error(result.reason);
        }

        const existing = await getPromptTemplate(payload.templateId as any);
        if (!existing) {
          throw new Error(`模板不存在: ${payload.templateId}`);
        }

        // Save the overridden template
        // Note: priority field is reserved for future multi-plugin override ordering
        await saveCustomTemplate({
          ...existing,
          template: payload.newTemplate,
        });

        const pluginLogger = createLogger('PluginAPI');
        pluginLogger.info(`Plugin "${pluginId}" overrode template "${payload.templateId}"`);
      },
    },

    // ========== Channels (重构版：Provider 注入) ==========
    channels: {
      /**
       * 注册 Provider（新 API）
       * 插件通过此方法注册自定义 Provider 类
       */
      async registerProvider(def: ProviderDefinition<any>) {
        // 验证权限
        const result = validateOperation(plugin, 'channels.registerProvider', 'network:external');
        if (!result.allowed) {
          throw new Error(result.reason);
        }

        const normalizedModels = normalizeProviderModels(def);
        const channelCapabilities = resolveProviderChannelCapabilities(def);

        // 添加 pluginId 标识
        def.pluginId = pluginId;

        logger.info('插件注册 Provider', {
          pluginId,
          kind: def.kind,
          type: def.type,
          capabilities: def.capabilities,
        });

        // 注册到 Registry
        registerProvider(def);

        // 记录 Provider 类型（卸载时清理）
        if (!pluginProviderTypes.has(pluginId)) {
          pluginProviderTypes.set(pluginId, []);
        }
        pluginProviderTypes.get(pluginId)!.push(def.type);

        // 检查是否已存在渠道配置（避免重复创建）
        const existingConfigs = await getChannelConfigs();
        const existingChannel = existingConfigs.find(
          c => c.providerType === def.type && c.pluginId === pluginId
        );

        if (existingChannel) {
          // 更新已存在配置的属性（确保 capabilities 等字段正确）
          await updateChannelConfig(existingChannel.id, {
            name: def.name,
            description: def.description,
            defaultModelId: existingChannel.defaultModelId && normalizedModels?.some((model) => model.id === existingChannel.defaultModelId)
              ? existingChannel.defaultModelId
              : normalizedModels?.[0]?.id,
            models: normalizedModels,
            capabilities: channelCapabilities,
            polling: def.polling,
            enabled: true,
          });
          // 触发事件通知 UI 刷新
          emitPluginEvent('providerRegistered', { pluginId, providerType: def.type });
          return;
        }

        // 创建对应的渠道配置（失败时回滚）
        try {
          await addChannelConfig({
            name: def.name,
            description: def.description,
            category: inferPluginCategory(def.kind),
            providerType: def.type,
            providerConfig: def.defaultConfig || {},
            defaultModelId: normalizedModels?.[0]?.id,
            models: normalizedModels ?? [],
            capabilities: channelCapabilities,
            polling: def.polling,
            enabled: true,
            source: 'plugin',
            pluginId,
          });
        } catch (err) {
          logger.error('渠道配置创建失败', err);
          // 回滚：移除已注册的 Provider
          unregisterProvider(def.kind, def.type);
          const types = pluginProviderTypes.get(pluginId);
          if (types) {
            const idx = types.indexOf(def.type);
            if (idx >= 0) types.splice(idx, 1);
          }
          throw err;
        }

        // 触发事件通知 UI 刷新
        emitPluginEvent('providerRegistered', { pluginId, providerType: def.type });
      },

      /**
       * 反注册 Provider
       */
      async unregisterProvider(type: string) {
        const def = listProviders().find(p => p.type === type);
        if (def && def.pluginId === pluginId) {
          unregisterProvider(def.kind, type);

          // 从记录中移除
          const types = pluginProviderTypes.get(pluginId);
          if (types) {
            const idx = types.indexOf(type);
            if (idx >= 0) types.splice(idx, 1);
          }

          // 清理对应的渠道配置
          await deleteChannelByProviderType(type, pluginId);
        }
      },

      /**
       * 更新 Provider 配置
       * 插件 UI 保存配置后调用此方法同步到 channelConfig.providerConfig
       * 如果配置不存在则自动创建
       */
      async updateProviderConfig(type: string, config: Record<string, any>) {
        const result = validateOperation(plugin, 'channels.updateProviderConfig', 'network:external');
        if (!result.allowed) {
          throw new Error(result.reason);
        }

        const configs = await getChannelConfigs();
        let channelConfig = configs.find(
          c => c.providerType === type && c.pluginId === pluginId
        );
        const providerDefinition = findRegisteredPluginProviderDefinition(type, pluginId);
        const normalizedModels = providerDefinition ? normalizeProviderModels(providerDefinition) : undefined;
        const channelCapabilities = providerDefinition
          ? resolveProviderChannelCapabilities(providerDefinition)
          : (plugin.providerMeta?.capabilities || []) as ChannelCapability[];
        if (!providerDefinition && inferPluginCategoryFromCapabilities(channelCapabilities as string[]) !== 'image-hosting') {
          throw new Error(`插件 Provider "${type}" 尚未注册模型定义，无法写入配置`);
        }

        if (!channelConfig) {
          channelConfig = await addChannelConfig({
            name: plugin.name || type,
            description: plugin.description,
            category: inferPluginCategoryFromCapabilities(channelCapabilities as string[]),
            providerType: type,
            providerConfig: config,
            defaultModelId: normalizedModels?.[0]?.id,
            models: normalizedModels ?? [],
            capabilities: channelCapabilities,
            enabled: true,
            source: 'plugin',
            pluginId: pluginId,
          });
          return;
        }

        // 更新 providerConfig
        await updateChannelConfig(channelConfig.id, {
          providerConfig: config,
          defaultModelId: channelConfig.defaultModelId && normalizedModels?.some((model) => model.id === channelConfig.defaultModelId)
            ? channelConfig.defaultModelId
            : normalizedModels?.[0]?.id,
          models: normalizedModels,
          capabilities: channelCapabilities,
        });

      },

      /**
       * 获取 Provider 配置
       * 从 channelConfig.providerConfig 读取配置
       */
      async getProviderConfig(type: string): Promise<Record<string, any> | null> {
        const configs = await getChannelConfigs();
        const channelConfig = configs.find(
          c => c.providerType === type && c.pluginId === pluginId
        );

        if (!channelConfig) {
          return null;
        }

        return channelConfig.providerConfig || {};
      },

      /**
       * 列出所有 Provider
       */
      async listProviders(kind?: ChannelKind) {
        return listProviders(kind);
      },

      /**
       * 测试 Provider（需要指定 kind）
       */
      async testProvider(kind: ChannelKind, type: string, config: Record<string, any>): Promise<ChannelTestResult> {
        const start = Date.now();

        try {
          const provider = createProviderInstance<{ testConnection?: () => Promise<boolean> }>(kind, type, config, {
            sandboxedFetch: createSandboxedFetch(plugin),
            pluginId,
          });

          if (typeof provider.testConnection === 'function') {
            const success = await provider.testConnection();
            return {
              success,
              latency: Date.now() - start,
              error: success ? undefined : '连接测试失败',
            };
          }

          return {
            success: true,
            latency: Date.now() - start,
          };
        } catch (err: any) {
          return {
            success: false,
            latency: Date.now() - start,
            error: err.message,
          };
        }
      },

      async test(channelId: string): Promise<ChannelTestResult> {
        const configs = await getChannelConfigs();
        const config = configs.find(c => c.id === channelId);

        if (!config) {
          return { success: false, latency: 0, error: '渠道不存在' };
        }

        // 从 capabilities 推断 kind
        const kind: ChannelKind = config.capabilities?.includes('tts') ? 'tts'
          : config.capabilities?.includes('itv') ? 'itv'
          : 'tti';

        return this.testProvider(kind, config.providerType, config.providerConfig);
      },


      async invoke(channelId: string, action: string, params: any) {
        // Validate permission
        const result = validateOperation(plugin, 'channels.invoke', 'network:external');
        if (!result.allowed) {
          throw new Error(result.reason);
        }

        // Find channel config
        const configs = await getChannelConfigs();
        const config = configs.find(c => c.id === channelId);

        if (!config) {
          throw new Error(`频道不存在: ${channelId}`);
        }

        // Determine kind from capabilities (tts, itv, or tti)
        const kind: ChannelKind = config.capabilities?.includes('tts') ? 'tts'
          : config.capabilities?.includes('itv') ? 'itv'
          : 'tti';

        // Create provider instance
        const provider = createProviderInstance<any>(kind, config.providerType, config.providerConfig || {}, {
          sandboxedFetch: createSandboxedFetch(plugin),
          pluginId,
        });

        // Validate action exists on provider
        if (typeof provider[action] !== 'function') {
          throw new Error(`服务商 ${config.providerType} 不支持操作 "${action}"`);
        }

        // Call the action
        const actionParams = Array.isArray(params) ? params : [params];
        return await provider[action](...actionParams);
      },
    },

    // ========== Storage ==========
    storage: {
      async readFile(path: string): Promise<ArrayBuffer> {
        const validation = validateStoragePath(plugin, path);
        if (!validation.valid) {
          throw new Error(validation.error);
        }

        const data = await electronService.fs.readFile(validation.fullPath!);
        return new TextEncoder().encode(data).buffer;
      },

      async writeFile(path: string, data: ArrayBuffer) {
        const validation = validateStoragePath(plugin, path);
        if (!validation.valid) {
          throw new Error(validation.error);
        }

        // 确保目录存在
        const dir = validation.fullPath!.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        const dirExists = await electronService.fs.exists(dir);
        if (!dirExists) {
          await electronService.fs.mkdir(dir);
        }

        const text = new TextDecoder().decode(data);
        await electronService.fs.writeFile(validation.fullPath!, text);
      },

      async deleteFile(path: string) {
        const validation = validateStoragePath(plugin, path);
        if (!validation.valid) {
          throw new Error(validation.error);
        }

        await electronService.fs.remove(validation.fullPath!);
      },

      async listFiles(dir: string): Promise<string[]> {
        const validation = validateStoragePath(plugin, dir);
        if (!validation.valid) {
          throw new Error(validation.error);
        }

        // 检查目录是否存在
        const exists = await electronService.fs.exists(validation.fullPath!);
        if (!exists) {
          return [];
        }

        return electronService.fs.readdir(validation.fullPath!);
      },

      async openDialog(options: DialogOptions): Promise<string[]> {
        if (!hasScope(plugin, 'storage:limited')) {
          throw new Error('插件没有存储权限');
        }

        // Use the appropriate dialog method based on options
        if (options.directory) {
          const result = await electronService.dialog.openDirectory();
          return result.filePaths || [];
        } else {
          const result = await electronService.dialog.openFile({
            title: options.title,
            filters: options.filters,
          });
          return result.filePaths || [];
        }
      },
    },

    // ========== UI ==========
    ui: {
      showMessage(type, content) {
        message[type](content);
      },

      async showModal(options: ModalOptions): Promise<boolean> {
        return new Promise((resolve) => {
          Modal.confirm({
            title: options.title,
            content: options.content,
            okText: options.okText || '确定',
            cancelText: options.cancelText || '取消',
            width: options.width,
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          });
        });
      },

      registerMenuItem(item: MenuItem) {
        if (!dynamicMenuItems.has(pluginId)) {
          dynamicMenuItems.set(pluginId, []);
        }
        dynamicMenuItems.get(pluginId)!.push(item);
      },

      removeMenuItem(key: string) {
        const items = dynamicMenuItems.get(pluginId);
        if (items) {
          const idx = items.findIndex(i => i.key === key);
          if (idx >= 0) {
            items.splice(idx, 1);
          }
        }
      },
    },
  };
}

// ========== 辅助函数 ==========

/**
 * 检查是否是敏感配置项
 */
function isSensitiveKey(key: string): boolean {
  const sensitivePatterns = [
    'apiKey', 'apiSecret', 'token', 'password', 'credential',
    'secret', 'private', 'auth',
  ];
  return sensitivePatterns.some(p => key.toLowerCase().includes(p.toLowerCase()));
}

/**
 * 触发插件事件
 */
export function emitPluginEvent(event: string, data: any): void {
  for (const [pluginId, events] of eventListeners) {
    const handlers = events.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          logger.error(`事件处理器执行失败 (${pluginId})`, err);
        }
      }
    }
  }
}

/**
 * 获取插件注册的菜单项
 */
export function getPluginMenuItems(pluginId: string): MenuItem[] {
  return dynamicMenuItems.get(pluginId) || [];
}

/**
 * 清理插件的所有资源
 * 包括事件监听、菜单项、Provider 注册
 */
export async function cleanupPluginResources(pluginId: string): Promise<void> {
  eventListeners.delete(pluginId);
  dynamicMenuItems.delete(pluginId);

  // 清理 Provider 注册
  unregisterProvidersByPlugin(pluginId);

  // 清理插件的渠道配置
  await deleteChannelsByPlugin(pluginId);

  // 清理记录
  pluginProviderTypes.delete(pluginId);

}
