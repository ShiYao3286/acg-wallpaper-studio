// ACG壁纸工作室 - 主进程
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { DEFAULT_CONFIG, buildRandomPrompt } = require('../shared/defaults');
const { stripBom } = require('../shared/text');
const { ok, fail, failFrom, ERROR_CODES } = require('../shared/contracts');
const { assertService, assertPreset, assertId, assertKind, assertReason, assertApiBase,
  assertTag, assertRandomMode, assertTheme, assertBool,
  assertServiceField, assertPresetField, assertArrayIndex, assertFavoriteName, argFail } = require('./validate');
// 拆分出的三个子模块(依赖方向:main.js -> services/system,子模块不反向依赖 main.js)
const configService = require('./services/config-service');
const scheduler = require('./system/scheduler');
const trayMod = require('./system/tray');
// 阶段2:Provider 插件系统。内置 Provider 与未来外部插件走同一套协议与注册表。
const providerRegistry = require('./plugins/provider-registry');
const loliconProvider = require('./plugins/builtin/lolicon-provider');
const openaiImageProvider = require('./plugins/builtin/openai-image-provider');
const openaiTextProvider = require('./plugins/builtin/openai-text-provider');
const pluginLoader = require('./plugins/plugin-loader');
// 换壁纸事务(阶段2 第6步从 main.js 迁出)
const wallpaperService = require('./services/wallpaper-service');

let win = null;
let tray = null;
// 定时器实例由 system/scheduler 自己持有,main.js 不再保留 scheduleTimer,
// 需要的状态统一通过 scheduler.isRunning() 查询。
let lastInfo = '';
let lastRun = null;   // { time, ok, detail }
let changing = false;
let wpModule = null; // wallpaper 包是 ESM,动态加载并缓存
async function setWallpaper(p) {
  if (!wpModule) {
    const mod = await import('wallpaper');
    wpModule = (typeof mod.setWallpaper === 'function') ? mod : mod.default;
  }
  await wpModule.setWallpaper(p);
}

// ---------- 模型列表缓存(避免 get-status 同步等待网络) ----------
let modelsCache = { key: '', models: [] };
let modelsRefreshing = false;
// 模型列表刷新失败的原因(空串=无错误)。刷新失败不再静默吞掉:
// get-status 会把它一并返回,渲染层据此提示"模型列表获取失败",用户不必面对一个空下拉框猜原因。
let modelsCacheError = '';
let modelsCacheErrorNotified = false;
const imgSvcKey = (svc) => svc.id + '|' + apiBase(svc.apiBase);
function refreshImageModels(svc) {
  if (!svc || modelsRefreshing) return;
  const key = imgSvcKey(svc);
  if (modelsCache.key === key) return;
  modelsRefreshing = true;
  fetchServiceModels(svc).then((models) => {
    modelsCache = { key, models };
    modelsCacheError = '';
    modelsCacheErrorNotified = false;
    notifyUiRefresh('models');
  }).catch((e) => {
    // 只记录,不抛:这是后台刷新,不影响 get-status 的同步返回
    modelsCacheError = (e && e.message) || String(e);
    // 只在"从无错误变为有错误"时推送一次,避免 UI 刷新与失败推送互相触发
    if (!modelsCacheErrorNotified) {
      modelsCacheErrorNotified = true;
      notifyUiRefresh('models');
    }
  }).finally(() => { modelsRefreshing = false; });
}

// ---------- 自身写入标记(区分本程序写入与旧脚本写入) ----------
const SELF_WRITE_WINDOW = 5000; // 5 秒:覆盖 setWallpaper 等异步调用的耗时
let selfWriteAt = 0;
const markSelfWrite = () => { selfWriteAt = Date.now(); };

// ---------- 换图互斥锁(任务结束后释放,避免并发操作) ----------
function acquireChanging() {
  if (changing) return false;
  changing = true;
  return true;
}
function releaseChanging() {
  changing = false;
}

// ---------- Provider 注册(阶段2) ----------
// 在模块加载阶段完成注册,先于任何 IPC handler 与换图流程,
// 保证后续 providerRegistry.get() 一定拿得到内置实现。
// 用 registerAll 一次性注册:任一内置 Provider 协议不合规会立即抛错,
// 使"内置实现写坏了"在启动时就暴露,而不是等到用户点「立即换一张」。
try {
  providerRegistry.registerAll([loliconProvider, openaiImageProvider, openaiTextProvider]);
} catch (err) {
  // 注册失败属于开发期错误(内置 Provider 不该校验不过),
  // 这里不吞掉:直接抛出,让启动失败并暴露问题,避免带病运行。
  throw new Error('内置 Provider 注册失败: ' + ((err && err.message) || err));
}

// ---------- 外部插件发现(阶段2 第4步) ----------
// 只做"发现 + 登记为禁用态",不执行任何插件代码。
// 外部插件必须由用户显式启用才会 require —— 避免把来路不明的代码在启动时自动跑起来。
const pluginsRoot = () => path.join(app.getPath('userData'), 'plugins');
let pluginScan = { found: [], skipped: [] };
function scanExternalPlugins() {
  const r = pluginLoader.discover(pluginsRoot());
  pluginScan = r;
  return r;
}
// 插件启用状态存在配置里(plugin.enabled 数组),而不是写回插件目录。
// 这样插件目录保持只读语义,用户手动拷贝插件不会因为权限问题失败。
function isPluginEnabled(cfg, id) {
  const list = (cfg && cfg.plugins && Array.isArray(cfg.plugins.enabled)) ? cfg.plugins.enabled : [];
  return list.indexOf(id) >= 0;
}

// 启动时恢复用户此前已启用的外部插件。
// 单个插件失败只记录在 pluginScan.skipped 中,不抛错、不阻塞启动。
async function restoreEnabledPlugins() {
  const cfg = await loadConfig();
  const enabledIds = (cfg.plugins && Array.isArray(cfg.plugins.enabled)) ? cfg.plugins.enabled : [];
  if (!enabledIds.length) return { restored: [], failed: [] };
  const scan = scanExternalPlugins();
  const restored = [];
  const failed = [];
  for (const id of enabledIds) {
    const item = scan.found.find(x => x.id === id);
    if (!item) { failed.push({ id, reason: '插件目录已不存在或 manifest 失效' }); continue; }
    const loaded = pluginLoader.loadOne(item);
    if (!loaded.ok) { failed.push({ id, reason: loaded.reason }); continue; }
    try {
      providerRegistry.register(loaded.provider);
      providerRegistry.setEnabled(id, true);
      restored.push(id);
    } catch (e) {
      failed.push({ id, reason: (e && e.message) || String(e) });
    }
  }
  return { restored, failed };
}

// ---------- 配置存取 ----------
// 实现已迁至 services/config-service.js;这里只做转发 + 保存后重新应用调度。
// applySchedule 是副作用,留在 main.js 触发,使 config-service 不需要反向依赖 scheduler。
configService.init({ userDataDir: app.getPath('userData') });
const confDir = configService.confDir;
const confFile = configService.confFile;
const deepMerge = configService.deepMerge;
const FORBIDDEN_KEYS = configService.FORBIDDEN_KEYS;
const loadConfig = () => configService.loadConfig();
async function saveConfig(patch) {
  const cfg = await configService.saveConfig(patch);
  applySchedule(cfg);
  return cfg;
}

// ---------- 壁纸目录 ----------
const wallDir = () => path.join(app.getPath('pictures'), 'ACG_Wallpaper');
async function ensureDir() { await fsp.mkdir(wallDir(), { recursive: true }); }
const currentPath = () => path.join(wallDir(), 'current.jpg');

// ---------- 游戏检测 ----------
async function gameRunning(cfg) {
  if (!cfg.gameCheck.enabled) return null;
  try {
    const { exec } = require('child_process');
    const out = await new Promise((res, rej) => {
      exec('tasklist /fo csv /nh', { encoding: 'utf8', timeout: 8000 }, (e, o) => e ? rej(e) : res(o));
    });
    const lower = out.toLowerCase();
    for (const p of cfg.gameCheck.processes) {
      if (lower.includes('"' + p.toLowerCase() + '.exe"')) return p;
    }
  } catch {}
  return null;
}

// ---------- 引擎 1: Lolicon 随机二次元 ----------
// 阶段2起实现迁移到 plugins/builtin/lolicon-provider.js,
// 本函数只做"取 Provider + 注入能力"的分发,行为与迁移前完全一致。
async function fetchLolicon(cfg) {
  const provider = providerRegistry.get('lolicon');
  if (!provider) throw new Error('内置 Provider 不可用: lolicon');
  return await provider.fetch({ config: cfg, netFetch });
}

// ---------- 引擎 2: AI 生图 ----------
function findService(cfg, id) {
  return (cfg.services || []).find(s => s.id === id) || null;
}
// 规范化 API 地址:去掉尾部斜杠与多余的 /v1,统一由拼接处补 /v1/...
function apiBase(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}
// ---------- 代理支持 ----------
// undici ProxyAgent:让原生 fetch 走指定 http 代理
let proxyDispatcher = null;
let proxyUrlCurrent = '';
async function getProxyDispatcher() {
  const cfg = await loadConfig();
  const url = (cfg.proxy && cfg.proxy.enabled && cfg.proxy.url) ? cfg.proxy.url.trim() : '';
  if (!url) return null;
  if (proxyUrlCurrent !== url) {
    try {
      const { ProxyAgent } = await import('undici');
      proxyDispatcher = new ProxyAgent(url);
      proxyUrlCurrent = url;
    } catch { proxyDispatcher = null; }
  }
  return proxyDispatcher;
}
// 统一出网入口:自动带代理
async function netFetch(url, opts = {}) {
  const dispatcher = await getProxyDispatcher();
  const opt = { ...opts };
  if (dispatcher) opt.dispatcher = dispatcher;
  return fetch(url, opt);
}

// 连接失败转友好提示
function netErr(e) {
  const msg = e && e.message || String(e);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|connect/i.test(msg)) {
    return '无法连接到 ' + (e?.config?.url || '服务器') + ' — 请确认服务/网关已启动、端口正确';
  }
  return msg;
}

// 把异常映射到契约里的错误码。分类依据是失败的"性质",而不是发生的位置,
// 这样调用方(渲染层/后续阶段)能按 code 做机器判断,不必解析中文文案。
function classifyError(e) {
  const msg = (e && e.message) ? e.message : String(e || '');
  // 网络/远端:连接失败、超时、HTTP 非 2xx
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|aborted|timeout|HTTP \d{3}|connect/i.test(msg)) {
    return ERROR_CODES.E_NET;
  }
  // 本地文件读写
  if (/EACCES|EPERM|ENOENT|EISDIR|ENOSPC|EBUSY|EMFILE|disk|write|read|rename|copyfile|unlink/i.test(msg)) {
    return ERROR_CODES.E_IO;
  }
  // 目标资源不存在(如未配置服务、文件不存在)
  if (/未找到|不存在|没有壁纸/.test(msg)) return ERROR_CODES.E_NOT_FOUND;
  // 状态冲突(如正在换图中)
  if (/正在换图|已在换图|busy/i.test(msg)) return ERROR_CODES.E_STATE;
  return ERROR_CODES.E_IO;
}

// 阶段2起实现迁移到 plugins/builtin/openai-image-provider.js。
// 注意返回契约:Provider 返回 { buffer },本函数解包成 Buffer 保持调用方不变。
async function fetchAI(cfg, serviceId, finalPrompt) {
  const provider = providerRegistry.get('openai-image');
  if (!provider) throw new Error('内置 Provider 不可用: openai-image');
  const res = await provider.generate({
    config: cfg,
    netFetch,
    findService,
    serviceId,
    prompt: finalPrompt,
  });
  return res.buffer;
}

// ---------- 核心: 换壁纸流程(阶段2 第6步迁至 services/wallpaper-service.js) ----------
// 实现已迁出,行为逐字保留。本处只做依赖注入与转发。
// 注入的依赖覆盖:目录/配置/取图/出网/设置壁纸/自写标记/状态上报/互斥锁。
// 子模块不反向 require main.js,依赖方向仍是 main.js -> services -> shared。

// ---------- 联动:监听壁纸目录(旧脚本动作实时感知) ----------
let wallWatcher = null;
let debounceTimer = null;

function startWatcher() {
  if (wallWatcher) return;
  try {
    wallWatcher = fs.watch(wallDir(), { persistent: false }, (event, filename) => {
      if (!filename || /^current\.(jpg|tmp\.jpg)$|^hist_.*\.jpg$|^wallpaper_meta\.json$/.test(filename)) {
        // 区分来源:自身写入窗口内视为 self,否则视为旧脚本等外部写入
        const isSelf = (Date.now() - selfWriteAt) < SELF_WRITE_WINDOW;
        // 防抖:下载/归档会触发多次事件,500ms 合并成一次刷新
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => notifyUiRefresh(isSelf ? 'self' : 'external'), 500);
      }
    });
    wallWatcher.on('error', () => {}); // 目录暂不存在时静默,ensureDir 后重试
  } catch {}
}

function notifyUiRefresh(reason) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('ui-refresh', reason);
  }
  buildTrayMenu(); // 托盘 tooltip 同步最新状态
}

// 读取动作回执(旧脚本或软件自己写的 wallpaper_meta.json)
// 旧脚本(PowerShell 5.1 Set-Content -Encoding UTF8)写出的回执带 BOM,
// 不剥 BOM 会解析失败返回 null,UI 就完全看不到"旧脚本于 X 时更新"的回执。
async function readWallpaperMeta() {
  try {
    return JSON.parse(stripBom(await fsp.readFile(path.join(wallDir(), 'wallpaper_meta.json'), 'utf8')));
  } catch { return null; }
}

// ---------- 旧计划任务停用 ----------
function disableOldTask() {
  return new Promise((res) => {
    const { exec } = require('child_process');
    exec('schtasks /change /tn "ACG-Wallpaper-Auto" /disable', { encoding: 'utf8', timeout: 10000 }, (e) => {
      // fire-and-forget 也必须兜住:saveConfig 抛错会变成 unhandledRejection 直接崩主进程
      if (!e) saveConfig({ migrate: { oldTaskDisabled: true } }).catch(() => {});
      res({ ok: !e, error: e ? e.message : null });
    });
  });
}

// ---------- 托盘 ----------
// 实现已迁至 system/tray.js;全局状态通过 getter 注入,子模块不持有 main.js 的变量。
trayMod.init({
  getTray: () => tray,
  getWin: () => win,
  getLastRun: () => lastRun,
  getLastInfo: () => lastInfo,
  onChangeWallpaper: (reason) => changeWallpaper(reason),
});
const trayIcon = () => trayMod.trayIcon();
const buildTrayMenu = () => trayMod.buildTrayMenu();

// ---------- 工具 ----------
const nowStr = () => new Date().toLocaleString('zh-CN', { hour12: false });
const ts = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); };

wallpaperService.init({
  wallDir,
  currentPath,
  ensureDir,
  loadConfig,
  gameRunning,
  fetchLolicon,
  fetchAI,
  netFetch,
  setWallpaper,
  markSelfWrite,
  buildRandomPrompt,
  classifyError,
  ts,
  nowStr,
  setLastInfo: (v) => { lastInfo = v; },
  setLastRun: (v) => { lastRun = v; },
  acquireChanging,
  releaseChanging,
  isWinAlive: () => !!(win && !win.isDestroyed()),
  sendRefresh: (reason) => { if (win && !win.isDestroyed()) win.webContents.send('ui-refresh', reason); },
});

const changeWallpaper = (reason) => wallpaperService.changeWallpaper(reason);
const archiveCurrent = () => wallpaperService.archiveCurrent();
const healInterruptedTransaction = () => wallpaperService.healInterruptedTransaction();
const rollbackWallpaper = (tx) => wallpaperService.rollbackWallpaper(tx);
const buildFailureResult = (e, errs) => wallpaperService.buildFailureResult(e, errs);
const pruneHistory = (cfg) => wallpaperService.pruneHistory(cfg);

// ---------- 调度 ----------
// 实现已迁至 system/scheduler.js;换图动作以回调注入,避免子模块反向依赖 main.js。
scheduler.init({ onChange: () => changeWallpaper('schedule') });
const applySchedule = (cfg) => scheduler.applySchedule(cfg);

// ---------- IPC ----------
// 只读通道的失败约定(阶段1):
//   get-config      : 读取/解析失败时 loadConfig 内部已回退到默认配置并返回(安全默认值),
//                     调用方拿到的一定是完整可用对象;不抛错,避免渲染层启动链路被一个坏配置卡死。
//   list-history    : 目录不可读时返回 []（空列表 = 无可展示项,UI 自然降级）。
//   list-favorites  : 同上,并会尝试 mkdir 自愈。
//   list-services   : 配置读失败时 services 为空数组(loadConfig 已兜底)。
//   get-autorun     : 直接读系统登录项,失败由 Electron 抛出(属环境异常,不静默)。
//   read-meta       : 文件缺失/解析失败返回 null(明确表示"没有这条元数据"),不自造记录。
// 共同原则:只读通道不得静默吞掉错误后伪造成功数据,失败必须表现为"空/默认/null"这类可辨识的安全值。
ipcMain.handle('get-config', () => loadConfig());
const CONFIG_TOP_KEYS = new Set(Object.keys(DEFAULT_CONFIG));
ipcMain.handle('save-config', async (e, key, val) => {
  // key 支持 a.b.c 点路径;顶层键必须在默认配置白名单内,并拦截原型污染键
  if (typeof key !== 'string' || !key) return { ok: false, error: '无效的配置键' };
  const parts = key.split('.');
  if (parts.some(x => FORBIDDEN_KEYS.has(x))) return { ok: false, error: '非法配置键' };
  if (!CONFIG_TOP_KEYS.has(parts[0])) return { ok: false, error: '不允许的配置键: ' + parts[0] };
  // 复合键旁路防护:save-service / save-preset 已各自校验元素,但 save-config 能直接
  // 写 services / promptPresets 整键或点路径,绕过那些校验。这里统一收口。
  //
  // 两个原则:
  //   1. 断言函数返回的"清理后对象"必须真正用于落盘,否则清理形同虚设
  //      (旧实现只调用 assertService/assertPreset 却丢弃返回值,__proto__ 修剪等不生效);
  //   2. 点路径必须逐字段校验,不能只护住 apiBase,也不能让任意字段自由通过。
  let value = val;
  // 若走的是"数组元素整体替换"或"数组元素单字段修改",需要把索引改成数字,
  // 否则 patch 里会用字符串键 "0" 拼出对象而不是数组下标。
  let arrayIndex = null;
  try {
    const top = parts[0];
    if (top === 'services' || top === 'promptPresets') {
      const isSvc = top === 'services';
      const assertFull = isSvc ? assertService : assertPreset;
      const assertField = isSvc ? assertServiceField : assertPresetField;
      const label = isSvc ? '服务' : '预设';

      if (parts.length === 1) {
        // 整键替换:用清理后的对象组数
        if (!Array.isArray(val)) throw new Error(top + ' 必须是数组');
        value = val.map(x => assertFull(x));
      } else if (parts.length === 2) {
        // <top>.<index> 整体替换:下标必须合法且目标已存在
        const current = await loadConfig();
        arrayIndex = assertArrayIndex(parts[1], top, current[top]);
        value = assertFull(val);
      } else if (parts.length === 3) {
        // <top>.<index>.<field>:下标 + 字段双重校验
        const current = await loadConfig();
        arrayIndex = assertArrayIndex(parts[1], top, current[top]);
        value = assertField(parts[2], val);
      } else {
        throw new Error('不支持的' + label + '点路径: ' + key);
      }
    }
  } catch (err) {
    return argFail(err);
  }
  // 构造 patch:数组元素路径要把索引段转成数字,
  // 否则会拼出 {"services":{"0":{...}}} 这种对象,与配置里的数组结构不符。
  const patch = {}; let cur = patch;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    // 索引段出现在 i===1 且 arrayIndex 已解析时,用数字键
    const seg = (i === 1 && arrayIndex !== null) ? arrayIndex : parts[i];
    if (isLast) cur[seg] = value;
    else cur = cur[seg] = {};
  }
  // 落盘可能因"原配置损坏/不可读"而中止(见 config-service 的 loadConfigStrict)。
  // 必须把它转成契约结构返回,不能让异常穿透 IPC —— 否则渲染层拿到的是 rejected Promise,
  // 既没有 error 文案也没有 code,用户只看到操作没反应。
  try {
    return await saveConfig(patch);
  } catch (err) {
    // 配置损坏(E_CONFIG_PARSE)是"文件状态不允许写入",归 E_STATE;
    // 读取失败(E_CONFIG_READ 及权限/磁盘类)归 E_IO。
    const code = (err && err.code === 'E_CONFIG_PARSE') ? ERROR_CODES.E_STATE : ERROR_CODES.E_IO;
    return failFrom(err, code, { configAborted: true });
  }
});
// reason 只允许枚举内的值:它是 changeWallpaper() 的分支判据,任意字符串会流入流程与日志
ipcMain.handle('change-wallpaper', (e, reason) => {
  const r = (reason === undefined || reason === null || reason === '') ? 'manual' : reason;
  try {
    assertReason(r);
  } catch (err) {
    return argFail(err);
  }
  return changeWallpaper(r);
});
// 只读通道的失败记录(阶段2 第5步)
// 问题背景:旧实现是 catch { return [] } —— 磁盘不可读与"目录本来就空"在渲染层完全同形,
// 用户只会看到空列表,无从判断是没数据还是出了错。
// 全面改返回形状(包 ok())需同步改 17 处 renderer 调用与 42 处测试断言,
// 且这些通道本身无"业务失败"语义(见方案 §11 延期项说明),收益不抵风险。
// 因此改为:保持返回形状不变(向后兼容),但把失败原因记录下来,经 get-status 暴露给 UI。
const readErrors = { 'list-history': '', 'list-favorites': '', 'get-config': '', 'read-meta': '' };
function noteReadError(channel, err) {
  const msg = (err && err.message) ? err.message : String(err || '');
  if (readErrors[channel] !== msg) readErrors[channel] = msg;
}
function clearReadError(channel) {
  if (readErrors[channel]) readErrors[channel] = '';
}

ipcMain.handle('list-history', async () => {
  try {
    const files = (await fsp.readdir(wallDir())).filter(f => f.endsWith('.jpg')).sort().reverse();
    clearReadError('list-history');
    return files.map(f => ({ name: f, path: path.join(wallDir(), f) }));
  } catch (err) {
    // 目录不存在属于"首次使用,还没有壁纸"的正常状态,不算错误
    if (err && err.code === 'ENOENT') { clearReadError('list-history'); return []; }
    noteReadError('list-history', err);
    return [];
  }
});
ipcMain.handle('use-history', async (e, name) => {
  // 文件名必须是纯文件名:basename 已挡住路径穿越,这里再挡住非字符串入参
  let safeName;
  try {
    safeName = assertId(name, '文件名');
  } catch (err) {
    return argFail(err);
  }
  if (!acquireChanging()) return { ok: false, error: '正在换图中,请稍候' };
  // 事务上下文:进入流程前先快照,"调用前 current 是否存在"是回滚判据
  const tx = { hadCurrent: fs.existsSync(currentPath()), archivedHist: null, touchedCurrent: false };
  try {
    const safe = path.basename(safeName);
    const historyPath = path.join(wallDir(), safe);
    const favoritePath = path.join(wallDir(), 'favorites', safe);
    const isFavorite = !fs.existsSync(historyPath) && fs.existsSync(favoritePath);
    const src = isFavorite ? favoritePath : historyPath;
    if (!fs.existsSync(src)) return { ok: false, error: '文件不存在' };

    await ensureDir();

    // 1. 来源若已是当前壁纸,直接应用,不重复归档
    if (path.resolve(src) === path.resolve(currentPath())) {
      await setWallpaper(currentPath());
      return { ok: true, current: true };
    }

    // 2. 先读出来源图片内容(历史图保持原样,不删除)
    const buf = await fsp.readFile(src);

    // 3. 比对来源与 current 的内容
    //    sameContent 明确记录"磁盘上的 current 已经是来源图本身"这一事实,
    //    它是后面跳过归档与跳过写入的唯一依据;原本没有 current 时恒为 false
    let sameContent = false;
    if (fs.existsSync(currentPath())) {
      const curBuf = await fsp.readFile(currentPath());
      sameContent = curBuf.length === buf.length && curBuf.equals(buf);
    }

    // 4. 归档当前壁纸;内容与来源相同则跳过,避免把同一张图重复归档
    //    归档是回滚的唯一凭据,失败必须中断
    //    markSelfWrite 必须在归档"之前":archiveCurrent 内部会 rename current.jpg,
    //    watcher 会收到事件,不标记会被误判成旧脚本换图;只有真的归档时才标记
    if (!sameContent && fs.existsSync(currentPath())) {
      markSelfWrite();
      tx.archivedHist = await archiveCurrent();
    }

    // 5. 写入 current.jpg;内容完全相同则不写
    //    current 已是目标图,重写一次毫无收益,反而平白打开"写到一半失败"的
    //    破坏窗口,让本来完好的文件承担风险,并让 touchedCurrent 谎报本次改写过
    //    内容不同才写;touchedCurrent 必须在写入"之前"置位:writeFile 可能中途
    //    失败留下半成品,若写在成功之后,失败路径会漏掉清理
    if (!sameContent) {
      tx.touchedCurrent = true;
      markSelfWrite();
      await fsp.writeFile(currentPath(), buf);
    }

    // 6. 设壁纸 —— 失败需回滚文件
    //    内容相同路径下 touchedCurrent 为 false,失败时回滚落入"磁盘未变化"分支,
    //    既不删除也不设置 current,只上报原始错误
    await setWallpaper(currentPath());

    // 7. 同步历史记录与回执(与 changeWallpaper 同一格式)
    //    同样:壁纸已经应用成功,这里的失败不改判定,但错误必须可见(historyWriteError)
    let historyWriteError = '';
    try {
      // 查找来源元数据:
      //   历史图 -> 按 histFile 精确匹配;老数据没有 histFile 时退化为按字节数匹配
      //   收藏图 -> 收藏时未存元数据,退化为按字节数匹配最近一条记录
      let meta = null;
      try {
        // 整体剥一次 BOM(首行可能由 PowerShell 5.1 写出),否则首条记录会被静默跳过
        const raw = stripBom(await fsp.readFile(path.join(wallDir(), 'history.jsonl'), 'utf8'));
        const parts = raw.trim().split('\n');
        const parsed = [];
        for (const l of parts) { try { const r = JSON.parse(l); if (r) parsed.push(r); } catch {} }
        if (!isFavorite) {
          for (let i = parsed.length - 1; i >= 0; i--) {
            if (parsed[i].histFile === safe) { meta = parsed[i]; break; }
          }
        }
        if (!meta) {
          for (let i = parsed.length - 1; i >= 0; i--) {
            if (parsed[i].bytes === buf.length) { meta = parsed[i]; break; }
          }
        }
      } catch {}
      const record = {
        file: 'current.jpg', time: new Date().toISOString(),
        source: meta?.source || (isFavorite ? 'favorite' : 'history'),
        title: meta?.title || '', author: meta?.author || '', pid: meta?.pid || '',
        tag: meta?.tag || '', prompt: meta?.prompt || '', bytes: buf.length,
      };
      markSelfWrite();
      await fsp.appendFile(path.join(wallDir(), 'history.jsonl'), JSON.stringify(record) + '\n', 'utf8');
      const receipt = { time: nowStr(), source: 'app', tag: record.tag, title: record.title,
        author: record.author, pid: record.pid, file: 'current.jpg', bytes: buf.length,
        prompt: record.prompt, randomMode: '' };
      markSelfWrite();
      await fsp.writeFile(path.join(wallDir(), 'wallpaper_meta.json'), JSON.stringify(receipt, null, 2), 'utf8');
    } catch (e) {
      historyWriteError = (e && e.message) || String(e);
    }

    lastInfo = ('已应用' + (isFavorite ? '收藏' : '历史') + '壁纸') + ' · ' + (buf.length / 1024).toFixed(0) + 'KB · ' + nowStr();
    lastRun = { time: nowStr(), ok: true };
    if (historyWriteError) {
      lastRun.detail = '历史记录写入失败: ' + historyWriteError;
      return ok({ historyWriteError });
    }
    return ok();
  } catch (err) {
    // 任一步失败:回滚到调用前状态,并保留原始错误
    // 注意:回滚目标是"调用前的 current.jpg",绝不是用户选择的历史/收藏源文件
    const rollbackErrs = await rollbackWallpaper(tx);
    return buildFailureResult(err, rollbackErrs);
  } finally {
    releaseChanging();
    if (tray) buildTrayMenu();
  }
});
ipcMain.handle('get-status', async () => {
  const cfg = await loadConfig();
  let nextRun = null;
  if (cfg.schedule.enabled && scheduler.isRunning()) {
    nextRun = new Date(Date.now() + cfg.schedule.intervalMinutes * 60000).toLocaleTimeString('zh-CN', { hour12: false });
  }
  let currentPathStr = null;
  try { if (fs.existsSync(currentPath())) currentPathStr = currentPath(); } catch {}
  const imgSvc = findService(cfg, cfg.activeImageService);
  const meta = await readWallpaperMeta();
  // 模型列表走缓存,后台异步刷新;本函数不等待网络
  let imageModels = [];
  let imageModelsError = '';
  if (imgSvc) {
    if (modelsCache.key === imgSvcKey(imgSvc)) {
      imageModels = modelsCache.models;
    } else {
      refreshImageModels(imgSvc);
      // 已缓存的失败原因(首次拉取失败后 modelsCache.key 仍为空,每次 get-status 都会走到这里)
      imageModelsError = modelsCacheError;
    }
  }
  return {
    lastInfo, nextRun, currentPath: currentPathStr,
    // 模型列表获取失败的原因(空串=无错误),渲染层据此给出明确提示,而不是只显示一个空下拉框
    imageModelsError,
    // 只读通道的读取失败原因(阶段2 第5步)。
    // 空对象=无错误。渲染层可据此区分"磁盘读不了"与"本来就没数据",
    // 而不必改变各通道的返回形状(那样要动 17 处调用与 42 处断言)。
    readErrors: Object.keys(readErrors).filter(k => readErrors[k]).reduce((acc, k) => { acc[k] = readErrors[k]; return acc; }, {}),
    sourceLabel: cfg.source === 'ai'
      ? ('当前来源: AI 生图 (' + (imgSvc?.name || '未配置') + ')')
      : '当前来源: Lolicon 随机二次元',
    imageModels,
    // 旧脚本回执与旧任务状态
    scriptMeta: meta,
    oldTaskRunning: !(cfg.migrate && cfg.migrate.oldTaskDisabled),
  };
});
// 读取开机自启状态:系统调用失败时返回 false(安全默认值 = 视为未开启),
// 不把异常抛给渲染层,避免设置页因一个读取失败而整体不可用。
ipcMain.handle('get-autorun', () => {
  try { return !!app.getLoginItemSettings().openAtLogin; } catch { return false; }
});
// 严格布尔:不接受 "false"/1/"true" 这类隐式转换,否则开机自启会被字符串误置
ipcMain.handle('set-autorun', (e, on) => {
  let v;
  try { v = assertBool(on, '开机自启开关'); } catch (err) { return argFail(err); }
  app.setLoginItemSettings({ openAtLogin: v });
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('open-wallpaper-dir', () => { ensureDir(); shell.openPath(wallDir()); });
ipcMain.handle('add-tag', async (e, tag) => {
  let t;
  try { t = assertTag(tag); } catch (err) { return argFail(err); }
  const cfg = await loadConfig();
  if (!cfg.lolicon.tags.includes(t)) await saveConfig({ lolicon: { tags: [...cfg.lolicon.tags, t] } });
  return true;
});
ipcMain.handle('remove-tag', async (e, tag) => {
  let t;
  try { t = assertTag(tag); } catch (err) { return argFail(err); }
  const cfg = await loadConfig();
  await saveConfig({ lolicon: { tags: cfg.lolicon.tags.filter(x => x !== t) } });
  return true;
});
ipcMain.handle('disable-old-task', () => disableOldTask());
// 探测本机常见代理端口
ipcMain.handle('detect-proxy', async () => {
  const { exec } = require('child_process');
  const ports = ['7897', '7890', '10809', '1080', '33210', '2080'];
  const found = [];
  for (const p of ports) {
    const alive = await new Promise((res) => {
      exec('powershell.exe -NoProfile -Command "(Test-NetConnection -ComputerName 127.0.0.1 -Port ' + p + ' -WarningAction SilentlyContinue).TcpTestSucceeded"',
        { timeout: 15000 }, (e, out) => res(String(out).includes('True')));
    });
    if (alive) found.push('http://127.0.0.1:' + p);
  }
  return { found };
});
ipcMain.handle('query-old-task', async () => {
  const { exec } = require('child_process');
  return await new Promise((res) => {
    exec('schtasks /query /tn "ACG-Wallpaper-Auto" /fo csv /nh', { encoding: 'utf8', timeout: 10000 }, (e, out) => {
      if (e) return res({ exists: false, enabled: false });
      const s = String(out);
      res({ exists: true, enabled: /Ready|运行中|正在运行|Ready/.test(s) && !/已禁用|Disabled/.test(s) });
    });
  });
});
ipcMain.handle('win-minimize', () => win.minimize());
ipcMain.handle('win-close', () => win.hide()); // 关闭=隐藏到托盘

// ---------- API 服务管理 ----------
ipcMain.handle('list-services', async () => (await loadConfig()).services || []);
ipcMain.handle('save-service', async (e, rawSvc) => {
  // 服务对象整体来自渲染层,必须逐字段校验后才能落盘(否则可写入任意字段与超大值)
  let svc;
  try {
    svc = assertService(rawSvc);
  } catch (err) {
    return argFail(err);
  }
  const cfg = await loadConfig();
  const list = cfg.services || [];
  const i = list.findIndex(s => s.id === svc.id);
  if (i >= 0) list[i] = svc; else list.push(svc);
  await saveConfig({ services: list });
  return { ok: true };
});
ipcMain.handle('delete-service', async (e, rawId) => {
  let id;
  try {
    id = assertId(rawId, '服务 id');
  } catch (err) {
    return argFail(err);
  }
  const cfg = await loadConfig();
  const list = (cfg.services || []).filter(s => s.id !== id);
  const patch = { services: list };
  if (cfg.activeImageService === id) patch.activeImageService = list.find(s => s.kind === 'image')?.id || '';
  if (cfg.activeTextService === id) patch.activeTextService = '';
  await saveConfig(patch);
  return { ok: true };
});
ipcMain.handle('set-active-service', async (e, rawKind, rawId) => {
  // id 允许空串:那是"取消当前服务"的既有语义,不能当非法入参拦掉
  let kind, id;
  try {
    kind = assertKind(rawKind);
    id = assertId(rawId, '服务 id', { allowEmpty: true });
  } catch (err) {
    return argFail(err);
  }
  if (kind === 'image') await saveConfig({ activeImageService: id });
  else await saveConfig({ activeTextService: id });
  return { ok: true };
});
// 测试服务连通性:画图测 /v1/models,文本测 /v1/chat/completions 极小请求
ipcMain.handle('test-service', async (e, rawSvc) => {
  // 该通道会带着 apiKey 向 svc.apiBase 发起真实出网请求,
  // 因此协议白名单是必须的:只放行 http/https,挡住 file:/javascript: 之类的地址
  let svc;
  try {
    svc = assertService(rawSvc);
  } catch (err) {
    return argFail(err);
  }
  try {
    const base = apiBase(svc.apiBase);
    if (svc.kind === 'text') {
      const res = await netFetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + svc.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: svc.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ': ' + (await res.text()).slice(0, 120) };
      return { ok: true, detail: '文本模型连通 ✓' };
    }
    const res = await netFetch(base + '/v1/models', {
      headers: { 'Authorization': 'Bearer ' + svc.apiKey },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const data = await res.json();
    const ids = (data.data || []).map(m => m.id);
    return { ok: true, detail: '连通 ✓,模型: ' + ids.slice(0, 5).join(', ') + (ids.length > 5 ? ' 等' + ids.length + '个' : '') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 拉取服务的可用模型列表(内部复用)
async function fetchServiceModels(svc) {
  const base = apiBase(svc.apiBase);
  let res;
  try {
    res = await netFetch(base + '/v1/models', {
      headers: { 'Authorization': 'Bearer ' + svc.apiKey },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { throw new Error(netErr(e)); }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return (data.data || []).map(m => m.id).filter(Boolean);
}

ipcMain.handle('fetch-models', async (e, rawSvc) => {
  // 同 test-service:会带密钥出网,必须先校验 apiBase 协议与结构
  let svc;
  try {
    svc = assertService(rawSvc);
  } catch (err) {
    return argFail(err);
  }
  try {
    return { ok: true, models: await fetchServiceModels(svc) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- 文本模型提示词助手 ----------
// 有文本服务:调 chat/completions 生成 Danbooru 标签串;无:本地风格词池随机增强
// 随机生成一条提示词(供 AI 页「摇一摇」预览)
ipcMain.handle('roll-random-prompt', async (e, mode) => {
  // mode 走枚举白名单,不允许任意字符串直通 buildRandomPrompt;缺省 any
  let m;
  try { m = assertRandomMode(mode); } catch (err) { return argFail(err); }
  return { prompt: buildRandomPrompt(m) };
});
ipcMain.handle('ai-assist-prompt', async (e, userTheme) => {
  // 主题会整段拼进系统提示词,必须先限长,避免超长内容直通远端模型
  let theme;
  try { theme = assertTheme(userTheme); } catch (err) { return argFail(err); }
  const cfg = await loadConfig();
  const tags = (cfg.lolicon.tags || []).join(', ');
  const textSvc = findService(cfg, cfg.activeTextService);
  if (!textSvc) {
    // 本地兜底:主题词 + 标签池元素 + 随机风格增强
    const { STYLE_POOL } = require('../shared/defaults');
    const pick = (arr, n) => arr.sort(() => Math.random() - 0.5).slice(0, n);
    const parts = [];
    if (theme) parts.push(theme);
    if (Math.random() < 0.6 && tags) parts.push(tags.split(', ')[Math.floor(Math.random() * tags.split(', ').length)]);
    parts.push(...pick(STYLE_POOL.scene, 1), ...pick(STYLE_POOL.lighting, 1), ...pick(STYLE_POOL.atmosphere, 1), ...pick(STYLE_POOL.quality, 2));
    return { ok: true, prompt: parts.join(', '), local: true };
  }
  try {
    // 阶段2起实现迁移到 plugins/builtin/openai-text-provider.js
    const provider = providerRegistry.get('openai-text');
    if (!provider) return { ok: false, error: '内置 Provider 不可用: openai-text' };
    const sys = '你是二次元壁纸提示词专家。把用户主题扩写成高质量英文 Danbooru 标签串(逗号分隔,含画质/构图/光线/场景词),不要解释,只输出标签串。可参考这些标签池元素: ' + tags;
    return await provider.complete({
      config: cfg,
      netFetch,
      findService,
      serviceId: cfg.activeTextService,
      maxTokens: 300,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: theme || '随机来一张好看的壁纸' },
      ],
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- 提示词预设槽 ----------
ipcMain.handle('save-preset', async (e, rawPreset) => {
  // 预设整体信任会被写进 promptPresets 数组,污染后续渲染层结构,必须逐字段校验
  let preset;
  try {
    preset = assertPreset(rawPreset);
  } catch (err) {
    return argFail(err);
  }
  const cfg = await loadConfig();
  const list = cfg.promptPresets || [];
  const i = list.findIndex(p => p.id === preset.id);
  if (i >= 0) list[i] = preset; else list.push(preset);
  await saveConfig({ promptPresets: list });
  return { ok: true };
});
ipcMain.handle('delete-preset', async (e, rawId) => {
  let id;
  try {
    id = assertId(rawId, '预设 id');
  } catch (err) {
    return argFail(err);
  }
  const cfg = await loadConfig();
  await saveConfig({ promptPresets: (cfg.promptPresets || []).filter(p => p.id !== id) });
  return { ok: true };
});

// ---------- 收藏 ----------
ipcMain.handle('favorite-current', async () => {
  try {
    if (!fs.existsSync(currentPath())) return { ok: false, error: '当前没有壁纸' };
    const favDir = path.join(wallDir(), 'favorites');
    await fsp.mkdir(favDir, { recursive: true });
    markSelfWrite();
    const dest = path.join(favDir, 'fav_' + ts() + '.jpg');
    await fsp.copyFile(currentPath(), dest);
    return { ok: true, file: dest };
  } catch (err) { return { ok: false, error: err.message }; }
});
// ---------- 插件管理(阶段2 第4步) ----------
// 返回:内置 Provider(始终启用) + 外部插件(含未启用/加载失败原因)。
// 注意只返回元数据,绝不把 Provider 实现对象或函数传给渲染层。
ipcMain.handle('list-plugins', async () => {
  const cfg = await loadConfig();
  const scan = scanExternalPlugins();
  const builtin = providerRegistry.list().map(p => ({ ...p, builtin: true, enabled: p.enabled !== false, status: 'ok' }));
  const external = scan.found.map(item => {
    const enabled = isPluginEnabled(cfg, item.id);
    return {
      id: item.id,
      name: (typeof item.manifest.name === 'string' && item.manifest.name.trim()) ? item.manifest.name : item.id,
      version: typeof item.manifest.version === 'string' ? item.manifest.version : '0.0.0',
      kind: typeof item.manifest.kind === 'string' ? item.manifest.kind : '(未声明)',
      capabilities: Array.isArray(item.manifest.capabilities) ? item.manifest.capabilities : [],
      builtin: false,
      enabled,
      status: enabled ? 'enabled' : 'disabled',
    };
  });
  return {
    builtin,
    external,
    // 扫描阶段被跳过的目录一并返回,让用户知道"我放了插件但没被识别"的原因
    skipped: scan.skipped.map(s => ({ dir: path.basename(s.dir), reason: s.reason })),
    pluginsDir: pluginsRoot(),
  };
});

// 启用/停用外部插件。启用时会真实 require 其代码并注册进 registry,
// 因此这一步是"用户显式授权执行第三方代码"的唯一入口。
ipcMain.handle('set-plugin-enabled', async (e, rawId, rawOn) => {
  let id, on;
  try {
    id = assertId(rawId, '插件 id');
    on = assertBool(rawOn);
  } catch (err) { return argFail(err); }

  const cfg = await loadConfig();
  const list = (cfg.plugins && Array.isArray(cfg.plugins.enabled)) ? cfg.plugins.enabled.slice() : [];
  const idx = list.indexOf(id);

  if (!on) {
    // 停用:移出启用列表并禁用注册表条目。不 require,不需要插件存在。
    if (idx >= 0) list.splice(idx, 1);
    providerRegistry.setEnabled(id, false);
    try { await saveConfig({ plugins: { enabled: list } }); }
    catch (err) { return failFrom(err, ERROR_CODES.E_IO, { configAborted: true }); }
    return { ok: true, id, enabled: false };
  }

  // 启用:必须能在磁盘上找到该插件
  const scan = scanExternalPlugins();
  const item = scan.found.find(x => x.id === id);
  if (!item) {
    const why = scan.skipped.find(s => path.basename(s.dir) === id);
    return fail('未找到插件: ' + id + (why ? '(' + why.reason + ')' : ''), ERROR_CODES.E_NOT_FOUND);
  }
  const loaded = pluginLoader.loadOne(item);
  if (!loaded.ok) return fail('插件加载失败: ' + loaded.reason, ERROR_CODES.E_STATE);

  try { providerRegistry.register(loaded.provider); }
  catch (err) { return failFrom(err, ERROR_CODES.E_INVALID_ARG); }
  providerRegistry.setEnabled(id, true);

  if (idx < 0) list.push(id);
  try { await saveConfig({ plugins: { enabled: list } }); }
  catch (err) {
    // 配置写失败时回退注册表状态,避免"内存里启用、重启后消失"的不一致
    providerRegistry.setEnabled(id, false);
    return failFrom(err, ERROR_CODES.E_IO, { configAborted: true });
  }
  return { ok: true, id, enabled: true };
});

ipcMain.handle('list-favorites', async () => {
  try {
    const favDir = path.join(wallDir(), 'favorites');
    await fsp.mkdir(favDir, { recursive: true });
    const files = (await fsp.readdir(favDir)).filter(f => f.endsWith('.jpg')).sort().reverse();
    clearReadError('list-favorites');
    return files.map(f => ({ name: f, path: path.join(favDir, f) }));
  } catch (err) {
    noteReadError('list-favorites', err);
    return [];
  }
});
ipcMain.handle('delete-favorite', async (e, name) => {
  // basename 只能挡路径穿越,不能替代参数校验:
  // favorites 目录里可能还有别的文件,不加白名单就可能被删掉。
  // 这里按 favorite-current 的真实命名规则 fav_yyyyMMdd_HHmmss.jpg 做白名单校验。
  let safe;
  try { safe = assertFavoriteName(name); } catch (err) { return argFail(err); }
  const favDir = path.join(wallDir(), 'favorites');
  const target = path.join(favDir, safe);
  // 双保险:确认最终路径确实落在 favorites 目录内(文件名已白名单化,此处防御未来改动)
  if (path.dirname(path.resolve(target)) !== path.resolve(favDir)) {
    return fail('收藏文件路径不合法', ERROR_CODES.E_INVALID_ARG);
  }
  try {
    if (!fs.existsSync(target)) {
      return fail('收藏文件不存在: ' + safe, ERROR_CODES.E_NOT_FOUND);
    }
    markSelfWrite();
    await fsp.unlink(target);
    return { ok: true };
  } catch (err) {
    return failFrom(err, ERROR_CODES.E_IO);
  }
});

// ---------- 元数据 ----------
// 按文件名查 history.jsonl 中对应的记录。history.jsonl 里并存两代格式:
//   新格式(archiveCurrent 写入):file=current.jpg,另带 histFile=<归档名>
//   旧格式(旧脚本写入)        :file 字段直接是 hist_*.jpg
// 因此必须两级精确匹配,且新格式优先;不做 bytes 兜底——同一张图被重复使用多次时
// bytes 完全相同,兜底会关联到错误的元数据,宁可返回 null 让调用方自己降级
ipcMain.handle('read-meta', async (e, rawFileName) => {
  // 仅用于与 history.jsonl 中的字段做字符串精确比较,不拼路径;但仍要求是合法文件名形状
  let fileName;
  try {
    fileName = assertId(rawFileName, '文件名');
  } catch (err) {
    return argFail(err);
  }
  try {
    // 整体剥一次 BOM:首行可能是 PowerShell 5.1 写出的带 BOM 行,不剥会被静默跳过
    const raw = stripBom(await fsp.readFile(path.join(wallDir(), 'history.jsonl'), 'utf8'));
    const lines = raw.trim().split('\n');
    // 先解析成记录数组,损坏行(并发写入的半行、手工编辑残留)直接跳过
    const parsed = [];
    for (const l of lines) {
      try { const r = JSON.parse(l); if (r) parsed.push(r); } catch {}
    }
    // 1. 新格式:归档时回写的 histFile 字段,与 hist_*.jpg 一一对应
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].histFile === fileName) return parsed[i];
    }
    // 2. 旧格式:旧脚本把历史图当时作为独立记录写下的 file 字段
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].file === fileName) return parsed[i];
    }
    return null;
  } catch { return null; }
});

// ---------- 窗口与生命周期 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 900, height: 640, minWidth: 800, minHeight: 560,
    frame: false, backgroundColor: '#14161c', show: false, icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

// 单实例锁:进程内的 changing 互斥锁挡不住第二个进程。
// 双开会让两个进程并发写 current.jpg / history.jsonl / wallpaper_meta.json,直接损坏用户数据。
// 拿不到锁时 quit 并跳过整个 whenReady 分支(只 quit 不 return 的话,whenReady 仍会建窗口)。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 第二次启动时不新开窗口,而是把已有窗口拉到前台
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    createWindow();
    tray = new Tray(trayIcon());
    buildTrayMenu();
    applySchedule(await loadConfig());
    await ensureDir();
    // 启动自愈:修复上次异常退出(断电/强杀)遗留的 current 缺失
    // 必须在 startWatcher 之前,避免自愈写入触发"旧脚本换图"误报
    const healed = await healInterruptedTransaction();
    if (healed && healed.recovered) {
      buildTrayMenu(); // 刷新托盘 tooltip
    }
    // 恢复上次已启用的外部插件。这是用户此前显式授权过的代码,重启后需要继续生效;
    // 但仍走一遍完整校验,插件被改动/损坏时按"跳过并记录"处理,不影响主程序启动。
    try { await restoreEnabledPlugins(); } catch {}
    startWatcher();
  });
}

app.on('window-all-closed', () => { /* 保持托盘运行,不退出 */ });
app.on('before-quit', () => { scheduler.stop(); });
