// 测试用 Electron 主进程 API 模拟层。
// 只替换 Electron 平台 API(窗口/托盘/菜单/路径/IPC 注册),不触碰被测的生产逻辑。
// 每次 require 本文件都得到独立实例(harness 会清除 require 缓存),因此多个测试环境互不干扰。

const state = {
  userDataDir: '',
  picturesDir: '',
  ipcHandlers: new Map(),
  appEvents: new Map(),
  singleInstanceLock: true,
  holdReady: false,
  quitCalled: 0,
  whenReadyCalled: 0,
  windows: [],
  trays: [],
  browserWindowOptions: [],
  device: {},
};

function __init(opts) {
  const o = opts || {};
  state.userDataDir = o.userDataDir;
  state.picturesDir = o.picturesDir;
  state.singleInstanceLock = o.singleInstanceLock !== undefined ? o.singleInstanceLock : true;
  state.holdReady = !!o.holdReady;
}

class BrowserWindow {
  constructor(options) {
    this.options = options;
    state.browserWindowOptions.push(options);
    this._destroyed = false;
    this._minimized = false;
    this._visible = false;
    this._focused = false;
    this._events = new Map();
    this.sentMessages = [];
    this.webContents = { send: (channel, payload) => { this.sentMessages.push({ channel, payload }); } };
    state.windows.push(this);
  }
  loadFile() { this.loadedFile = arguments[0]; return Promise.resolve(); }
  once(ev, cb) { this._events.set(ev, cb); }
  on(ev, cb) { this._events.set(ev, cb); }
  show() { this._visible = true; }
  hide() { this._visible = false; }
  focus() { this._focused = true; }
  isMinimized() { return this._minimized; }
  restore() { this._minimized = false; this._restored = true; }
  isDestroyed() { return this._destroyed; }
  destroy() { this._destroyed = true; }
  emit(ev, ...args) { const cb = this._events.get(ev); if (cb) cb(...args); }
}

class Tray {
  constructor(icon) { this.icon = icon; this.tooltip = ''; this.menus = []; this._destroyed = false; state.trays.push(this); }
  setContextMenu(menu) { this.menu = menu; this.menus.push(menu); }
  setToolTip(s) { this.tooltip = s; }
  // Electron 33 的 Tray 真实提供 isDestroyed(electron.d.ts:13837),
  // 生产代码 buildTrayMenu 用它做判空,缺了会让被测模块直接抛 TypeError
  isDestroyed() { return this._destroyed; }
  destroy() { this._destroyed = true; this.destroyed = true; }
}

const app = {
  requestSingleInstanceLock: () => state.singleInstanceLock,
  quit: () => { state.quitCalled += 1; },
  on: (ev, cb) => { state.appEvents.set(ev, cb); },
  whenReady: () => {
    state.whenReadyCalled += 1;
    return state.holdReady ? new Promise(() => {}) : Promise.resolve();
  },
  getPath: (name) => {
    if (name === 'userData') return state.userDataDir;
    if (name === 'pictures') return state.picturesDir;
    throw new Error('mock app.getPath 未模拟的 name: ' + name);
  },
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setLoginItemSettings: () => {},
  getVersion: () => '0.0.0-test',
};
app.__emit = (ev, ...args) => { const cb = state.appEvents.get(ev); if (cb) cb(...args); };

const ipcMain = {
  handle: (channel, fn) => { state.ipcHandlers.set(channel, fn); },
  on: (channel, fn) => { state.ipcHandlers.set(channel, fn); },
};

const Menu = { buildFromTemplate: (tpl) => ({ template: tpl }) };
const shell = { openPath: () => Promise.resolve('') };
const nativeImage = {
  createFromPath: () => ({ resize: () => ({ isEmpty: () => true }) }),
  createFromBuffer: () => ({ isEmpty: () => false }),
};

module.exports = { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, __state: state, __init };
