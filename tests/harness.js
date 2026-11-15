// 测试脚手架:在不修改生产代码的前提下加载真实 main.js。
// 只替换 Electron 平台 API 与 wallpaper 包,生产逻辑本身原样执行。
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Module = require('node:module');

const TESTS_DIR = __dirname;
const MOCK_ELECTRON = path.join(TESTS_DIR, 'mocks', 'electron.js');
const MOCK_WALLPAPER = path.join(TESTS_DIR, 'mocks', 'wallpaper.js');
const MAIN_JS = path.resolve(__dirname, '..', 'src', 'main', 'main.js');

// 1) CJS require 拦截:require('electron') / require('wallpaper')
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return require(MOCK_ELECTRON);
  if (request === 'wallpaper') return require(MOCK_WALLPAPER);
  return origLoad.call(this, request, parent, isMain);
};

// 1.5) 记录 main.js 打开的 fs.watch 句柄:测试结束前必须全部 close,
//      否则删临时目录时 libuv 会断言失败(这是测试脚手架问题,不是生产代码缺陷)
const fsMod = require('node:fs');
const origWatch = fsMod.watch;
const openWatchers = [];
if (!origWatch.__acgPatched) {
  const patched = function (...args) {
    const w = origWatch.apply(this, args);
    openWatchers.push(w);
    return w;
  };
  patched.__acgPatched = true;
  fsMod.watch = patched;
}
function closeAllWatchers() {
  while (openWatchers.length) {
    const w = openWatchers.pop();
    try { w.close(); } catch {}
  }
}

// 2) ESM 动态 import 拦截:main.js 里 await import('wallpaper')
let hooksRegistered = false;
function registerEsmHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'electron') return { url: pathToFileURL(MOCK_ELECTRON).href, shortCircuit: true, format: 'commonjs' };
      if (specifier === 'wallpaper') return { url: pathToFileURL(MOCK_WALLPAPER).href, shortCircuit: true, format: 'commonjs' };
      return nextResolve(specifier, context);
    },
  });
}

// 加载一份全新的 main.js 实例(独立模块级状态),返回该实例专属的 electron mock
// opts.mainPath 可指定其它版本的 main.js(用于新旧版本回归对照)
function loadMain(opts) {
  registerEsmHooks();
  const o = opts || {};
  const target = o.mainPath || MAIN_JS;
  delete require.cache[require.resolve(MOCK_ELECTRON)];
  delete require.cache[require.resolve(target)];
  const electronMock = require(MOCK_ELECTRON);
  electronMock.__init(o);
  const main = require(target);
  return { main, electron: electronMock, state: electronMock.__state };
}

// 等待 app.whenReady().then(...) 内的异步初始化跑完(tray/window 创建完成)
async function waitBoot(state, timeoutMs) {
  const limit = Date.now() + (timeoutMs || 3000);
  while (Date.now() < limit) {
    if (state.trays.length > 0 || state.windows.length > 0) { await new Promise(r => setTimeout(r, 60)); return true; }
    await new Promise(r => setTimeout(r, 15));
  }
  return false;
}

const wallpaperCalls = () => (globalThis.__wallpaperCalls || []);
const setWallpaperBehavior = (b) => { require(MOCK_WALLPAPER).resetWallpaper(b); };

// fs.promises.readFile 插桩:在指定文件被读取后执行回调(用于精确构造并发时序,
// 例如"事务快照后、归档前 current 被外部删除"这种竞态)。不改生产代码,只在测试进程内挂钩。
const fsp = require('node:fs/promises');
const origReadFile = fsp.readFile;
let readFileHook = null;
if (!origReadFile.__acgPatched) {
  const patched = async function (p, ...rest) {
    const result = await origReadFile.call(this, p, ...rest);
    if (readFileHook) await readFileHook(String(p), result);
    return result;
  };
  patched.__acgPatched = true;
  fsp.readFile = patched;
}
const setReadFileHook = (fn) => { readFileHook = fn; };

// fs.promises.rename 插桩:用于验证 saveConfig 原子写失败时不破坏原文件
const origRename = fsp.rename;
let renameFailPredicate = null;
if (!origRename.__acgPatched) {
  const patched = async function (a, b) {
    if (renameFailPredicate && renameFailPredicate(String(a), String(b))) throw new Error('mock rename 失败(强制)');
    return origRename.call(this, a, b);
  };
  patched.__acgPatched = true;
  fsp.rename = patched;
}
const setRenameFailPredicate = (fn) => { renameFailPredicate = fn; };

module.exports = {
  loadMain, waitBoot, wallpaperCalls, setWallpaperBehavior, closeAllWatchers, openWatchers,
  setReadFileHook, setRenameFailPredicate, MAIN_JS, MOCK_ELECTRON, MOCK_WALLPAPER,
};
