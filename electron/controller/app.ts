/**
 * 应用控制器
 */
import * as fs from 'fs';
import * as path from 'path';
import { app, shell } from 'electron';
import { BaseController } from './base';
import { getBusinessRoot, getStyleReferencesDir } from '../service/paths';
import { resolveKomaTTSVoiceSamplePath } from '../service/ttsVoiceSamples';

const ALLOWED_PATH_NAMES = new Set([
  'home', 'appData', 'userData', 'temp', 'desktop',
  'documents', 'downloads', 'music', 'pictures', 'videos',
]);

class AppController extends BaseController {
  getPath(args: { name: string }) {
    if (!ALLOWED_PATH_NAMES.has(args.name)) {
      throw new Error(`Invalid path name: ${args.name}`);
    }
    const pathValue = app.getPath(args.name as any);
    return { path: pathValue };
  }

  /**
   * 业务根目录（默认 <安装盘>:\.koma\，受限路径或 dev/mac/linux 退回 ~/.koma）。
   * 前端 storageConfig 取默认存储路径时调用本接口，避免与主进程不一致。
   */
  getBusinessRoot() {
    return { path: getBusinessRoot() };
  }

  /**
   * 检测旧 ~/.koma 是否存在且非空、且当前业务根 ≠ 旧 home/.koma 路径，
   * 用于启动时提示用户"是否迁移到新路径"。
   *
   * 返回 { needsMigration: boolean, oldPath, newPath, hasContent }。
   * - hasContent：旧目录是否有实质内容（projects/ 或 settings.db 任一存在）
   * - needsMigration：true 仅当 ①hasContent ②oldPath ≠ newPath ③newPath 不存在或为空
   */
  checkLegacyDataMigration() {
    const oldPath = path.join(app.getPath('home'), '.koma');
    const newPath = getBusinessRoot();
    if (path.resolve(oldPath) === path.resolve(newPath)) {
      return { needsMigration: false, oldPath, newPath, hasContent: false };
    }
    let hasContent = false;
    try {
      const projectsDir = path.join(oldPath, 'projects');
      const settingsDb = path.join(oldPath, 'settings.db');
      if (fs.existsSync(projectsDir)) {
        const entries = fs.readdirSync(projectsDir).filter(name => !name.startsWith('.'));
        if (entries.length > 0) hasContent = true;
      }
      if (!hasContent && fs.existsSync(settingsDb)) {
        const stat = fs.statSync(settingsDb);
        if (stat.size > 0) hasContent = true;
      }
    } catch {
      // 旧路径不存在或无权访问 → 当作无内容
    }
    let newPathHasContent = false;
    try {
      if (fs.existsSync(newPath)) {
        const entries = fs.readdirSync(newPath).filter(name => !name.startsWith('.') && name !== '_userData');
        if (entries.length > 0) newPathHasContent = true;
      }
    } catch {
      // 新路径不可读，按"无内容"处理（后续会自动 mkdir）
    }
    return {
      needsMigration: hasContent && !newPathHasContent,
      oldPath,
      newPath,
      hasContent,
    };
  }

  getVersion() {
    return { version: app.getVersion() };
  }

  async openExternal(args: { url: string }) {
    const parsed = new URL(args.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http/https URLs are allowed');
    }
    await shell.openExternal(args.url);
    return { success: true };
  }

  showItemInFolder(args: { filePath: string }) {
    shell.showItemInFolder(args.filePath);
    return { success: true };
  }

  /**
   * 解析风格参考图（"画风锚"）的本地绝对路径。
   * 入参 filename 是 ThemePreset.defaultStyleReferenceFile（仅文件名，无路径）。
   * 命中时返回 `{ localPath }`，找不到时返回 `{ localPath: null }` 让前端回退。
   * 拒绝任何带 `..` / 路径分隔符的非法 filename，防止越界读取。
   */
  /**
   * 解析 Koma 内置 TTS 音色试听样本（wav）的本地绝对路径。
   * 入参 sampleFile 是 KomaTTSVoiceMeta.sampleFile，形如 `01_通用中英文/Cherry-芊悦.wav`。
   * 文件不存在 / 资源目录未定位时返回 `{ localPath: null }`，前端隐藏试听按钮即可。
   */
  getKomaTTSVoiceSamplePath(args: { sampleFile: string }) {
    const sampleFile = String(args?.sampleFile || '').trim();
    if (!sampleFile) return { localPath: null };
    const absPath = resolveKomaTTSVoiceSamplePath(sampleFile);
    return { localPath: absPath || null };
  }

  getStyleReferenceImagePath(args: { filename: string }) {
    const filename = String(args?.filename || '').trim();
    if (!isSafeFilename(filename)) {
      return { localPath: null };
    }
    const absPath = path.join(getStyleReferencesDir(), filename);
    if (!fs.existsSync(absPath)) {
      return { localPath: null };
    }
    return { localPath: absPath };
  }

  /**
   * 拿"当前生效"的风格参考图路径：
   *   1) 用户上传的覆盖图 `{presetId}-user.<ext>`（任意支持的图片扩展名）
   *   2) 否则回退到内置 fallbackFilename（preset.defaultStyleReferenceFile）
   *   3) 都没有 → null
   *
   * mtimeMs 一并返回，便于前端做缓存破坏（刚上传完立即看到新图）。
   */
  getActiveStyleReferenceImagePath(args: { presetId: string; fallbackFilename?: string }) {
    const presetId = String(args?.presetId || '').trim();
    if (!isSafePresetId(presetId)) {
      return { localPath: null, mtimeMs: 0 };
    }
    const userOverride = findUserOverrideFile(presetId);
    if (userOverride) {
      return userOverride;
    }
    const fallback = String(args?.fallbackFilename || '').trim();
    if (fallback && isSafeFilename(fallback)) {
      const absPath = path.join(getStyleReferencesDir(), fallback);
      try {
        const stat = fs.statSync(absPath);
        return { localPath: absPath, mtimeMs: stat.mtimeMs };
      } catch {
        // not found
      }
    }
    return { localPath: null, mtimeMs: 0 };
  }

  /**
   * 保存用户上传的风格参考图。
   * 入参 dataBase64 是不带 `data:` 前缀的纯 base64；ext 是不带点的扩展名（svg/png/jpg/webp/gif）。
   * 写入前会清掉同 presetId 下已有的任何扩展名 user 覆盖文件，保证一个 preset 只有一份 user 图。
   */
  async saveStyleReferenceImage(args: { presetId: string; dataBase64: string; ext: string }) {
    const presetId = String(args?.presetId || '').trim();
    const ext = String(args?.ext || '').trim().toLowerCase().replace(/^\./, '');
    if (!isSafePresetId(presetId)) {
      throw new Error('Invalid presetId');
    }
    if (!ALLOWED_STYLE_REFERENCE_EXT_SET.has(ext)) {
      throw new Error(`Unsupported image extension: ${ext}`);
    }
    const data = String(args?.dataBase64 || '');
    if (!data) {
      throw new Error('Empty image data');
    }

    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length) {
      throw new Error('Empty image data');
    }

    const dir = getStyleReferencesDir();
    await fs.promises.mkdir(dir, { recursive: true });

    // 清掉同 presetId 下其它扩展名的旧 user 覆盖图
    removeAllUserOverrides(presetId);

    const filename = `${presetId}-user.${ext}`;
    const absPath = path.join(dir, filename);
    await fs.promises.writeFile(absPath, buffer);
    const stat = await fs.promises.stat(absPath);
    return { localPath: absPath, filename, mtimeMs: stat.mtimeMs };
  }

  clearStyleReferenceImage(args: { presetId: string }) {
    const presetId = String(args?.presetId || '').trim();
    if (!isSafePresetId(presetId)) {
      return { success: false };
    }
    const removed = removeAllUserOverrides(presetId);
    return { success: true, removed };
  }

  /**
   * 保存"项目级"风格参考图，落到 `~/.koma/projects/{projectId}/assets/style-reference.{ext}`。
   * 与全局参考图（`~/.koma/style-references/{presetId}-user.{ext}`）独立，
   * 项目级覆盖优先级最高（resolveActiveStyleReferenceAsset 里先看 project.styleSnapshot.styleReferenceImage）。
   */
  async saveProjectStyleReferenceImage(args: { projectId: string; dataBase64: string; ext: string }) {
    const projectId = String(args?.projectId || '').trim();
    const ext = String(args?.ext || '').trim().toLowerCase().replace(/^\./, '');
    if (!isSafeProjectId(projectId)) {
      throw new Error('Invalid projectId');
    }
    if (!ALLOWED_STYLE_REFERENCE_EXT_SET.has(ext)) {
      throw new Error(`Unsupported image extension: ${ext}`);
    }
    const data = String(args?.dataBase64 || '');
    if (!data) {
      throw new Error('Empty image data');
    }
    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length) {
      throw new Error('Empty image data');
    }

    const projectAssetsDir = path.join(getBusinessRoot(), 'projects', projectId, 'assets');
    await fs.promises.mkdir(projectAssetsDir, { recursive: true });

    // 同 projectId 下同名其它扩展名的旧文件先清掉，避免遗留
    for (const e of ALLOWED_STYLE_REFERENCE_EXTS) {
      const old = path.join(projectAssetsDir, `style-reference.${e}`);
      try {
        await fs.promises.unlink(old);
      } catch {
        // 不存在
      }
    }

    const filename = `style-reference.${ext}`;
    const absPath = path.join(projectAssetsDir, filename);
    await fs.promises.writeFile(absPath, buffer);
    const stat = await fs.promises.stat(absPath);
    return { localPath: absPath, filename, mtimeMs: stat.mtimeMs };
  }

  /**
   * 删除项目级风格参考图，让前端把 styleSnapshot.styleReferenceImage 也置空。
   */
  async clearProjectStyleReferenceImage(args: { projectId: string }) {
    const projectId = String(args?.projectId || '').trim();
    if (!isSafeProjectId(projectId)) {
      return { success: false, removed: 0 };
    }
    const projectAssetsDir = path.join(getBusinessRoot(), 'projects', projectId, 'assets');
    let removed = 0;
    for (const e of ALLOWED_STYLE_REFERENCE_EXTS) {
      const old = path.join(projectAssetsDir, `style-reference.${e}`);
      try {
        await fs.promises.unlink(old);
        removed += 1;
      } catch {
        // 不存在
      }
    }
    return { success: true, removed };
  }
}

// 仅支持栅格图。SVG 不能被多数 TTI provider 当作图生图的输入参考，禁止上传。
const ALLOWED_STYLE_REFERENCE_EXTS = ['png', 'jpg', 'jpeg', 'webp'] as const;
const ALLOWED_STYLE_REFERENCE_EXT_SET = new Set<string>(ALLOWED_STYLE_REFERENCE_EXTS);

function isSafeFilename(filename: string): boolean {
  if (!filename) return false;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return false;
  return true;
}

// presetId 来自 ThemePreset.id，受 globalStore 校验；这里再做一次保守校验防越界。
function isSafePresetId(presetId: string): boolean {
  if (!presetId) return false;
  return /^[A-Za-z0-9_\-]+$/.test(presetId);
}

// projectId 由前端创建项目时生成，全字符受控；这里防越界。
function isSafeProjectId(projectId: string): boolean {
  if (!projectId) return false;
  return /^[A-Za-z0-9_\-]+$/.test(projectId);
}

function findUserOverrideFile(presetId: string): { localPath: string; mtimeMs: number } | null {
  const dir = getStyleReferencesDir();
  for (const ext of ALLOWED_STYLE_REFERENCE_EXTS) {
    const candidate = path.join(dir, `${presetId}-user.${ext}`);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        return { localPath: candidate, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // try next
    }
  }
  return null;
}

function removeAllUserOverrides(presetId: string): number {
  const dir = getStyleReferencesDir();
  let removed = 0;
  for (const ext of ALLOWED_STYLE_REFERENCE_EXTS) {
    const candidate = path.join(dir, `${presetId}-user.${ext}`);
    try {
      fs.unlinkSync(candidate);
      removed += 1;
    } catch {
      // not present
    }
  }
  return removed;
}

export = AppController;
