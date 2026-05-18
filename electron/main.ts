import { app as electronApp, protocol } from 'electron';
import { ElectronEgg } from 'ee-core';
import { join } from 'node:path';
import { Lifecycle } from './preload/lifecycle';
import { preload } from './preload';
import { getBusinessLogsDir, getBusinessRoot } from './service/paths';

const APP_DISPLAY_NAME = 'Koma Studio';
const ELECTRON_REMOTE_DEBUGGING_PORT = process.env.KOMA_ELECTRON_REMOTE_DEBUGGING_PORT || '9333';
const isDev = process.env.NODE_ENV === 'development' || !electronApp.isPackaged;

electronApp.setName(APP_DISPLAY_NAME);
// 业务存储根：getBusinessRoot() 解析（Windows 安装版默认 <安装盘>:\.koma\，
// dev / mac / linux / 装在受限目录时回退到 ~/.koma/）
//   business root: settings.db / plugins / logs / projects / ffmpeg / ...
//   chromium 内部状态：<业务根>/_userData/（Cookies、Local Storage、Cache、SingletonLock 等）
electronApp.setPath('userData', join(getBusinessRoot(), '_userData'));
electronApp.setAppLogsPath(getBusinessLogsDir());

// 自定义协议 koma-local:// 必须在 app.ready 之前注册为 privileged，
// 否则 Chromium 在 renderer 端会拒绝 <img>/<video>/fetch 加载（DOM 里能看到正确的 src，
// 但资源不会加载、也不会触发主进程的 protocol.handle）。
// - standard:true 让 URL 按 host+path 标准解析（authority 为空，pathname 形如 /Users/...）
// - secure:true 通过 <video> 等需要 secure-context 的 API 校验
// - supportFetchAPI:true 允许 renderer 用 fetch() 拉资源
// - stream:true 允许 protocol.handle 返回 Range/分块响应（视频 range 请求需要）
// - corsEnabled:true 允许跨源访问
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'koma-local',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

if (isDev) {
  electronApp.commandLine.appendSwitch('remote-debugging-port', ELECTRON_REMOTE_DEBUGGING_PORT);

  console.info(
    `[electron-devtools] chrome-devtools-mcp browser-url=http://127.0.0.1:${ELECTRON_REMOTE_DEBUGGING_PORT}`
  );
}

const app = new ElectronEgg();
const lifecycle = new Lifecycle();

app.register('ready', lifecycle.ready);
app.register('electron-app-ready', lifecycle.electronAppReady);
app.register('window-ready', lifecycle.windowReady);
app.register('before-close', lifecycle.beforeClose);
app.register('preload', preload);

app.run();
