/**
 * Electron-Egg 预加载脚本 (TypeScript)
 */
import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron';

type Listener = (event: IpcRendererEvent, ...args: any[]) => void;

const ALLOWED_INVOKE_CHANNELS = new Set([
  'llm:query', 'llm:queryStream',
  'llm:testConnection',
  'chat:session:create', 'chat:session:get', 'chat:session:dispose',
  'chat:session:list', 'chat:session:updateConfig',
  'chat:message:send', 'chat:message:sendStream', 'chat:message:cancel',
  'chat:mcp:connect', 'chat:mcp:disconnect', 'chat:mcp:list',
  'chat:mcp:listTools', 'chat:mcp:callTool', 'chat:mcp:importConfig', 'chat:mcp:exportConfig',
  'chat:tool:approve', 'chat:tool:reject', 'chat:tool:listPending',
  'chat:tools:list', 'chat:tools:call',
  'chat:capability:list', 'chat:capability:invoke', 'chat:capability:resolve',
  'chat:history:listSessions', 'chat:history:getSession',
  'chat:history:saveSession', 'chat:history:deleteSession',
  // 全局渠道配置 (settings.db)
  'channel:list', 'channel:get', 'channel:count',
  'channel:create', 'channel:update', 'channel:delete', 'channel:bulkImport',
  'channel:setDefault', 'channel:getDefault', 'channel:listDefaults', 'channel:deleteDefault',
  // 全局 KV
  'app-kv:get', 'app-kv:set', 'app-kv:delete',
  // 通用任务系统 (settings.db)
  'tasks:list', 'tasks:get', 'tasks:upsert', 'tasks:delete', 'tasks:cancel',
  'tasks:submit',
  'tasks:removeByScope', 'tasks:removeByTarget', 'tasks:gc',
  'tasks:retention:get', 'tasks:retention:set',
  'tasks:webContentsId',
  'tasks:delegate:claim', 'tasks:delegate:reply',
  // controller/* 显式白名单
  'controller/window/minimize', 'controller/window/maximize',
  'controller/window/close', 'controller/window/isMaximized',
  'controller/dialog/openFile', 'controller/dialog/openDirectory',
  'controller/dialog/saveFile',
  'controller/fs/readFile', 'controller/fs/readFileAsBase64',
  'controller/fs/writeFile', 'controller/fs/downloadFile',
  'controller/fs/exists', 'controller/fs/mkdir', 'controller/fs/readdir',
  'controller/fs/stat', 'controller/fs/remove', 'controller/fs/copy',
  'controller/diagnostics/appendRendererLog', 'controller/diagnostics/listLogs',
  'controller/diagnostics/getUsage', 'controller/diagnostics/clearLogs',
  'controller/diagnostics/clearRendererLogs', 'controller/diagnostics/exportLogs',
  'controller/app/openExternal', 'controller/app/showItemInFolder',
  'controller/app/getPath', 'controller/app/getVersion',
  // 风格参考图（"画风锚"）：全局上传/清除 + 项目级上传/清除 + 路径解析
  'controller/app/getStyleReferenceImagePath',
  'controller/app/getKomaTTSVoiceSamplePath',
  'controller/app/getActiveStyleReferenceImagePath',
  'controller/app/saveStyleReferenceImage',
  'controller/app/clearStyleReferenceImage',
  'controller/app/saveProjectStyleReferenceImage',
  'controller/app/clearProjectStyleReferenceImage',
  'controller/project/setStorageRoot',
  'controller/project/list', 'controller/project/create',
  'controller/project/load', 'controller/project/loadFull',
  'controller/project/save',
  'controller/project/update', 'controller/project/delete',
  'controller/project/rebuildIndex', 'controller/project/export',
  'controller/project/import',
  // 批量实体操作
  'controller/project/saveAllCharacters', 'controller/project/loadAllCharacters',
  'controller/project/saveAllScenes', 'controller/project/loadAllScenes',
  'controller/project/saveAllProps', 'controller/project/loadAllProps',
  'controller/project/saveAllShots', 'controller/project/loadAllShots',
  'controller/project/saveShotMeta', 'controller/project/loadShotMeta',
  'controller/project/listShotMetas',
  'controller/project/saveAnalysis', 'controller/project/loadAnalysis',
  'controller/project/saveProjectTimeline', 'controller/project/loadProjectTimeline',
  'controller/project/saveEpisodeTimeline', 'controller/project/loadEpisodeTimeline',
  'controller/project/bindOwnerRefMedia',
  // 角色
  'controller/project/characterList', 'controller/project/characterGet',
  'controller/project/characterCreate', 'controller/project/characterUpdate',
  'controller/project/characterDelete',
  // 场景
  'controller/project/sceneList', 'controller/project/sceneGet',
  'controller/project/sceneCreate', 'controller/project/sceneUpdate',
  'controller/project/sceneDelete',
  // 道具
  'controller/project/propList', 'controller/project/propGet',
  'controller/project/propCreate', 'controller/project/propUpdate',
  'controller/project/propDelete',
  // 分镜
  'controller/project/shotList', 'controller/project/shotGet',
  'controller/project/shotCreate', 'controller/project/shotUpdate',
  'controller/project/shotDelete',
  'controller/project/shotVersionList', 'controller/project/shotVersionCreate',
  'controller/project/shotVersionDelete', 'controller/project/shotSetVersion',
  // 资产
  'controller/project/assetList', 'controller/project/assetGet',
  'controller/project/assetCreate', 'controller/project/assetUpdate',
  'controller/project/assetDelete',
  'controller/project/assetFindByFingerprint', 'controller/project/assetListUnreferenced',
  // 集数
  'controller/project/episodeList', 'controller/project/episodeGet',
  'controller/project/episodeCreate', 'controller/project/episodeUpdate',
  'controller/project/episodeDelete',
  // 时间线
  'controller/project/timelineGet', 'controller/project/timelineUpdate',
  'controller/project/trackAdd', 'controller/project/trackUpdate',
  'controller/project/trackDelete',
  'controller/project/clipAdd', 'controller/project/clipUpdate',
  'controller/project/clipDelete',
  'controller/ffmpeg/isAvailable', 'controller/ffmpeg/getInfo',
  'controller/ffmpeg/extractFrames', 'controller/ffmpeg/splitGridImage',
  'controller/ffmpeg/waveform',
  'controller/ffmpeg/splitAudio', 'controller/ffmpeg/composeVideo',
  'controller/ffmpeg/getCacheDir', 'controller/ffmpeg/getTempDir',
  'controller/ffmpeg/ensureDir', 'controller/ffmpeg/saveFrame',
  'controller/ffmpeg/cleanupTemp', 'controller/ffmpeg/clearCache',
  'controller/ffmpeg/cancelTask', 'controller/ffmpeg/clearQueue',
	  'controller/plugin/validate', 'controller/plugin/install',
	  'controller/plugin/uninstall', 'controller/plugin/uninstallById',
	  'controller/plugin/list', 'controller/plugin/openFolder',
	  // runtime lifecycle
	  'controller/plugin/activate', 'controller/plugin/deactivate',
	  'controller/plugin/status', 'controller/plugin/listActive',
	  // backend provider invocation (used by image-hosting fallback)
	  'controller/plugin/callProvider',
	  // tools / agents 查询
	  'controller/plugin/listMCPTools', 'controller/plugin/callMCPTool',
	  'controller/plugin/listAgents',
	  'controller/net/fetch',
	  // 主程序自动更新（极简版：只 4 个通道）
	  'controller/updater/getState', 'controller/updater/checkNow',
	  'controller/updater/download', 'controller/updater/installNow',
	  // 插件 marketplace
	  'controller/marketplace/list', 'controller/marketplace/refresh',
	  'controller/marketplace/checkUpdates', 'controller/marketplace/getState',
	  'controller/marketplace/installOrUpdate', 'controller/marketplace/uninstall',
	  'controller/marketplace/setAutoCheck',
	]);

const ALLOWED_LISTEN_CHANNELS = new Set([
  'chat:stream:chunk', 'chat:stream:tool', 'chat:stream:done', 'chat:stream:error',
  'chat:tool:pending', 'chat:tool:approved', 'chat:tool:rejected',
  'llm:stream:chunk', 'llm:stream:done', 'llm:stream:error',
  'channel:changed',
  'tasks:updated',
  'tasks:delegate:request',
  'updater:state-changed',
  'marketplace:state-changed',
  'marketplace:plugin-installed',
]);

function validateInvokeChannel(channel: string): void {
  if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`);
  }
}

function validateListenChannel(channel: string): void {
  if (!ALLOWED_LISTEN_CHANNELS.has(channel)) {
    throw new Error(`IPC listen channel not allowed: ${channel}`);
  }
}

function invokeMain(channel: string, args?: any) {
  validateInvokeChannel(channel);
  return ipcRenderer.invoke(channel, args);
}

const ipc = {
  invoke: (channel: string, args?: any) => {
    return invokeMain(channel, args);
  },
  on: (channel: string, listener: Listener) => {
    validateListenChannel(channel);
    ipcRenderer.on(channel, listener);
  },
  once: (channel: string, listener: Listener) => {
    validateListenChannel(channel);
    ipcRenderer.once(channel, listener);
  },
  removeListener: (channel: string, listener: Listener) => {
    ipcRenderer.removeListener(channel, listener);
  },
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
};

const isEE = true;

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: ipc,
  isEE,
});

contextBridge.exposeInMainWorld('electronAPI', {
  window: {
    minimize: () => invokeMain('controller/window/minimize'),
    maximize: () => invokeMain('controller/window/maximize'),
    close: () => invokeMain('controller/window/close'),
    isMaximized: () => invokeMain('controller/window/isMaximized'),
  },
  dialog: {
    openFile: (options?: any) => invokeMain('controller/dialog/openFile', options),
    openDirectory: () => invokeMain('controller/dialog/openDirectory', {}),
    saveFile: (options?: any) => invokeMain('controller/dialog/saveFile', options),
  },
  fs: {
    readFile: (path: string) => invokeMain('controller/fs/readFile', { filePath: path }),
    readFileAsBase64: (path: string) => invokeMain('controller/fs/readFileAsBase64', { filePath: path }),
    writeFile: (path: string, data: string, binary?: boolean) =>
      invokeMain('controller/fs/writeFile', { filePath: path, data, binary }),
    downloadFile: (url: string, destPath: string, options?: { headers?: Record<string, string>; channelId?: string }) =>
      invokeMain('controller/fs/downloadFile', { url, destPath, ...(options || {}) }),
    exists: (path: string) => invokeMain('controller/fs/exists', { filePath: path }),
    mkdir: (path: string) => invokeMain('controller/fs/mkdir', { dirPath: path }),
    readdir: (path: string) => invokeMain('controller/fs/readdir', { dirPath: path }),
    stat: (path: string) => invokeMain('controller/fs/stat', { filePath: path }),
    remove: (path: string) => invokeMain('controller/fs/remove', { filePath: path }),
    copy: (src: string, dest: string) => invokeMain('controller/fs/copy', { src, dest }),
  },
  diagnostics: {
    appendRendererLog: (payload: any) => invokeMain('controller/diagnostics/appendRendererLog', payload),
    listLogs: () => invokeMain('controller/diagnostics/listLogs', {}),
    getUsage: () => invokeMain('controller/diagnostics/getUsage', {}),
    clearLogs: () => invokeMain('controller/diagnostics/clearLogs', {}),
    clearRendererLogs: () => invokeMain('controller/diagnostics/clearRendererLogs', {}),
    exportLogs: (destPath: string) => invokeMain('controller/diagnostics/exportLogs', { destPath }),
  },
  shell: {
    openExternal: (url: string) => invokeMain('controller/app/openExternal', { url }),
    showItemInFolder: (path: string) => invokeMain('controller/app/showItemInFolder', { filePath: path }),
  },
  app: {
    getPath: (name: string) => invokeMain('controller/app/getPath', { name }),
    getVersion: () => invokeMain('controller/app/getVersion', {}),
  },
  // 渲染进程读取 File 绝对路径的官方 API（Electron 32+ 已移除 File.path 扩展）
  webUtils: {
    getPathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file) || '';
      } catch {
        return '';
      }
    },
  },
  project: {
    setStorageRoot: (rootPath: string) => invokeMain('controller/project/setStorageRoot', { rootPath }),
    list: () => invokeMain('controller/project/list', {}),
    create: (meta: any) => invokeMain('controller/project/create', meta),
    load: (projectId: string) => invokeMain('controller/project/load', { projectId }),
    save: (projectId: string, data: any) => invokeMain('controller/project/save', { projectId, data }),
    update: (projectId: string, updates: any) =>
      invokeMain('controller/project/update', { projectId, updates }),
    remove: (projectId: string) => invokeMain('controller/project/delete', { projectId }),
    rebuildIndex: () => invokeMain('controller/project/rebuildIndex', {}),
    export: (projectId: string, destPath: string, options?: any) =>
      invokeMain('controller/project/export', { projectId, destPath, options }),
    import: (zipPath: string, newProjectId?: string) =>
      invokeMain('controller/project/import', { zipPath, newProjectId }),
    loadFull: (projectId: string) => invokeMain('controller/project/loadFull', { projectId }),
    // 批量实体操作
    saveAllCharacters: (projectId: string, items: any[]) => invokeMain('controller/project/saveAllCharacters', { projectId, items }),
    loadAllCharacters: (projectId: string) => invokeMain('controller/project/loadAllCharacters', { projectId }),
    saveAllScenes: (projectId: string, items: any[]) => invokeMain('controller/project/saveAllScenes', { projectId, items }),
    loadAllScenes: (projectId: string) => invokeMain('controller/project/loadAllScenes', { projectId }),
    saveAllProps: (projectId: string, items: any[]) => invokeMain('controller/project/saveAllProps', { projectId, items }),
    loadAllProps: (projectId: string) => invokeMain('controller/project/loadAllProps', { projectId }),
    saveAllShots: (projectId: string, items: any[]) => invokeMain('controller/project/saveAllShots', { projectId, items }),
    loadAllShots: (projectId: string) => invokeMain('controller/project/loadAllShots', { projectId }),
    saveShotMeta: (projectId: string, shotId: string, meta: any) => invokeMain('controller/project/saveShotMeta', { projectId, shotId, meta }),
    loadShotMeta: (projectId: string, shotId: string) => invokeMain('controller/project/loadShotMeta', { projectId, shotId }),
    listShotMetas: (projectId: string) => invokeMain('controller/project/listShotMetas', { projectId }),
    saveAnalysis: (projectId: string, episodeId: string, analysis: any) => invokeMain('controller/project/saveAnalysis', { projectId, episodeId, analysis }),
    loadAnalysis: (projectId: string, episodeId: string) => invokeMain('controller/project/loadAnalysis', { projectId, episodeId }),
    loadAnalysisSummary: (projectId: string, episodeId: string) => invokeMain('controller/project/loadAnalysisSummary', { projectId, episodeId }),
    loadEpisodeShotsPage: (projectId: string, episodeId: string, limit: number, offset: number) => invokeMain('controller/project/loadEpisodeShotsPage', { projectId, episodeId, limit, offset }),
    saveProjectTimeline: (projectId: string, timeline: any) => invokeMain('controller/project/saveProjectTimeline', { projectId, timeline }),
    loadProjectTimeline: (projectId: string) => invokeMain('controller/project/loadProjectTimeline', { projectId }),
    saveEpisodeTimeline: (projectId: string, episodeId: string, timeline: any) => invokeMain('controller/project/saveEpisodeTimeline', { projectId, episodeId, timeline }),
    loadEpisodeTimeline: (projectId: string, episodeId: string) => invokeMain('controller/project/loadEpisodeTimeline', { projectId, episodeId }),
    bindOwnerRefMedia: (projectId: string, ownerRef: any, asset: any) => invokeMain('controller/project/bindOwnerRefMedia', { projectId, ownerRef, asset }),
    // 角色
    characterList: (projectId: string) => invokeMain('controller/project/characterList', { projectId }),
    characterGet: (id: string) => invokeMain('controller/project/characterGet', { id }),
    characterCreate: (data: any) => invokeMain('controller/project/characterCreate', data),
    characterUpdate: (id: string, data: any) => invokeMain('controller/project/characterUpdate', { id, data }),
    characterDelete: (id: string) => invokeMain('controller/project/characterDelete', { id }),
    // 场景
    sceneList: (projectId: string) => invokeMain('controller/project/sceneList', { projectId }),
    sceneGet: (id: string) => invokeMain('controller/project/sceneGet', { id }),
    sceneCreate: (data: any) => invokeMain('controller/project/sceneCreate', data),
    sceneUpdate: (id: string, data: any) => invokeMain('controller/project/sceneUpdate', { id, data }),
    sceneDelete: (id: string) => invokeMain('controller/project/sceneDelete', { id }),
    // 道具
    propList: (projectId: string) => invokeMain('controller/project/propList', { projectId }),
    propGet: (id: string) => invokeMain('controller/project/propGet', { id }),
    propCreate: (data: any) => invokeMain('controller/project/propCreate', data),
    propUpdate: (id: string, data: any) => invokeMain('controller/project/propUpdate', { id, data }),
    propDelete: (id: string) => invokeMain('controller/project/propDelete', { id }),
    // 分镜
    shotList: (projectId: string) => invokeMain('controller/project/shotList', { projectId }),
    shotGet: (id: string) => invokeMain('controller/project/shotGet', { id }),
    shotCreate: (data: any) => invokeMain('controller/project/shotCreate', data),
    shotUpdate: (id: string, data: any) => invokeMain('controller/project/shotUpdate', { id, data }),
    shotDelete: (id: string) => invokeMain('controller/project/shotDelete', { id }),
    shotVersionList: (shotId: string) => invokeMain('controller/project/shotVersionList', { shotId }),
    shotVersionCreate: (data: any) => invokeMain('controller/project/shotVersionCreate', data),
    shotVersionDelete: (id: string) => invokeMain('controller/project/shotVersionDelete', { id }),
    shotSetVersion: (shotId: string, versionNumber: number) => invokeMain('controller/project/shotSetVersion', { shotId, versionNumber }),
    // 资产
    assetList: (projectId: string) => invokeMain('controller/project/assetList', { projectId }),
    assetGet: (id: string) => invokeMain('controller/project/assetGet', { id }),
    assetCreate: (data: any) => invokeMain('controller/project/assetCreate', data),
    assetUpdate: (id: string, data: any) => invokeMain('controller/project/assetUpdate', { id, data }),
    assetDelete: (id: string) => invokeMain('controller/project/assetDelete', { id }),
    assetFindByFingerprint: (projectId: string, fingerprint: string) => invokeMain('controller/project/assetFindByFingerprint', { projectId, fingerprint }),
    assetListUnreferenced: (projectId: string) => invokeMain('controller/project/assetListUnreferenced', { projectId }),
    // 集数
    episodeList: (projectId: string) => invokeMain('controller/project/episodeList', { projectId }),
    episodeGet: (id: string) => invokeMain('controller/project/episodeGet', { id }),
    episodeCreate: (data: any) => invokeMain('controller/project/episodeCreate', data),
    episodeUpdate: (id: string, data: any) => invokeMain('controller/project/episodeUpdate', { id, data }),
    episodeDelete: (id: string) => invokeMain('controller/project/episodeDelete', { id }),
    // 时间线
    timelineGet: (projectId: string) => invokeMain('controller/project/timelineGet', { projectId }),
    timelineUpdate: (id: string, data: any) => invokeMain('controller/project/timelineUpdate', { id, data }),
    trackAdd: (data: any) => invokeMain('controller/project/trackAdd', data),
    trackUpdate: (id: string, data: any) => invokeMain('controller/project/trackUpdate', { id, data }),
    trackDelete: (id: string) => invokeMain('controller/project/trackDelete', { id }),
    clipAdd: (data: any) => invokeMain('controller/project/clipAdd', data),
    clipUpdate: (id: string, data: any) => invokeMain('controller/project/clipUpdate', { id, data }),
    clipDelete: (id: string) => invokeMain('controller/project/clipDelete', { id }),
  },
  ffmpeg: {
    isAvailable: () => invokeMain('controller/ffmpeg/isAvailable', {}),
    getInfo: (input: string) => invokeMain('controller/ffmpeg/getInfo', { input }),
    extractFrames: (options: any) => invokeMain('controller/ffmpeg/extractFrames', options),
    splitGridImage: (options: any) => invokeMain('controller/ffmpeg/splitGridImage', options),
    waveform: (options: any) => invokeMain('controller/ffmpeg/waveform', options),
    splitAudio: (input: string, output: string) =>
      invokeMain('controller/ffmpeg/splitAudio', { input, output }),
    upscaleImage: (options: any) => invokeMain('controller/ffmpeg/upscaleImage', options),
    composeVideo: (options: any) => invokeMain('controller/ffmpeg/composeVideo', options),
    getCacheDir: (subDir?: string) => invokeMain('controller/ffmpeg/getCacheDir', { subDir }),
    getTempDir: () => invokeMain('controller/ffmpeg/getTempDir', {}),
    ensureDir: (dirPath: string) => invokeMain('controller/ffmpeg/ensureDir', { dirPath }),
    saveFrame: (filePath: string, dataUrl: string) =>
      invokeMain('controller/ffmpeg/saveFrame', { filePath, dataUrl }),
    cleanupTemp: (tempDir: string) => invokeMain('controller/ffmpeg/cleanupTemp', { tempDir }),
    clearCache: (subDir?: string) => invokeMain('controller/ffmpeg/clearCache', { subDir }),
    cancelTask: () => invokeMain('controller/ffmpeg/cancelTask', {}),
    clearQueue: () => invokeMain('controller/ffmpeg/clearQueue', {}),
  },
	  plugin: {
	    validate: (zipPath: string) => invokeMain('controller/plugin/validate', { zipPath }),
	    install: (zipPath: string, manifest: any) =>
	      invokeMain('controller/plugin/install', { zipPath, manifest }),
	    uninstall: (pluginPath: string) => invokeMain('controller/plugin/uninstall', { pluginPath }),
	    list: () => invokeMain('controller/plugin/list', {}),
	    openFolder: (pluginPath: string) => invokeMain('controller/plugin/openFolder', { pluginPath }),
	    activate: (manifest: any) => invokeMain('controller/plugin/activate', { manifest }),
	    deactivate: (pluginId: string) => invokeMain('controller/plugin/deactivate', { pluginId }),
	    status: (pluginId: string) => invokeMain('controller/plugin/status', { pluginId }),
	    listActive: () => invokeMain('controller/plugin/listActive', {}),
	    callProvider: (payload: { kind: string; type: string; method: string; args: any[] }) =>
	      invokeMain('controller/plugin/callProvider', payload),
	  },
  net: {
    fetch: (args: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      multipart?: {
        fields: Array<
          | { kind: 'text'; name: string; value: string }
          | { kind: 'file'; name: string; filename: string; contentType?: string; base64: string; size: number }
        >;
      };
    }) =>
      invokeMain('controller/net/fetch', args),
  },
  llm: {
    query: (request: any) => invokeMain('llm:query', request),
    queryStream: (request: any) => invokeMain('llm:queryStream', request),
    testConnection: (request: any) => invokeMain('llm:testConnection', request),
    onStreamChunk: (callback: (event: any, data: any) => void) => {
      ipcRenderer.on('llm:stream:chunk', callback);
      return () => ipcRenderer.removeListener('llm:stream:chunk', callback);
    },
    onStreamDone: (callback: (event: any, data: any) => void) => {
      ipcRenderer.on('llm:stream:done', callback);
      return () => ipcRenderer.removeListener('llm:stream:done', callback);
    },
    onStreamError: (callback: (event: any, data: any) => void) => {
      ipcRenderer.on('llm:stream:error', callback);
      return () => ipcRenderer.removeListener('llm:stream:error', callback);
    },
  },
  chat: {
    // 会话管理
    createSession: (config?: any) => invokeMain('chat:session:create', { config }),
    getSession: (sessionId: string) => invokeMain('chat:session:get', { sessionId }),
    disposeSession: (sessionId: string) => invokeMain('chat:session:dispose', { sessionId }),
    listSessions: (windowId?: number) => invokeMain('chat:session:list', { windowId }),
    updateSessionConfig: (sessionId: string, config: any) =>
      invokeMain('chat:session:updateConfig', { sessionId, config }),

    // 消息发送
    sendMessage: (sessionId: string, input: any, options?: any) =>
      invokeMain('chat:message:send', { sessionId, input, options }),
    sendMessageStream: (sessionId: string, input: any, options?: any) =>
      invokeMain('chat:message:sendStream', { sessionId, input, options }),
    cancelStream: (requestIdOrSessionId: string) =>
      invokeMain('chat:message:cancel', { sessionId: requestIdOrSessionId }),

    // 流式事件监听
    onStreamChunk: (callback: (event: any, data: any) => void) => {
      ipcRenderer.on('chat:stream:chunk', callback);
      return () => ipcRenderer.removeListener('chat:stream:chunk', callback);
    },
    onStreamTool: (callback: (event: any, data: any) => void) => {
      ipcRenderer.on('chat:stream:tool', callback);
      return () => ipcRenderer.removeListener('chat:stream:tool', callback);
    },
    onStreamDone: (callback: (event: any, data: any) => void) => {
      ipcRenderer.on('chat:stream:done', callback);
      return () => ipcRenderer.removeListener('chat:stream:done', callback);
    },
    onStreamError: (callback: (event: any, data: any) => void) => {
      ipcRenderer.on('chat:stream:error', callback);
      return () => ipcRenderer.removeListener('chat:stream:error', callback);
    },

    // MCP 管理
    mcp: {
      connect: (config: any) => invokeMain('chat:mcp:connect', { config }),
      disconnect: (name: string) => invokeMain('chat:mcp:disconnect', { name }),
      list: (includeTools?: boolean) => invokeMain('chat:mcp:list', { includeTools }),
      listTools: () => invokeMain('chat:mcp:listTools', {}),
      callTool: (name: string, args: any) => invokeMain('chat:mcp:callTool', { name, arguments: args }),
      importConfig: (args: any) => invokeMain('chat:mcp:importConfig', args),
      exportConfig: (args?: any) => invokeMain('chat:mcp:exportConfig', args),
    },

    // 工具调用审批
    toolApproval: {
      approve: (callId: string) => invokeMain('chat:tool:approve', { callId }),
      reject: (callId: string, reason?: string) => invokeMain('chat:tool:reject', { callId, reason }),
      listPending: (sessionId?: string) => invokeMain('chat:tool:listPending', { sessionId }),
      onPending: (callback: (event: any, data: any) => void) => {
        ipcRenderer.on('chat:tool:pending', callback);
        return () => ipcRenderer.removeListener('chat:tool:pending', callback);
      },
      onApproved: (callback: (event: any, data: any) => void) => {
        ipcRenderer.on('chat:tool:approved', callback);
        return () => ipcRenderer.removeListener('chat:tool:approved', callback);
      },
      onRejected: (callback: (event: any, data: any) => void) => {
        ipcRenderer.on('chat:tool:rejected', callback);
        return () => ipcRenderer.removeListener('chat:tool:rejected', callback);
      },
    },

    // 统一工具（合并外部 MCP + 插件内部 MCP）
    tools: {
      list: () => invokeMain('chat:tools:list', {}),
      call: (name: string, args: any) => invokeMain('chat:tools:call', { name, arguments: args }),
    },

    // 统一能力查询
    capability: {
      list: (filter?: any) => invokeMain('chat:capability:list', filter),
      invoke: (id: string, args: any) => invokeMain('chat:capability:invoke', { id, arguments: args }),
      resolve: (requirements: string[]) => invokeMain('chat:capability:resolve', { requirements }),
    },

    // 聊天历史持久化（SQLite settings.db）
    history: {
      listSessions: () => invokeMain('chat:history:listSessions', {}),
      getSession: (sessionId: string) => invokeMain('chat:history:getSession', { sessionId }),
      saveSession: (session: any, messages: any[]) =>
        invokeMain('chat:history:saveSession', { session, messages }),
      deleteSession: (sessionId: string) => invokeMain('chat:history:deleteSession', { sessionId }),
    },
  },
  // 通用后台任务系统（settings.db / tasks 表）
  tasks: {
    list: (query?: any) => invokeMain('tasks:list', query ?? {}),
    get: (id: string) => invokeMain('tasks:get', { id }),
    upsert: (record: any) => invokeMain('tasks:upsert', record),
    delete: (id: string) => invokeMain('tasks:delete', { id }),
    cancel: (id: string, reason?: string) => invokeMain('tasks:cancel', { id, reason }),
    submit: (input: any) => invokeMain('tasks:submit', input),
    removeByScope: (scope: string) => invokeMain('tasks:removeByScope', { scope }),
    removeByTarget: (scope: string, targetKind: string, targetId: string) =>
      invokeMain('tasks:removeByTarget', { scope, targetKind, targetId }),
    gc: () => invokeMain('tasks:gc', {}),
    getRetention: () => invokeMain('tasks:retention:get', {}),
    setRetention: (input: { retentionDays?: number; perScopeLimit?: number }) =>
      invokeMain('tasks:retention:set', input),
    /** 拿当前 renderer 的 webContents id，用于 tasks:updated 广播自写抑制 */
    getWebContentsId: (): Promise<number> => invokeMain('tasks:webContentsId', {}),
    onUpdated: (callback: (event: any, data: any) => void) => {
      ipcRenderer.on('tasks:updated', callback);
      return () => ipcRenderer.removeListener('tasks:updated', callback);
    },
    // ===== delegation：main → renderer 反向调用 =====
    delegate: {
      claim: (types: string[]) => invokeMain('tasks:delegate:claim', { types }),
      reply: (requestId: string, payload: { result?: unknown; error?: string }) =>
        invokeMain('tasks:delegate:reply', { requestId, ...payload }),
      onRequest: (callback: (event: any, data: any) => void) => {
        ipcRenderer.on('tasks:delegate:request', callback);
        return () => ipcRenderer.removeListener('tasks:delegate:request', callback);
      },
    },
  },
  updater: {
    getState: () => invokeMain('controller/updater/getState', {}),
    checkNow: () => invokeMain('controller/updater/checkNow', {}),
    download: () => invokeMain('controller/updater/download', {}),
    installNow: () => invokeMain('controller/updater/installNow', {}),
    onStateChange: (callback: (event: any, data: any) => void) => {
      ipcRenderer.on('updater:state-changed', callback);
      return () => ipcRenderer.removeListener('updater:state-changed', callback);
    },
  },
  marketplace: {
    list: () => invokeMain('controller/marketplace/list', {}),
    refresh: () => invokeMain('controller/marketplace/refresh', {}),
    checkUpdates: () => invokeMain('controller/marketplace/checkUpdates', {}),
    getState: () => invokeMain('controller/marketplace/getState', {}),
    installOrUpdate: (pluginId: string) =>
      invokeMain('controller/marketplace/installOrUpdate', { pluginId }),
    uninstall: (pluginId: string) =>
      invokeMain('controller/marketplace/uninstall', { pluginId }),
    setAutoCheck: (enabled: boolean) =>
      invokeMain('controller/marketplace/setAutoCheck', { enabled }),
    onStateChange: (callback: (event: any, data: any) => void) => {
      ipcRenderer.on('marketplace:state-changed', callback);
      return () => ipcRenderer.removeListener('marketplace:state-changed', callback);
    },
    onPluginInstalled: (callback: (event: any, data: any) => void) => {
      ipcRenderer.on('marketplace:plugin-installed', callback);
      return () => ipcRenderer.removeListener('marketplace:plugin-installed', callback);
    },
  },
});
