/**
 * Electron API 服务封装
 * 在浏览器环境下提供 fallback 实现
 */
import type { MediaModelSelection, MediaOwnerRef, ProjectStyleSnapshot, StoredMediaAsset } from '../types';
import { toKomaLocalUrl } from '../utils/urlUtils';

// 类型定义
export interface ProjectMeta {
  id: string;
  title: string;
  genre: string;
  mode: 'drama' | 'narration';
  status?: 'script' | 'storyboard' | 'generating' | 'completed';
  thumbnail?: string;
  episodes?: number;
  createdAt: number;
  updatedAt: number;
  mediaSelections?: Partial<Record<'llm' | 'tti' | 'itv' | 'tts', MediaModelSelection>>;
  stylePresetId?: string;
  styleSnapshot?: ProjectStyleSnapshot;
  aspectRatio?: '16:9' | '9:16';
  // 主题风格
  theme?: string;
  stylePrompt?: string;
}

interface ElectronAPI {
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean | { isMaximized: boolean }>;
  };
  dialog: {
    openFile: (options?: OpenFileOptions) => Promise<OpenDialogResult>;
    openDirectory: () => Promise<OpenDialogResult>;
    saveFile: (options?: SaveFileOptions) => Promise<SaveDialogResult>;
  };
  fs: {
    readFile: (path: string) => Promise<string | { content: string }>;
    readFileAsBase64: (path: string) => Promise<string | { base64: string }>;
    writeFile: (path: string, data: string, binary?: boolean) => Promise<void>;
    downloadFile: (url: string, destPath: string, options?: { headers?: Record<string, string>; channelId?: string }) => Promise<{ success: boolean; size: number; path?: string; mimeType?: string }>;
    exists: (path: string) => Promise<boolean | { exists: boolean }>;
    mkdir: (path: string) => Promise<void>;
    readdir: (path: string) => Promise<string[] | { files: string[] }>;
    stat: (path: string) => Promise<FileStat>;
    remove: (path: string) => Promise<void>;
    copy: (src: string, dest: string) => Promise<void>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
    showItemInFolder: (path: string) => Promise<void>;
  };
  app: {
    getPath: (name: string) => Promise<string | { path: string }>;
    getVersion: () => Promise<string | { version: string }>;
    getBusinessRoot?: () => Promise<string | { path: string }>;
    checkLegacyDataMigration?: () => Promise<{
      needsMigration: boolean;
      oldPath: string;
      newPath: string;
      hasContent: boolean;
    }>;
  };
  diagnostics?: {
    appendRendererLog: (payload: DiagnosticsRendererLogPayload) => Promise<{ success: boolean }>;
    listLogs: () => Promise<DiagnosticsLogSummary>;
    getUsage: () => Promise<DiagnosticsUsageSummary>;
    clearLogs: () => Promise<{ success: boolean; removed: number }>;
    clearRendererLogs: () => Promise<{ success: boolean; removed: number }>;
    exportLogs: (destPath: string) => Promise<DiagnosticsExportResult>;
  };
  project: {
    setStorageRoot: (rootPath: string) => Promise<{ success: boolean; rootPath: string }>;
    list: () => Promise<ProjectMeta[]>;
    create: (meta: ProjectMeta) => Promise<ProjectMeta>;
    load: (projectId: string) => Promise<ProjectMeta>;
    loadFull: (projectId: string) => Promise<any>;
    bindOwnerRefMedia: (projectId: string, ownerRef: MediaOwnerRef, asset: StoredMediaAsset) => Promise<{ success: boolean }>;
    save: (projectId: string, data: any) => Promise<{ success: boolean }>;
    update: (projectId: string, updates: Partial<ProjectMeta>) => Promise<ProjectMeta>;
    remove: (projectId: string) => Promise<{ success: boolean }>;
    rebuildIndex: () => Promise<any>;
    export: (projectId: string, destPath: string, options?: ExportOptions) => Promise<{ success: boolean; path: string }>;
    import: (zipPath: string, newProjectId?: string) => Promise<{ success: boolean; projectId: string; meta: ProjectMeta }>;
    // 实体 CRUD
    characterList: (projectId: string) => Promise<any[]>;
    characterGet: (id: string) => Promise<any>;
    characterCreate: (data: any) => Promise<any>;
    characterUpdate: (id: string, data: any) => Promise<any>;
    characterDelete: (id: string) => Promise<any>;
    sceneList: (projectId: string) => Promise<any[]>;
    sceneGet: (id: string) => Promise<any>;
    sceneCreate: (data: any) => Promise<any>;
    sceneUpdate: (id: string, data: any) => Promise<any>;
    sceneDelete: (id: string) => Promise<any>;
    propList: (projectId: string) => Promise<any[]>;
    propGet: (id: string) => Promise<any>;
    propCreate: (data: any) => Promise<any>;
    propUpdate: (id: string, data: any) => Promise<any>;
    propDelete: (id: string) => Promise<any>;
    shotList: (projectId: string) => Promise<any[]>;
    shotGet: (id: string) => Promise<any>;
    shotCreate: (data: any) => Promise<any>;
    shotUpdate: (id: string, data: any) => Promise<any>;
    shotDelete: (id: string) => Promise<any>;
    shotVersionList: (shotId: string) => Promise<any[]>;
    shotVersionCreate: (data: any) => Promise<any>;
    shotVersionDelete: (id: string) => Promise<any>;
    shotSetVersion: (shotId: string, versionNumber: number) => Promise<any>;
    assetList: (projectId: string) => Promise<any[]>;
    assetGet: (id: string) => Promise<any>;
    assetCreate: (data: any) => Promise<any>;
    assetUpdate: (id: string, data: any) => Promise<any>;
    assetDelete: (id: string) => Promise<any>;
    assetFindByFingerprint: (projectId: string, fingerprint: string) => Promise<any>;
    assetListUnreferenced: (projectId: string) => Promise<any[]>;
    episodeList: (projectId: string) => Promise<any[]>;
    episodeGet: (id: string) => Promise<any>;
    episodeCreate: (data: any) => Promise<any>;
    episodeUpdate: (id: string, data: any) => Promise<any>;
    episodeDelete: (id: string) => Promise<any>;
    timelineGet: (projectId: string) => Promise<any>;
    timelineUpdate: (id: string, data: any) => Promise<any>;
    trackAdd: (data: any) => Promise<any>;
    trackUpdate: (id: string, data: any) => Promise<any>;
    trackDelete: (id: string) => Promise<any>;
    clipAdd: (data: any) => Promise<any>;
    clipUpdate: (id: string, data: any) => Promise<any>;
    clipDelete: (id: string) => Promise<any>;
  };
  updater?: {
    getState: () => Promise<UpdaterStateDto>;
    checkNow: () => Promise<UpdaterStateDto>;
    download: () => Promise<{ success: boolean }>;
    installNow: () => Promise<{ success: boolean }>;
    onStateChange: (cb: (e: unknown, state: UpdaterStateDto) => void) => () => void;
  };
  marketplace?: {
    list: () => Promise<{ items: MarketplacePluginItem[] }>;
    refresh: () => Promise<MarketplaceStateDto>;
    checkUpdates: () => Promise<{ items: MarketplacePluginItem[] }>;
    getState: () => Promise<MarketplaceStateDto>;
    installOrUpdate: (pluginId: string) => Promise<{ success: boolean }>;
    uninstall: (pluginId: string) => Promise<{ success: boolean }>;
    setAutoCheck: (enabled: boolean) => Promise<{ success: boolean }>;
    onStateChange: (cb: (e: unknown, state: MarketplaceStateDto) => void) => () => void;
    onPluginInstalled: (cb: (e: unknown, payload: { pluginId: string; version: string }) => void) => () => void;
  };
}

export interface UpdaterStateDto {
  kind: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'failed';
  currentVersion: string;
  availableVersion?: string;
  downloadProgress?: number;
  error?: { message: string; detail?: string };
}

export interface MarketplacePluginItem {
  entry: {
    id: string;
    name: string;
    latestVersion: string;
    category?: string;
    iconUrl?: string;
    description?: string;
    downloadUrl: string;
    sha512: string;
    engine?: {
      minAppVersion?: string;
      maxAppVersion?: string;
      apiVersion?: string;
    };
  };
  installed: boolean;
  installedVersion?: string;
  hasUpdate: boolean;
  incompatibleReason?: string;
}

export interface MarketplaceStateDto {
  installing: string[];
  uninstalling: string[];
  lastCheckedAt?: string;
  lastError?: string;
}

type ElectronBridgeWindow = Window & {
  electronAPI?: ElectronAPI;
  electron?: {
    ipcRenderer?: {
      invoke: (channel: string, args?: unknown) => Promise<unknown>;
    };
  };
};

interface OpenFileOptions {
  filters?: { name: string; extensions: string[] }[];
  multiple?: boolean;
  title?: string;
}

interface SaveFileOptions {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
  title?: string;
}

interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

interface SaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

interface FileStat {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  createdAt: number;
  modifiedAt: number;
}

interface ExportOptions {
  excludeCache?: boolean;
  excludeTemp?: boolean;
}

export type DiagnosticsLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DiagnosticsRendererLogPayload {
  level: DiagnosticsLogLevel;
  category: string;
  message: string;
  data?: unknown;
  timestamp?: string;
  source?: 'logger' | 'console' | 'error';
}

export interface DiagnosticsLogFileInfo {
  name: string;
  relativePath: string;
  size: number;
  modifiedAt: number;
  kind: 'renderer' | 'main' | 'electron' | 'other';
}

export interface DiagnosticsLogSummary {
  storageRoot: string;
  logsDir: string;
  electronLogsDir: string;
  files: DiagnosticsLogFileInfo[];
  totalSize: number;
}

export interface DiagnosticsUsageSummary {
  storageRoot: string;
  logsDir: string;
  totalSize: number;
  fileCount: number;
}

export interface DiagnosticsExportResult {
  success: boolean;
  path: string;
  fileCount: number;
  totalSize: number;
}

// 检测是否在 Electron 环境中
export const isElectron = (): boolean => {
  return typeof window !== 'undefined' && 'electronAPI' in (window as ElectronBridgeWindow);
};

// 统一路径斜杠为 /（跨平台兼容）
export const normalizePath = (path: string): string => {
  if (!path) return path;
  return path.replace(/\\/g, '/');
};

// 获取 Electron API（如果可用）
const getElectronAPI = (): ElectronAPI | null => {
  if (typeof window === 'undefined') return null;
  return (window as ElectronBridgeWindow).electronAPI ?? null;
};

// ========== 窗口控制 ==========

export const windowMinimize = async (): Promise<void> => {
  const api = getElectronAPI();
  if (api) {
    await api.window.minimize();
  }
};

export const windowMaximize = async (): Promise<void> => {
  const api = getElectronAPI();
  if (api) {
    await api.window.maximize();
  }
};

export const windowClose = async (): Promise<void> => {
  const api = getElectronAPI();
  if (api) {
    await api.window.close();
  } else {
    window.close();
  }
};

export const windowIsMaximized = async (): Promise<boolean> => {
  const api = getElectronAPI();
  if (api) {
    const result = await api.window.isMaximized();
    return typeof result === 'object' && result !== null && 'isMaximized' in result
      ? Boolean(result.isMaximized)
      : Boolean(result);
  }
  return false;
};

// ========== 文件对话框 ==========

export const openFileDialog = async (
  options?: OpenFileOptions
): Promise<OpenDialogResult> => {
  const api = getElectronAPI();
  if (api) {
    return await api.dialog.openFile(options);
  }
  // 浏览器 fallback: 使用 input[type=file]
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (options?.multiple) {
      input.multiple = true;
    }
    if (options?.filters) {
      const extensions = options.filters.flatMap((f) => f.extensions);
      input.accept = extensions.map((e) => `.${e}`).join(',');
    }
    input.onchange = () => {
      const files = input.files;
      if (files && files.length > 0) {
        // 浏览器环境下无法获取真实路径，返回文件名
        resolve({
          canceled: false,
          filePaths: Array.from(files).map((f) => f.name),
        });
      } else {
        resolve({ canceled: true, filePaths: [] });
      }
    };
    input.click();
  });
};

export const openDirectoryDialog = async (): Promise<OpenDialogResult> => {
  const api = getElectronAPI();
  if (api) {
    const result = await api.dialog.openDirectory();
    // 统一路径斜杠
    return {
      ...result,
      filePaths: result.filePaths.map(normalizePath),
    };
  }
  return { canceled: true, filePaths: [] };
};

export const saveFileDialog = async (
  options?: SaveFileOptions
): Promise<SaveDialogResult> => {
  const api = getElectronAPI();
  if (api) {
    return await api.dialog.saveFile(options);
  }
  return { canceled: true };
};

// ========== 文件系统 ==========

export const fsReadFile = async (path: string): Promise<string> => {
  const api = getElectronAPI();
  if (api) {
    const result = await api.fs.readFile(path);
    // Controller 返回 { content: string }，需要解包
    return typeof result === 'object' && result !== null && 'content' in result
      ? (result as { content: string }).content
      : (result as string);
  }
  throw new Error('File system not available in browser');
};

export const fsReadFileAsBase64 = async (path: string): Promise<string> => {
  const api = getElectronAPI();
  if (api) {
    const result = await api.fs.readFileAsBase64(path);
    return typeof result === 'object' && result !== null && 'base64' in result
      ? (result as { base64: string }).base64
      : (result as string);
  }
  throw new Error('File system not available in browser');
};

export const fsWriteFile = async (
  path: string,
  data: string,
  binary?: boolean
): Promise<void> => {
  const api = getElectronAPI();
  if (api) {
    await api.fs.writeFile(path, data, binary);
    return;
  }
  throw new Error('File system not available in browser');
};

export const fsExists = async (path: string): Promise<boolean> => {
  const api = getElectronAPI();
  if (api) {
    const result = await api.fs.exists(path);
    // Controller 返回 { exists: boolean }，需要解包
    return typeof result === 'object' && result !== null && 'exists' in result
      ? (result as { exists: boolean }).exists
      : Boolean(result);
  }
  return false;
};

export const fsMkdir = async (path: string): Promise<void> => {
  const api = getElectronAPI();
  if (api) {
    await api.fs.mkdir(path);
  }
};

export const fsReaddir = async (path: string): Promise<string[]> => {
  const api = getElectronAPI();
  if (api) {
    const result = await api.fs.readdir(path);
    // Controller 返回 { files: string[] }，需要解包
    return typeof result === 'object' && result !== null && 'files' in result
      ? (result as { files: string[] }).files
      : (result as string[]);
  }
  return [];
};

export const fsStat = async (path: string): Promise<FileStat | null> => {
  const api = getElectronAPI();
  if (api) {
    return await api.fs.stat(path);
  }
  return null;
};

export const fsRemove = async (path: string): Promise<void> => {
  const api = getElectronAPI();
  if (api) {
    await api.fs.remove(path);
  }
};

export const fsCopy = async (src: string, dest: string): Promise<void> => {
  const api = getElectronAPI();
  if (api) {
    await api.fs.copy(src, dest);
  }
};

// 递归计算目录大小
export const fsDirSize = async (dirPath: string): Promise<number> => {
  const api = getElectronAPI();
  if (!api) return 0;

  let totalSize = 0;
  try {
    const entries = await fsReaddir(dirPath);
    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry}`;
      const stat = await fsStat(fullPath);
      if (stat) {
        if (stat.isDirectory) {
          totalSize += await fsDirSize(fullPath);
        } else {
          totalSize += stat.size;
        }
      }
    }
  } catch {
    // 忽略读取错误
  }
  return totalSize;
};

// 从 URL 下载文件到本地（绕过 CORS）
export const fsDownloadFile = async (
  url: string,
  destPath: string,
  options?: { headers?: Record<string, string>; channelId?: string }
): Promise<{ success: boolean; size: number; path?: string; mimeType?: string }> => {
  const api = getElectronAPI();
  if (api) {
    const result = await api.fs.downloadFile(url, destPath, options) as any;
    if (result?.success === false) {
      throw new Error(result.error || result.message || '文件下载失败');
    }
    if (!result?.success) {
      throw new Error('文件下载失败：IPC 未返回成功状态');
    }
    return result;
  }
  throw new Error('File download not available in browser');
};

// 写入二进制文件（用于下载的图片/视频）
export const fsWriteFileBuffer = async (
  path: string,
  buffer: Uint8Array
): Promise<void> => {
  const api = getElectronAPI();
  if (api) {
    // 将 Uint8Array 转换为 base64 字符串传递
    const base64 = btoa(
      Array.from(buffer)
        .map((b) => String.fromCharCode(b))
        .join('')
    );
    await api.fs.writeFile(path, base64, true); // binary: true
    return;
  }
  throw new Error('File system not available in browser');
};

// ========== Shell ==========

// 别名导出，便于在组件中使用
export const selectDirectory = async (_options?: { title?: string }): Promise<OpenDialogResult> => {
  return openDirectoryDialog();
};

export const writeFile = fsWriteFile;
export const createDirectory = fsMkdir;

export const shellOpenExternal = async (url: string): Promise<void> => {
  const api = getElectronAPI();
  if (api) {
    await api.shell.openExternal(url);
  } else {
    window.open(url, '_blank');
  }
};

export const shellShowItemInFolder = async (path: string): Promise<void> => {
  const api = getElectronAPI();
  if (api) {
    await api.shell.showItemInFolder(path);
  }
};

// 用系统默认程序打开路径（文件夹会在资源管理器中打开）
export const shellOpenPath = async (path: string): Promise<void> => {
  const api = getElectronAPI();
  if (api && (api.shell as any).openPath) {
    await (api.shell as any).openPath(path);
  } else {
    // fallback: 使用 showItemInFolder
    await shellShowItemInFolder(path);
  }
};

// ========== App ==========

export const appGetPath = async (
  name: 'home' | 'appData' | 'userData' | 'temp' | 'desktop' | 'documents'
): Promise<string> => {
  const api = getElectronAPI();
  if (api) {
    const result = await api.app.getPath(name);
    // Controller 返回 { path: string }，需要解包
    const path = typeof result === 'object' && result !== null && 'path' in result
      ? (result as { path: string }).path
      : (result as string);
    return normalizePath(path);
  }
  // 浏览器 fallback
  return '';
};

export const appGetVersion = async (): Promise<string> => {
  const api = getElectronAPI();
  if (api) {
    const result = await api.app.getVersion();
    // Controller 返回 { version: string }，需要解包
    return typeof result === 'object' && result !== null && 'version' in result
      ? (result as { version: string }).version
      : (result as string);
  }
  return '0.0.0';
};

/**
 * 取主进程业务根目录（Windows 安装版默认 <安装盘>:\.koma\，dev/受限路径退回 ~/.koma）。
 * 旧版主进程（无该 IPC）会拒绝调用，这里 catch 回退到 home/.koma 让前端不崩。
 */
export const appGetBusinessRoot = async (): Promise<string> => {
  const api = getElectronAPI();
  if (api?.app?.getBusinessRoot) {
    try {
      const result = await api.app.getBusinessRoot();
      const path = typeof result === 'object' && result !== null && 'path' in result
        ? (result as { path: string }).path
        : (result as string);
      return normalizePath(path);
    } catch {
      // fall through to legacy path
    }
  }
  // 旧主进程兼容：home/.koma
  const home = await appGetPath('home');
  return normalizePath(`${home}/.koma`);
};

/**
 * 检查是否需要从旧 ~/.koma 迁移数据到新业务根。旧主进程无该 IPC 时返回 needsMigration=false。
 */
export const appCheckLegacyDataMigration = async (): Promise<{
  needsMigration: boolean;
  oldPath: string;
  newPath: string;
  hasContent: boolean;
}> => {
  const api = getElectronAPI();
  if (api?.app?.checkLegacyDataMigration) {
    try {
      return await api.app.checkLegacyDataMigration();
    } catch {
      // fall through
    }
  }
  return { needsMigration: false, oldPath: '', newPath: '', hasContent: false };
};

// ========== 诊断日志 ==========

export const diagnosticsAppendRendererLog = async (
  payload: DiagnosticsRendererLogPayload
): Promise<void> => {
  const api = getElectronAPI();
  if (!api?.diagnostics) return;
  await api.diagnostics.appendRendererLog(payload);
};

export const diagnosticsListLogs = async (): Promise<DiagnosticsLogSummary> => {
  const api = getElectronAPI();
  if (api?.diagnostics) {
    return await api.diagnostics.listLogs();
  }
  return {
    storageRoot: '',
    logsDir: '',
    electronLogsDir: '',
    files: [],
    totalSize: 0,
  };
};

export const diagnosticsGetUsage = async (): Promise<DiagnosticsUsageSummary> => {
  const api = getElectronAPI();
  if (api?.diagnostics?.getUsage) {
    return await api.diagnostics.getUsage();
  }
  const summary = await diagnosticsListLogs();
  return {
    storageRoot: summary.storageRoot,
    logsDir: summary.logsDir,
    totalSize: summary.totalSize,
    fileCount: summary.files.length,
  };
};

export const diagnosticsClearLogs = async (): Promise<{ success: boolean; removed: number }> => {
  const api = getElectronAPI();
  if (api?.diagnostics?.clearLogs) {
    return await api.diagnostics.clearLogs();
  }
  return { success: false, removed: 0 };
};

export const diagnosticsClearRendererLogs = async (): Promise<{ success: boolean; removed: number }> => {
  const api = getElectronAPI();
  if (api?.diagnostics) {
    return await api.diagnostics.clearRendererLogs();
  }
  return { success: false, removed: 0 };
};

export const diagnosticsExportLogs = async (destPath: string): Promise<DiagnosticsExportResult> => {
  const api = getElectronAPI();
  if (api?.diagnostics) {
    return await api.diagnostics.exportLogs(destPath);
  }
  throw new Error('Diagnostics export not available in browser');
};

// 获取存储根路径（业务根：~/.koma/storage —— 与 userData 子目录隔离）
export const getStoragePath = async (): Promise<string> => {
  const api = getElectronAPI();
  if (api) {
    const home = await api.app.getPath('home');
    const homePath = typeof home === 'object' && home !== null && 'path' in home
      ? (home as { path: string }).path
      : (home as string);
    return `${homePath}/.koma/storage`;
  }
  return '';
};

// 获取机器唯一标识
export const getMachineId = async (): Promise<string> => {
  const api = getElectronAPI();
  if (api) {
    const userData = await api.app.getPath('userData');
    const path = typeof userData === 'object' && userData !== null && 'path' in userData
      ? (userData as { path: string }).path
      : (userData as string);
    // 使用 userData 路径作为基础生成一个稳定的标识
    return btoa(path).slice(0, 32);
  }
  return 'browser-instance';
};

// ========== 项目 CRUD ==========

export const projectSetStorageRoot = async (rootPath: string): Promise<{ success: boolean; rootPath: string }> => {
  const api = getElectronAPI();
  if (api) {
    return await api.project.setStorageRoot(rootPath);
  }
  return { success: true, rootPath };
};

export const projectList = async (): Promise<ProjectMeta[]> => {
  const api = getElectronAPI();
  if (api) {
    const result = await api.project.list();
    return Array.isArray(result) ? result : [];
  }
  // 浏览器 fallback: 返回空列表
  return [];
};

export const projectCreate = async (meta: ProjectMeta): Promise<ProjectMeta> => {
  const api = getElectronAPI();
  if (api) {
    return await api.project.create(meta);
  }
  throw new Error('Project creation not available in browser');
};

export const projectLoad = async (projectId: string): Promise<ProjectMeta> => {
  const api = getElectronAPI();
  if (api) {
    return await api.project.load(projectId);
  }
  throw new Error('Project loading not available in browser');
};

export const projectSave = async (projectId: string, data: any): Promise<{ success: boolean }> => {
  const api = getElectronAPI();
  if (api) {
    return await api.project.save(projectId, data);
  }
  throw new Error('Project save not available in browser');
};

export const projectUpdate = async (projectId: string, updates: Partial<ProjectMeta>): Promise<ProjectMeta> => {
  const api = getElectronAPI();
  if (api) {
    return await api.project.update(projectId, updates);
  }
  throw new Error('Project update not available in browser');
};

export const projectDelete = async (projectId: string): Promise<{ success: boolean }> => {
  const api = getElectronAPI();
  if (api) {
    return await api.project.remove(projectId);
  }
  throw new Error('Project deletion not available in browser');
};

export const projectRebuildIndex = async (): Promise<any> => {
  const api = getElectronAPI();
  if (api) {
    return await api.project.rebuildIndex();
  }
  throw new Error('Project index rebuild not available in browser');
};

export const projectLoadFull = async (projectId: string): Promise<any> => {
  const api = getElectronAPI();
  if (api) {
    return await api.project.loadFull(projectId);
  }
  throw new Error('Project loadFull not available in browser');
};

export const projectBindOwnerRefMedia = async (
  projectId: string,
  ownerRef: MediaOwnerRef,
  asset: StoredMediaAsset,
): Promise<{ success: boolean }> => {
  const api = getElectronAPI();
  if (api) {
    return await api.project.bindOwnerRefMedia(projectId, ownerRef, asset);
  }
  throw new Error('Project bindOwnerRefMedia not available in browser');
};

// ========== 批量实体操作（通过 IPC 调后端，匹配前端 save/load 模式） ==========

export const batchApi = {
  saveAllCharacters: async (projectId: string, items: any[]) => {
    const a = getElectronAPI(); if (!a) return;
    await (a.project as any).saveAllCharacters(projectId, items);
  },
  loadAllCharacters: async (projectId: string): Promise<any[]> => {
    const a = getElectronAPI(); if (!a) return [];
    return await (a.project as any).loadAllCharacters(projectId) ?? [];
  },
  saveAllScenes: async (projectId: string, items: any[]) => {
    const a = getElectronAPI(); if (!a) return;
    await (a.project as any).saveAllScenes(projectId, items);
  },
  loadAllScenes: async (projectId: string): Promise<any[]> => {
    const a = getElectronAPI(); if (!a) return [];
    return await (a.project as any).loadAllScenes(projectId) ?? [];
  },
  saveAllProps: async (projectId: string, items: any[]) => {
    const a = getElectronAPI(); if (!a) return;
    await (a.project as any).saveAllProps(projectId, items);
  },
  loadAllProps: async (projectId: string): Promise<any[]> => {
    const a = getElectronAPI(); if (!a) return [];
    return await (a.project as any).loadAllProps(projectId) ?? [];
  },
  saveAllShots: async (projectId: string, items: any[]) => {
    const a = getElectronAPI(); if (!a) return;
    await (a.project as any).saveAllShots(projectId, items);
  },
  loadAllShots: async (projectId: string): Promise<any[]> => {
    const a = getElectronAPI(); if (!a) return [];
    return await (a.project as any).loadAllShots(projectId) ?? [];
  },
  saveShotMeta: async (projectId: string, shotId: string, meta: any) => {
    const a = getElectronAPI(); if (!a) return;
    await (a.project as any).saveShotMeta(projectId, shotId, meta);
  },
  loadShotMeta: async (projectId: string, shotId: string): Promise<any | null> => {
    const a = getElectronAPI(); if (!a) return null;
    return await (a.project as any).loadShotMeta(projectId, shotId) ?? null;
  },
  listShotMetas: async (projectId: string): Promise<any[]> => {
    const a = getElectronAPI(); if (!a) return [];
    return await (a.project as any).listShotMetas(projectId) ?? [];
  },
  saveAnalysis: async (projectId: string, episodeId: string, analysis: any) => {
    const a = getElectronAPI(); if (!a) return;
    await (a.project as any).saveAnalysis(projectId, episodeId, analysis);
  },
  loadAnalysis: async (projectId: string, episodeId: string): Promise<any | null> => {
    const a = getElectronAPI(); if (!a) return null;
    return await (a.project as any).loadAnalysis(projectId, episodeId) ?? null;
  },
  saveProjectTimeline: async (projectId: string, timeline: any) => {
    const a = getElectronAPI(); if (!a) return;
    await (a.project as any).saveProjectTimeline(projectId, timeline);
  },
  loadProjectTimeline: async (projectId: string): Promise<any | null> => {
    const a = getElectronAPI(); if (!a) return null;
    return await (a.project as any).loadProjectTimeline(projectId) ?? null;
  },
  saveEpisodeTimeline: async (projectId: string, episodeId: string, timeline: any) => {
    const a = getElectronAPI(); if (!a) return;
    await (a.project as any).saveEpisodeTimeline(projectId, episodeId, timeline);
  },
  loadEpisodeTimeline: async (projectId: string, episodeId: string): Promise<any | null> => {
    const a = getElectronAPI(); if (!a) return null;
    return await (a.project as any).loadEpisodeTimeline(projectId, episodeId) ?? null;
  },
};

// ========== 实体 CRUD（通过 IPC 调后端） ==========

const makeEntityCrud = (prefix: string) => {
  const api = () => getElectronAPI();
  return {
    list: async (projectId: string) => {
      const a = api(); if (!a) return [];
      return await (a.project as any)[`${prefix}List`](projectId);
    },
    get: async (id: string) => {
      const a = api(); if (!a) return undefined;
      return await (a.project as any)[`${prefix}Get`](id);
    },
    create: async (data: any) => {
      const a = api(); if (!a) throw new Error('Not available');
      return await (a.project as any)[`${prefix}Create`](data);
    },
    update: async (id: string, data: any) => {
      const a = api(); if (!a) throw new Error('Not available');
      return await (a.project as any)[`${prefix}Update`](id, data);
    },
    delete: async (id: string) => {
      const a = api(); if (!a) throw new Error('Not available');
      return await (a.project as any)[`${prefix}Delete`](id);
    },
  };
};

export const characterApi = makeEntityCrud('character');
export const sceneApi = makeEntityCrud('scene');
export const propApi = makeEntityCrud('prop');
export const episodeApi = makeEntityCrud('episode');

export const shotApi = {
  ...makeEntityCrud('shot'),
  listVersions: async (shotId: string) => {
    const a = getElectronAPI(); if (!a) return [];
    return await (a.project as any).shotVersionList(shotId);
  },
  createVersion: async (data: any) => {
    const a = getElectronAPI(); if (!a) throw new Error('Not available');
    return await (a.project as any).shotVersionCreate(data);
  },
  deleteVersion: async (id: string) => {
    const a = getElectronAPI(); if (!a) throw new Error('Not available');
    return await (a.project as any).shotVersionDelete(id);
  },
  setVersion: async (shotId: string, versionNumber: number) => {
    const a = getElectronAPI(); if (!a) throw new Error('Not available');
    return await (a.project as any).shotSetVersion(shotId, versionNumber);
  },
};

export const assetApi = {
  ...makeEntityCrud('asset'),
  findByFingerprint: async (projectId: string, fingerprint: string) => {
    const a = getElectronAPI(); if (!a) return undefined;
    return await (a.project as any).assetFindByFingerprint(projectId, fingerprint);
  },
  listUnreferenced: async (projectId: string) => {
    const a = getElectronAPI(); if (!a) return [];
    return await (a.project as any).assetListUnreferenced(projectId);
  },
};

export const timelineApi = {
  get: async (projectId: string) => {
    const a = getElectronAPI(); if (!a) return undefined;
    return await (a.project as any).timelineGet(projectId);
  },
  update: async (id: string, data: any) => {
    const a = getElectronAPI(); if (!a) throw new Error('Not available');
    return await (a.project as any).timelineUpdate(id, data);
  },
  addTrack: async (data: any) => {
    const a = getElectronAPI(); if (!a) throw new Error('Not available');
    return await (a.project as any).trackAdd(data);
  },
  updateTrack: async (id: string, data: any) => {
    const a = getElectronAPI(); if (!a) throw new Error('Not available');
    return await (a.project as any).trackUpdate(id, data);
  },
  deleteTrack: async (id: string) => {
    const a = getElectronAPI(); if (!a) throw new Error('Not available');
    return await (a.project as any).trackDelete(id);
  },
  addClip: async (data: any) => {
    const a = getElectronAPI(); if (!a) throw new Error('Not available');
    return await (a.project as any).clipAdd(data);
  },
  updateClip: async (id: string, data: any) => {
    const a = getElectronAPI(); if (!a) throw new Error('Not available');
    return await (a.project as any).clipUpdate(id, data);
  },
  deleteClip: async (id: string) => {
    const a = getElectronAPI(); if (!a) throw new Error('Not available');
    return await (a.project as any).clipDelete(id);
  },
};

// ========== 项目导入导出 ==========

export const projectExport = async (
  projectId: string,
  destPath: string,
  options?: ExportOptions
): Promise<{ success: boolean; path: string }> => {
  const api = getElectronAPI();
  if (api) {
    return await api.project.export(projectId, destPath, options);
  }
  throw new Error('Project export not available in browser');
};

export const projectImport = async (
  zipPath: string,
  newProjectId?: string
): Promise<{ success: boolean; projectId: string; meta: any }> => {
  const api = getElectronAPI();
  if (api) {
    return await api.project.import(zipPath, newProjectId);
  }
  throw new Error('Project import not available in browser');
};

// 导出服务对象
export const electronService = {
  isElectron,
  window: {
    minimize: windowMinimize,
    maximize: windowMaximize,
    close: windowClose,
    isMaximized: windowIsMaximized,
  },
  dialog: {
    openFile: openFileDialog,
    openDirectory: openDirectoryDialog,
    saveFile: saveFileDialog,
  },
  fs: {
    readFile: fsReadFile,
    readFileAsBase64: fsReadFileAsBase64,
    writeFile: fsWriteFile,
    exists: fsExists,
    mkdir: fsMkdir,
    readdir: fsReaddir,
    stat: fsStat,
    remove: fsRemove,
    copy: fsCopy,
    downloadFile: fsDownloadFile,
    writeFileBuffer: fsWriteFileBuffer,
    dirSize: fsDirSize,
    // 将本地文件路径转换为可用的 URL
    toLocalUrl: (filePath: string): string => {
      if (!filePath) return '';
      // 浏览器模式直接返回（应该是网络 URL）
      if (!isElectron()) return filePath;
      return toKomaLocalUrl(filePath);
    },
  },
  shell: {
    openExternal: shellOpenExternal,
    showItemInFolder: shellShowItemInFolder,
    openPath: shellOpenPath,
  },
  app: {
    getPath: appGetPath,
    getVersion: appGetVersion,
    getBusinessRoot: appGetBusinessRoot,
    checkLegacyDataMigration: appCheckLegacyDataMigration,
  },
  diagnostics: {
    appendRendererLog: diagnosticsAppendRendererLog,
    listLogs: diagnosticsListLogs,
    getUsage: diagnosticsGetUsage,
    clearLogs: diagnosticsClearLogs,
    clearRendererLogs: diagnosticsClearRendererLogs,
    exportLogs: diagnosticsExportLogs,
  },
  getStoragePath,
  getMachineId,
  project: {
    setStorageRoot: projectSetStorageRoot,
    list: projectList,
    create: projectCreate,
    load: projectLoad,
    loadFull: projectLoadFull,
    bindOwnerRefMedia: projectBindOwnerRefMedia,
    save: projectSave,
    update: projectUpdate,
    remove: projectDelete,
    rebuildIndex: projectRebuildIndex,
    export: projectExport,
    import: projectImport,
  },
  // 批量实体 API
  batch: batchApi,
  // 实体 CRUD API（通过 IPC 调后端）
  character: characterApi,
  scene: sceneApi,
  prop: propApi,
  shot: shotApi,
  asset: assetApi,
  episode: episodeApi,
  timeline: timelineApi,
  // 插件相关 API
  ipc: {
    invoke: async (channel: string, args?: any): Promise<any> => {
      const api = getElectronAPI();
      if (api && (api as any).plugin) {
        if (channel === 'controller/plugin/list') {
          return (api as any).plugin.list();
        }
        if (channel === 'controller/plugin/openFolder') {
          return (api as any).plugin.openFolder(args.pluginPath);
        }
        if (channel === 'controller/plugin/validate') {
          return (api as any).plugin.validate(args.zipPath);
        }
        if (channel === 'controller/plugin/install') {
          return (api as any).plugin.install(args.zipPath, args.manifest);
        }
        if (channel === 'controller/plugin/uninstall') {
          return (api as any).plugin.uninstall(args.pluginPath);
        }
        if (channel === 'controller/plugin/activate') {
          return (api as any).plugin.activate(args.manifest);
        }
        if (channel === 'controller/plugin/deactivate') {
          return (api as any).plugin.deactivate(args.pluginId);
        }
        if (channel === 'controller/plugin/status') {
          return (api as any).plugin.status(args.pluginId);
        }
        if (channel === 'controller/plugin/listActive') {
          return (api as any).plugin.listActive();
        }
      }
      // 通用 IPC 调用（通过 window.electron）
      const bridgeWindow = typeof window === 'undefined' ? null : (window as ElectronBridgeWindow);
      if (bridgeWindow?.electron?.ipcRenderer) {
        return bridgeWindow.electron.ipcRenderer.invoke(channel, args);
      }
      throw new Error(`IPC not available: ${channel}`);
    },
  },
};

export default electronService;
