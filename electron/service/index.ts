/**
 * 服务层索引
 */
import path from 'path';
import { projectService, ProjectService } from './project';
import { ffmpegService, FFmpegService } from './ffmpeg';
import { pluginService } from './plugin';
import { chatService, ChatService } from './chat';
import { diagnosticsService, DiagnosticsService } from './diagnostics';
import { baseDB, settingsDB } from './storage';
import { syncBuiltinStyleReferences } from './styleReferences';
import { getBusinessRoot } from './paths';

export const services = {
  project: projectService,
  ffmpeg: ffmpegService,
  plugin: pluginService,
  chat: chatService,
  diagnostics: diagnosticsService,
};

let initialized = false;
let initPromise: Promise<void> | null = null;

export async function initServices(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // 全局 settings.db 与项目无关，先行初始化
    settingsDB.init();
    await services.project.init(getBusinessRoot());
    services.diagnostics.init(services.project.getStorageRoot());
    await services.ffmpeg.init(path.join(services.project.getStorageRoot(), 'cache', 'ffmpeg'));
    await services.plugin.init();
    // 内置风格参考图镜像到业务根，让 koma-local:// 协议可直读
    await syncBuiltinStyleReferences();
    initialized = true;
  })();

  return initPromise;
}

export async function ensureServicesReady(): Promise<void> {
  if (initialized) return;
  if (!initPromise) {
    await initServices();
    return;
  }
  await initPromise;
}

export function closeServices(): void {
  baseDB.close();
  settingsDB.close();
}

export {
  ProjectService,
  projectService,
  FFmpegService,
  ffmpegService,
  pluginService,
  ChatService,
  chatService,
  DiagnosticsService,
  diagnosticsService,
  baseDB,
  settingsDB,
};
export default services;
