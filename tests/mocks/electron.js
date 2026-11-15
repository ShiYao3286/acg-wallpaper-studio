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
    const wcEvents = new Map();
    this._wcEvents = wcEvents;
    this.webContents = {
      send: (channel, payload) => { this.sentMessages.push({ channel, payload }); },
      on: (ev, cb) => { wcEvents.set(ev, cb); },
      once: (ev, cb) => { wcEvents.set(ev, cb); },
      emit: (ev, ...args) => { const cb = wcEvents.get(ev); if (cb) cb(...args); },
      setWindowOpenHandler: (fn) => { this._windowOpenHandler = fn; },
      getURL: () => this.loadedUrl || '',
    };
    state.windows.push(this);
  }
  loadFile() { this.loadedFile = arguments[0]; return Promise.resolve(); }
  loadURL(u) {
    this.loadedUrl = u;
    // 登录窗口的 will-navigate 拦截器需要 webContents.on,
    // 这里一并记录事件回调,供导航白名单测试直接触发。
    return Promise.resolve();
  }
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

// ---------------------------------------------------------------------------
// session / safeStorage 模拟(阶段3 豆包登录链路需要)
//
// 这两块是 Electron 平台 API,不是被测的生产逻辑,因此在 mock 层替换。
// 刻意做成"可编程的假实现":测试可以注入 Cookie 列表、让 remove 抛错、
// 让 safeStorage 不可用,从而覆盖真实环境里很难复现的失败分支。
//
// 注意:这里【不模拟真实网络与真实登录】。凡是标注"mock"的用例,
// 都不代表真实豆包账号能跑通 —— 真实账号验证是独立的人工步骤。
// ---------------------------------------------------------------------------
const sessionState = {
  partitions: new Map(),   // partition -> ses 对象
  createdPartitions: [],   // 创建顺序,便于断言"只建了一个豆包分区"
};

// 每个 partition 一个独立 cookie jar:Map<"domain|path|name", {name,value,domain,path,secure}>
function mkSession(partition) {
  const jar = new Map();
  const key = (c) => String(c.domain || '').replace(/^\./, '') + '|' + (c.path || '/') + '|' + c.name;
  const ses = {
    partition,
    cookies: {
      // get({url}) 按 domain 后缀匹配,贴近 Electron 的真实语义
      async get(filter) {
        const opt = filter || {};
        if (opt.url) {
          let host = '';
          try { host = new URL(opt.url).hostname; } catch { return []; }
          const out = [];
          for (const c of jar.values()) {
            const d = String(c.domain || '').replace(/^\./, '');
            if (host === d || host.endsWith('.' + d)) out.push({ ...c });
          }
          return out;
        }
        return [...jar.values()].map(c => ({ ...c }));
      },
      async remove(url, name) {
        if (sessionState.removeThrows) throw new Error('mock cookies.remove 失败');
        let host = '';
        try { host = new URL(url).hostname; } catch { return; }
        for (const [k, c] of jar) {
          const d = String(c.domain || '').replace(/^\./, '');
          if ((host === d || host.endsWith('.' + d)) && c.name === name) { jar.delete(k); return; }
        }
      },
      async set(domain, name, value, opts) {
        const o = opts || {};
        const c = { name, value, domain, path: o.path || '/', secure: o.secure !== false };
        jar.set(key(c), c);
      },
      async flushStore() { if (sessionState.flushThrows) throw new Error('mock flushStore 失败'); },
      __jar: jar,
    },
    __seed(list) { for (const c of list) jar.set(key(c), { ...c }); },
    __dump() { return [...jar.values()].map(c => c.name); },
  };
  return ses;
}

const session = {
  fromPartition: (partition) => {
    if (!sessionState.partitions.has(partition)) {
      sessionState.partitions.set(partition, mkSession(partition));
      sessionState.createdPartitions.push(partition);
    }
    return sessionState.partitions.get(partition);
  },
  defaultSession: null,
};
session.defaultSession = mkSession('__default__');

const safeStorageState = { available: true, failEncrypt: false, failDecrypt: false };
const SAFE_KEY = Buffer.from('acg-test-safe-key-0123456789abcdef');
function safeXform(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ SAFE_KEY[i % SAFE_KEY.length];
  return out;
}
const safeStorage = {
  isEncryptionAvailable: () => safeStorageState.available,
  encryptString: (s) => {
    if (safeStorageState.failEncrypt) throw new Error('mock encrypt 失败');
    return safeXform(Buffer.from(s, 'utf8'));
  },
  decryptString: (b) => {
    if (safeStorageState.failDecrypt) throw new Error('mock decrypt 失败');
    return safeXform(b).toString('utf8');
  },
};

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

module.exports = {
  app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, session, safeStorage,
  __state: state, __init,
  __sessionState: sessionState,
  __safeStorageState: safeStorageState,
  __resetSessionState: () => {
    sessionState.partitions.clear();
    sessionState.createdPartitions.length = 0;
    sessionState.removeThrows = false;
    sessionState.flushThrows = false;
    safeStorageState.available = true;
    safeStorageState.failEncrypt = false;
    safeStorageState.failDecrypt = false;
  },
};
