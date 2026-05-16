#!/usr/bin/env node
/**
 * 构建内置插件并复制到 build/extraResources/builtin-plugins/
 *
 * 工作流程：
 *   1. 读取 INTERNAL_PLUGINS 列表
 *   2. 对每个插件执行 npm run build（dist 缺失或源码/manifest/package 更新时重建，可通过 --force 强制）
 *   3. 将 manifest.json + dist/ + README.md 复制到 build/extraResources/builtin-plugins/<slug>/
 *
 * 在 `npm run build` 之前自动运行；用户也可单独执行：
 *   node scripts/build-builtin-plugins.cjs [--force]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 内置插件清单（slug == 目录名）
const INTERNAL_PLUGINS = [];

const ROOT = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'packages', 'plugins');
const DEST_DIR = path.join(ROOT, 'build', 'extraResources', 'builtin-plugins');

const FORCE = process.argv.includes('--force');

function log(msg) {
  console.log(`[build-builtin-plugins] ${msg}`);
}

function rmrf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}

function ensureDependencies(pluginPath) {
  const nodeModulesPath = path.join(pluginPath, 'node_modules');
  const pkgPath = path.join(pluginPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  if (fs.existsSync(nodeModulesPath)) return;
  log(`install deps in ${path.basename(pluginPath)}`);
  execSync('npm install --no-audit --no-fund --silent', {
    cwd: pluginPath,
    stdio: 'inherit',
  });
}

function newestMtimeMs(target) {
  if (!fs.existsSync(target)) return 0;

  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;

  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(target)) {
    newest = Math.max(newest, newestMtimeMs(path.join(target, entry)));
  }
  return newest;
}

function oldestMtimeMs(files) {
  let oldest = Infinity;
  for (const file of files) {
    if (!fs.existsSync(file)) return 0;
    oldest = Math.min(oldest, fs.statSync(file).mtimeMs);
  }
  return oldest === Infinity ? 0 : oldest;
}

function getBuildInputMtime(pluginPath) {
  return Math.max(
    newestMtimeMs(path.join(pluginPath, 'src')),
    newestMtimeMs(path.join(pluginPath, 'manifest.json')),
    newestMtimeMs(path.join(pluginPath, 'package.json')),
    newestMtimeMs(path.join(pluginPath, 'package-lock.json')),
    newestMtimeMs(path.join(pluginPath, 'tsconfig.json'))
  );
}

function buildPlugin(slug) {
  const pluginPath = path.join(PLUGINS_DIR, slug);
  if (!fs.existsSync(pluginPath)) {
    throw new Error(`插件目录不存在: ${pluginPath}`);
  }

  const pkgPath = path.join(pluginPath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`插件缺少 package.json: ${pkgPath}`);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

  const distPath = path.join(pluginPath, 'dist');
  const requiredDistFiles = [
    path.join(distPath, 'backend.js'),
    path.join(distPath, 'ui', 'main.js'),
  ];
  const hasDist = requiredDistFiles.every((file) => fs.existsSync(file));
  const inputMtime = getBuildInputMtime(pluginPath);
  const outputMtime = hasDist ? oldestMtimeMs(requiredDistFiles) : 0;
  const isStale = hasDist && inputMtime > outputMtime;

  if (FORCE || !hasDist || isStale) {
    if (pkg.scripts && pkg.scripts.build) {
      ensureDependencies(pluginPath);
      const reason = FORCE ? 'force' : !hasDist ? 'missing dist' : 'source changed';
      log(`build plugin: ${slug} (${reason})`);
      execSync('npm run build', { cwd: pluginPath, stdio: 'inherit' });
    } else {
      log(`skip build (no build script): ${slug}`);
    }
  } else {
    log(`reuse dist: ${slug} (up to date; use --force to rebuild)`);
  }
}

function stagePlugin(slug) {
  const src = path.join(PLUGINS_DIR, slug);
  const manifestPath = path.join(src, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`插件缺少 manifest.json: ${manifestPath}`);
  }

  const dst = path.join(DEST_DIR, slug);
  rmrf(dst);
  fs.mkdirSync(dst, { recursive: true });

  // 复制必要文件：manifest.json、dist/、README.md（如有）
  for (const item of ['manifest.json', 'README.md', 'dist']) {
    const s = path.join(src, item);
    if (!fs.existsSync(s)) continue;
    copyRecursive(s, path.join(dst, item));
  }

  log(`staged: ${slug} -> ${path.relative(ROOT, dst)}`);
}

function main() {
  log(`root = ${ROOT}`);
  log(`dest = ${path.relative(ROOT, DEST_DIR)}`);

  fs.mkdirSync(DEST_DIR, { recursive: true });

  for (const slug of INTERNAL_PLUGINS) {
    try {
      buildPlugin(slug);
      stagePlugin(slug);
    } catch (err) {
      console.error(`[build-builtin-plugins] 失败: ${slug}`);
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    }
  }

  log(`完成，共 ${INTERNAL_PLUGINS.length} 个内置插件`);
}

main();
