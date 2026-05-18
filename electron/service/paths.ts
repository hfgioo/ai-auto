/**
 * 应用路径职责分离
 *
 * 设计原则：
 * - `userData`（由 Electron `app.getPath('userData')` 给出）= **Chromium / Electron 框架** 自管目录
 *   （Cookies / Local Storage / Cache / SingletonLock 等），业务代码**不应**直接读写
 * - **业务根** = 平台相关：
 *     * Windows 安装版 / 便携版（非 Program Files / WindowsApps）：
 *         `<安装盘>:\.koma\`，例如装在 D:\KomaStudio\ 时业务根 = D:\.koma\
 *         避免 C 盘用户目录强制依赖；多设备拷贝程序时数据"跟着盘走"。
 *     * Windows 装在 Program Files / Program Files (x86) / WindowsApps 下：
 *         安装目录无写权限，回退 `~/.koma\`，避免普通用户启动失败。
 *     * macOS / Linux / 开发环境：始终 `~/.koma/`（dev 时和系统级 Application 装位混乱时用 home 最稳）
 *
 *     业务根存放：
 *     * settings.db 全局配置 SQLite
 *     * plugins-runtime/  plugins-staging/  插件目录
 *     * logs/  日志
 *     * ffmpeg-cache/  FFmpeg 临时
 *     * projects/  默认项目根（用户可在前端 storageConfig 改到别处）
 *       - projects/{id}/koma.db  项目级 SQLite（剧集 / 分镜 / 时间线 / 媒体绑定）
 *       - projects/{id}/assets/  大文件（图 / 视频 / 音频 / 字体）
 *       - projects/{id}/cache/   缩略图 / 波形 / 预览
 *       - projects/{id}/episodes/{id}/analysis.json  剧集解析结果（嵌套 JSON）
 *

 * 在 main.ts 已通过 `app.setPath('userData', '<业务根>/_userData')` 把 Chromium
 * 内部数据挪到子目录，让业务根目录干净。
 *
 * 任何过去用 `app.getPath('userData')` 拼业务路径的代码都改为本模块的 helper。
 */
import { app } from 'electron';
import * as path from 'node:path';

/** 是否被 Windows 视为受限路径（Program Files / WindowsApps）—— 这些位置非管理员账号不可写。 */
function isWindowsRestrictedPath(installDir: string): boolean {
  const lower = installDir.toLowerCase();
  return (
    lower.includes('\\program files\\')
    || lower.includes('\\program files (x86)\\')
    || lower.includes('\\windowsapps\\')
  );
}

/**
 * 解析业务根目录（纯计算，不读写文件系统）。
 * 调用时机：main.ts 启动早期（早于 setPath）需要先确定路径，所以本函数不能依赖 app.getPath('userData')。
 */
export function resolveBusinessRoot(): string {
  // 非 Windows：保持 ~/.koma 不变
  if (process.platform !== 'win32') {
    return path.join(app.getPath('home'), '.koma');
  }

  // Windows：依赖 process.execPath 推断"程序所在盘符"
  // 仅 packaged 模式才让数据跟程序走；dev (npm run dev) 用 ~/.koma 与 npm run build 输出隔开
  if (!app.isPackaged) {
    return path.join(app.getPath('home'), '.koma');
  }

  const execPath = process.execPath;       // 例如 D:\KomaStudio\Koma Studio.exe
  const installDir = path.dirname(execPath);

  // 安全网：装在 Program Files 等受限路径时退回 home
  if (isWindowsRestrictedPath(installDir)) {
    return path.join(app.getPath('home'), '.koma');
  }

  // 取盘符（含冒号），例如 'D:'
  const driveLetter = path.parse(execPath).root.replace(/[\\/]+$/, '');
  if (!/^[A-Za-z]:$/.test(driveLetter)) {
    // execPath 拿不到合法盘符（极少见）→ 退回 home
    return path.join(app.getPath('home'), '.koma');
  }

  return path.join(`${driveLetter}\\`, '.koma');
}

let cachedBusinessRoot: string | undefined;

/** 业务根目录（已缓存，不会重复计算） */
export function getBusinessRoot(): string {
  if (!cachedBusinessRoot) {
    cachedBusinessRoot = resolveBusinessRoot();
  }
  return cachedBusinessRoot;
}

/** 默认业务日志目录；实际运行时会跟随可配置 storageRoot。 */
export function getBusinessLogsDir(): string {
  return path.join(getBusinessRoot(), 'logs');
}

/** 全局配置 SQLite（settings.db）所在目录 */
export function getSettingsDir(): string {
  return getBusinessRoot();
}

/** 插件运行时目录 */
export function getPluginsRuntimeDir(): string {
  return path.join(getBusinessRoot(), 'plugins-runtime');
}

/** 插件暂存（待安装/解压）目录 */
export function getPluginsStagingDir(): string {
  return path.join(getBusinessRoot(), 'plugins-staging');
}

/** 插件 provider 配置文件 */
export function getPluginProviderConfigPath(): string {
  return path.join(getBusinessRoot(), 'provider-configs.json');
}

/** FFmpeg 临时工作目录 */
export function getFfmpegCacheDir(): string {
  return path.join(getBusinessRoot(), 'ffmpeg-cache');
}

/** FFmpeg 二进制目录（与 cache 区分） */
export function getFfmpegBinDir(): string {
  return path.join(getBusinessRoot(), 'ffmpeg');
}

/** 风格参考图运行时目录（业务根下，便于 koma-local:// 协议直读） */
export function getStyleReferencesDir(): string {
  return path.join(getBusinessRoot(), 'style-references');
}

/** 主程序更新下载缓存（dmg / exe / AppImage 临时落盘点） */
export function getUpdaterCacheDir(): string {
  return path.join(getBusinessRoot(), 'updater-cache');
}

/** 插件 marketplace 下载缓存（plugin zip 临时落盘点） */
export function getMarketplaceCacheDir(): string {
  return path.join(getBusinessRoot(), 'marketplace-cache');
}
