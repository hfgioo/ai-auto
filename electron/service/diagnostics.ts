import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import archiver from 'archiver';
import { app } from 'electron';
import { logger as mainLogger } from 'ee-core/log';
import { getBusinessLogsDir, getBusinessRoot } from './paths';

export type DiagnosticsLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RendererLogPayload {
  level?: DiagnosticsLogLevel;
  category?: string;
  message?: string;
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

const MAX_RENDERER_LOG_LINE_CHARS = 24_000;
const MAX_LOG_DATA_CHARS = 12_000;
const MAX_LOG_FILES = 30;
const MAX_EXPORT_FILE_BYTES = 20 * 1024 * 1024;

const MAIN_LOG_NAMES = new Set(['koma.log', 'koma-error.log', 'ee-core.log']);
const RENDERER_LOG_FILE_PREFIX = 'koma-renderer-';
const RENDERER_CONSOLE_LOG_FILE_PREFIX = 'koma-console-';
const SENSITIVE_KEY_PATTERN = /(api[-_]?key|authorization|bearer|token|password|passwd|secret|credential|cookie)/i;

function normalizeRootPath(rootPath: string): string {
  const value = String(rootPath || '').trim();
  return value ? path.resolve(value) : path.resolve(getBusinessRoot());
}

function ensureZipPath(destPath: string): string {
  const raw = String(destPath || '').trim();
  if (!raw) {
    throw new Error('Export path is required');
  }
  const resolved = path.resolve(raw);
  const zipPath = resolved.toLowerCase().endsWith('.zip') ? resolved : `${resolved}.zip`;
  assertExportPathAllowed(zipPath);
  return zipPath;
}

function formatDate(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/(sk-[A-Za-z0-9_-]{12,})/gi, '[REDACTED_KEY]')
    .replace(/(api[_-]?key["'\s:=]+)[^"',\s}]+/gi, '$1[REDACTED]');
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (key, item) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]';
      if (typeof item === 'bigint') return item.toString();
      if (typeof item === 'string') return redactText(item);
      if (item instanceof Error) {
        return {
          name: item.name,
          message: item.message,
          stack: item.stack,
        };
      }
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
  } catch (err) {
    return JSON.stringify({
      serializationError: err instanceof Error ? err.message : String(err),
      value: String(value),
    });
  }
}

function sanitizeLogLevel(value: unknown): DiagnosticsLogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value;
  }
  return 'info';
}

function sanitizeLogSegment(value: unknown, fallback: string): string {
  const raw = String(value || '').trim();
  const cleaned = raw.replace(/[^A-Za-z0-9._:-]/g, '-').replace(/-+/g, '-').slice(0, 80);
  return cleaned || fallback;
}

function mapConsoleLevel(level: unknown): DiagnosticsLogLevel {
  if (level === 'error' || level === 3) return 'error';
  if (level === 'warning' || level === 'warn' || level === 2) return 'warn';
  if (level === 'debug' || level === 0) return 'debug';
  return 'info';
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertExportPathAllowed(filePath: string): void {
  const normalized = path.resolve(filePath);
  const roots = [
    app.getPath('home'),
    app.getPath('appData'),
    app.getPath('userData'),
    app.getPath('temp'),
    app.getPath('desktop'),
    app.getPath('documents'),
    app.getPath('downloads'),
    getBusinessRoot(),
  ].map(root => path.resolve(root));
  if (!roots.some(root => isInside(root, normalized))) {
    throw new Error('Export path is outside allowed directories');
  }
}

function toPublicLogFileInfo(file: DiagnosticsLogFileInfo): DiagnosticsLogFileInfo {
  return {
    name: file.name,
    relativePath: file.relativePath,
    size: file.size,
    modifiedAt: file.modifiedAt,
    kind: file.kind,
  };
}

function normalizeArchivePath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class DiagnosticsService {
  private storageRoot = normalizeRootPath('');
  private logsDir = getBusinessLogsDir();

  init(storageRoot: string): void {
    this.setStorageRoot(storageRoot);
  }

  setStorageRoot(storageRoot: string): string {
    this.storageRoot = normalizeRootPath(storageRoot);
    this.logsDir = path.join(this.storageRoot, 'logs');
    fs.mkdirSync(this.logsDir, { recursive: true });
    fs.mkdirSync(this.getRendererLogsDir(), { recursive: true });
    fs.mkdirSync(this.getConsoleLogsDir(), { recursive: true });
    try {
      app.setAppLogsPath(this.logsDir);
    } catch (err) {
      mainLogger.warn('[diagnostics] setAppLogsPath failed', err);
    }
    return this.logsDir;
  }

  getStorageRoot(): string {
    return this.storageRoot;
  }

  getLogsDir(): string {
    return this.logsDir;
  }

  getElectronLogsDir(): string {
    try {
      return app.getPath('logs');
    } catch {
      return this.logsDir;
    }
  }

  getRendererLogsDir(): string {
    return path.join(this.logsDir, 'renderer');
  }

  getConsoleLogsDir(): string {
    return path.join(this.logsDir, 'console');
  }

  async appendRendererLog(payload: RendererLogPayload): Promise<{ success: true }> {
    const source = payload?.source === 'console' || payload?.source === 'error' ? payload.source : 'logger';
    const level = sanitizeLogLevel(payload?.level);
    const category = sanitizeLogSegment(payload?.category, source === 'logger' ? 'Renderer' : 'Console');
    const timestamp = Number.isNaN(Date.parse(String(payload?.timestamp || '')))
      ? new Date().toISOString()
      : new Date(String(payload.timestamp)).toISOString();
    const message = clampText(redactText(String(payload?.message || '')), MAX_RENDERER_LOG_LINE_CHARS);
    const data = payload?.data === undefined
      ? ''
      : ` | ${clampText(safeJson(payload.data), MAX_LOG_DATA_CHARS)}`;
    const line = `[${timestamp}] [${level.toUpperCase()}] [${category}] ${message}${data}${os.EOL}`;
    const dir = source === 'logger' ? this.getRendererLogsDir() : this.getConsoleLogsDir();
    const filePrefix = source === 'logger' ? RENDERER_LOG_FILE_PREFIX : RENDERER_CONSOLE_LOG_FILE_PREFIX;
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.appendFile(
      path.join(dir, `${filePrefix}${formatDate(Date.parse(timestamp))}.log`),
      line,
      'utf-8'
    );
    await this.pruneLogFiles(dir, filePrefix);
    return { success: true };
  }

  async appendConsoleMessage(details: {
    level?: unknown;
    message?: string;
    sourceId?: string;
    lineNumber?: number;
  }): Promise<void> {
    const message = String(details.message || '');
    if (!message.trim()) return;
    await this.appendRendererLog({
      source: 'console',
      level: mapConsoleLevel(details.level),
      category: 'WebContents',
      message,
      data: {
        sourceId: details.sourceId || '',
        lineNumber: details.lineNumber || 0,
      },
      timestamp: new Date().toISOString(),
    });
  }

  async listLogs(): Promise<DiagnosticsLogSummary> {
    const files = await this.collectLogFiles();
    const totalSize = files.reduce((sum, item) => sum + item.size, 0);
    return {
      storageRoot: this.storageRoot,
      logsDir: this.logsDir,
      electronLogsDir: this.getElectronLogsDir(),
      files: files.map(toPublicLogFileInfo),
      totalSize,
    };
  }

  async getUsage(): Promise<DiagnosticsUsageSummary> {
    const files = await this.collectLogFiles();
    return {
      storageRoot: this.storageRoot,
      logsDir: this.logsDir,
      totalSize: files.reduce((sum, item) => sum + item.size, 0),
      fileCount: files.length,
    };
  }

  async clearRendererLogs(): Promise<{ success: true; removed: number }> {
    return this.clearLogs({ rendererOnly: true });
  }

  async clearLogs(options: { rendererOnly?: boolean } = {}): Promise<{ success: true; removed: number }> {
    let removed = 0;
    const files = await this.collectLogFiles();
    for (const file of files) {
      if (options.rendererOnly && file.kind !== 'renderer') continue;
      await fs.promises.rm(path.join(file.baseDir, file.relativePath), { force: true });
      removed += 1;
    }
    return { success: true, removed };
  }

  async exportLogs(destPath: string): Promise<DiagnosticsExportResult> {
    const zipPath = ensureZipPath(destPath);
    await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });

    const files = await this.collectLogFiles();
    const manifest = {
      exportedAt: new Date().toISOString(),
      appName: app.getName(),
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      storageRoot: this.storageRoot,
      logsDir: this.logsDir,
      electronLogsDir: this.getElectronLogsDir(),
      files: files.map(toPublicLogFileInfo),
    };

    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });

      output.on('close', () => {
        resolve({
          success: true,
          path: zipPath,
          fileCount: files.length,
          totalSize: archive.pointer(),
        });
      });
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);

      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
      for (const file of files) {
        const absolutePath = path.join(file.baseDir, file.relativePath);
        archive.file(absolutePath, {
          name: normalizeArchivePath(path.join(file.rootLabel, file.relativePath)),
        });
      }

      archive.finalize();
    });
  }

  private async pruneLogFiles(dir: string, prefix: string): Promise<void> {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const files: Array<{ name: string; mtimeMs: number }> = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.log')) continue;
        const stat = await fs.promises.stat(path.join(dir, entry.name));
        files.push({ name: entry.name, mtimeMs: stat.mtimeMs });
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const file of files.slice(MAX_LOG_FILES)) {
        await fs.promises.rm(path.join(dir, file.name), { force: true });
      }
    } catch (err) {
      mainLogger.warn('[diagnostics] prune renderer logs failed', err);
    }
  }

  private async collectLogFiles(): Promise<Array<DiagnosticsLogFileInfo & {
    baseDir: string;
    rootLabel: string;
  }>> {
    const results: Array<DiagnosticsLogFileInfo & { baseDir: string; rootLabel: string }> = [];
    const seen = new Set<string>();
    const roots = [
      { dir: this.logsDir, label: 'storage-logs' },
      { dir: this.getElectronLogsDir(), label: 'electron-logs' },
    ];

    for (const root of roots) {
      if (!root.dir || !(await exists(root.dir))) continue;
      const rootDir = path.resolve(root.dir);
      const walk = async (currentDir: string, depth: number): Promise<void> => {
        if (depth > 3) return;
        let entries: fs.Dirent[];
        try {
          entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const absolutePath = path.join(currentDir, entry.name);
          if (!isInside(rootDir, absolutePath)) continue;
          if (entry.isDirectory()) {
            await walk(absolutePath, depth + 1);
            continue;
          }
          if (!entry.isFile() || !this.isLogFile(entry.name)) continue;
          let stat: fs.Stats;
          try {
            stat = await fs.promises.stat(absolutePath);
          } catch {
            continue;
          }
          if (stat.size > MAX_EXPORT_FILE_BYTES) continue;
          const real = path.resolve(absolutePath);
          if (seen.has(real)) continue;
          seen.add(real);
          const relativePath = path.relative(rootDir, absolutePath);
          results.push({
            name: entry.name,
            relativePath,
            baseDir: rootDir,
            rootLabel: root.label,
            size: stat.size,
            modifiedAt: stat.mtimeMs,
            kind: this.resolveLogKind(relativePath, entry.name, root.label),
          });
        }
      };
      await walk(rootDir, 0);
    }

    results.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return results;
  }

  private isLogFile(filename: string): boolean {
    const lower = filename.toLowerCase();
    return lower.endsWith('.log') || lower.endsWith('.txt');
  }

  private resolveLogKind(relativePath: string, filename: string, rootLabel: string): DiagnosticsLogFileInfo['kind'] {
    const normalized = normalizeArchivePath(relativePath);
    if (normalized.startsWith('renderer/')) return 'renderer';
    if (normalized.startsWith('console/')) return 'renderer';
    if (MAIN_LOG_NAMES.has(filename)) return 'main';
    if (rootLabel === 'electron-logs') return 'electron';
    return 'other';
  }
}

export const diagnosticsService = new DiagnosticsService();
export default diagnosticsService;
