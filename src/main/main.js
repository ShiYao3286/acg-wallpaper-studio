// ACG壁纸工作室 - 主进程
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { DEFAULT_CONFIG, buildRandomPrompt } = require('../shared/defaults');

let win = null;
let tray = null;
let scheduleTimer = null;
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

// ---------- 配置存取 ----------
const confDir = () => path.join(app.getPath('userData'), 'config');
const confFile = () => path.join(confDir(), 'config.json');

async function loadConfig() {
  try {
    const raw = await fsp.readFile(confFile(), 'utf8');
    return deepMerge(structuredClone(DEFAULT_CONFIG), JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}
function deepMerge(base, over) {
  for (const k of Object.keys(over)) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') {
      deepMerge(base[k], over[k]);
    } else base[k] = over[k];
  }
  return base;
}
async function saveConfig(patch) {
  await fsp.mkdir(confDir(), { recursive: true });
  const cfg = deepMerge(await loadConfig(), patch);
  await fsp.writeFile(confFile(), JSON.stringify(cfg, null, 2), 'utf8');
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
async function fetchLolicon(cfg) {
  const L = cfg.lolicon;
  const tags = Array.isArray(L.tags) ? L.tags.filter(Boolean) : [];
  const tag = tags.length ? tags[Math.floor(Math.random() * tags.length)] : null;
  const url = L.apiBase + '?num=1&r18=' + L.r18 + '&size=' + L.size + '&proxy=' + L.proxy +
    (L.excludeAI ? '&excludeAI=true' : '') + (tag ? '&tag=' + encodeURIComponent(tag) : '');
  const res = await netFetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('API HTTP ' + res.status);
  const json = await res.json();
  const d = json.data && json.data[0];
  if (!d || !d.urls || !d.urls.regular) throw new Error('API 未返回图片地址');
  return { url: d.urls.regular, title: d.title, author: d.author, pid: d.pid, tag };
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

async function fetchAI(cfg, serviceId, finalPrompt) {
  const svc = findService(cfg, serviceId || cfg.activeImageService);
  if (!svc) throw new Error('未找到画图 API 服务,请到「API 服务」页配置');
  const base = apiBase(svc.apiBase);
  const res = await netFetch(base + '/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + svc.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: svc.model, prompt: finalPrompt || cfg.ai.prompt, n: 1, size: cfg.ai.size }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error('AI API HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const json = await res.json();
  const item = json.data && json.data[0];
  if (!item) throw new Error('AI API 未返回数据');
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url) {
    const r2 = await netFetch(item.url, { signal: AbortSignal.timeout(60000) });
    if (!r2.ok) throw new Error('下载 AI 图片失败 HTTP ' + r2.status);
    return Buffer.from(await r2.arrayBuffer());
  }
  throw new Error('AI API 响应中无图片');
}

// ---------- 核心: 换壁纸流程 ----------
async function changeWallpaper(reason = 'schedule') {
  if (changing) return { ok: false, error: '正在换图中,请稍候' };
  changing = true;
  try {
    const cfg = await loadConfig();
    const game = await gameRunning(cfg);
    if (game && reason === 'schedule') {
      lastInfo = '检测到游戏 ' + game + ' 运行中,已跳过本次换图 (' + nowStr() + ')';
      return { ok: false, error: 'game-running', game };
    }
    await ensureDir();

    // 1. 获取图片到临时文件
    const tmp = path.join(wallDir(), 'current.tmp.jpg');
    let buf, meta = {};
    if (reason === 'ai' || cfg.source === 'ai') {
      // 随机模式: any/portrait/scenery 每次现拼提示词;custom 用用户保存的
      const mode = cfg.ai.randomMode || 'any';
      const finalPrompt = (mode === 'custom' || reason === 'ai-explicit')
        ? cfg.ai.prompt
        : buildRandomPrompt(mode === 'custom' ? 'any' : mode);
      buf = await fetchAI(cfg, cfg.activeImageService, finalPrompt);
      meta.prompt = finalPrompt;
      meta.randomMode = mode;
      meta.source = 'ai';
    } else {
      meta.source = 'lolicon';
      const info = await fetchLolicon(cfg);
      meta = info;
      const r = await netFetch(info.url, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('下载图片失败 HTTP ' + r.status);
      buf = Buffer.from(await r.arrayBuffer());
    }
    if (!buf || buf.length < 10240) throw new Error('下载的图片无效或过小');
    await fsp.writeFile(tmp, buf);

    // 2. 旧图归档
    try {
      if (fs.existsSync(currentPath())) {
        await fsp.rename(currentPath(), path.join(wallDir(), 'hist_' + ts() + '.jpg'));
      }
    } catch {}
    await fsp.rename(tmp, currentPath());

    // 3. 清理历史
    await pruneHistory(cfg);

    // 4. 设壁纸
    await setWallpaper(currentPath());

    // 追加元数据记录(JSONL,按文件名可回查)
    try {
      const record = { file: 'current.jpg', time: new Date().toISOString(), source: meta.source || 'lolicon',
        title: meta.title || '', author: meta.author || '', pid: meta.pid || '', tag: meta.tag || '',
        prompt: meta.prompt || '', bytes: buf.length };
      await fsp.appendFile(path.join(wallDir(), 'history.jsonl'), JSON.stringify(record) + '\n', 'utf8');
      // 同步写回执(与旧脚本同一文件、同一格式),UI 通过 watcher 感知
      const receipt = { time: nowStr(), source: 'app', tag: meta.tag || '',
        title: meta.title || '', author: meta.author || '', pid: meta.pid || '',
        file: 'current.jpg', bytes: buf.length, prompt: meta.prompt || '',
        randomMode: meta.randomMode || '' };
      await fsp.writeFile(path.join(wallDir(), 'wallpaper_meta.json'), JSON.stringify(receipt, null, 2), 'utf8');
    } catch {}

    lastInfo = (meta.title ? (meta.title + ' / ' + meta.author + ' / pid:' + meta.pid) : ('AI: ' + (meta.prompt || '').slice(0, 40) + '…')) +
      ' · ' + (buf.length / 1024).toFixed(0) + 'KB · ' + nowStr();
    lastRun = { time: nowStr(), ok: true };
    return { ok: true, ...meta };
  } catch (e) {
    lastRun = { time: nowStr(), ok: false, detail: e.message };
    return { ok: false, error: e.message };
  } finally {
    changing = false;
    if (tray) buildTrayMenu();
  }
}

async function pruneHistory(cfg) {
  try {
    const files = (await fsp.readdir(wallDir())).filter(f => f.startsWith('hist_') && f.endsWith('.jpg'))
      .sort().reverse();
    const keep = cfg.history.keepCount || 30;
    for (const f of files.slice(keep)) {
      await fsp.unlink(path.join(wallDir(), f)).catch(() => {});
    }
  } catch {}
}

// ---------- 调度 ----------
function applySchedule(cfg) {
  if (scheduleTimer) { clearInterval(scheduleTimer); scheduleTimer = null; }
  if (!cfg.schedule.enabled) return;
  const ms = Math.max(1, cfg.schedule.intervalMinutes) * 60000;
  scheduleTimer = setInterval(() => changeWallpaper('schedule').catch(() => {}), ms);
  scheduleTimer.unref && scheduleTimer.unref();
}

// ---------- 联动:监听壁纸目录(旧脚本动作实时感知) ----------
let wallWatcher = null;
let debounceTimer = null;

function startWatcher() {
  if (wallWatcher) return;
  try {
    wallWatcher = fs.watch(wallDir(), { persistent: false }, (event, filename) => {
      if (!filename || /^current\.(jpg|tmp\.jpg)$|^hist_.*\.jpg$|^wallpaper_meta\.json$/.test(filename)) {
        // 防抖:下载/归档会触发多次事件,500ms 合并成一次刷新
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => notifyUiRefresh('fs-event'), 500);
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
async function readWallpaperMeta() {
  try {
    return JSON.parse(await fsp.readFile(path.join(wallDir(), 'wallpaper_meta.json'), 'utf8'));
  } catch { return null; }
}

// ---------- 旧计划任务停用 ----------
function disableOldTask() {
  return new Promise((res) => {
    const { exec } = require('child_process');
    exec('schtasks /change /tn "ACG-Wallpaper-Auto" /disable', { encoding: 'utf8', timeout: 10000 }, (e) => {
      if (!e) saveConfig({ migrate: { oldTaskDisabled: true } });
      res({ ok: !e, error: e ? e.message : null });
    });
  });
}

// ---------- 托盘 ----------
function trayIcon() {
  // 优先使用应用图标,托盘缩到 16x16
  try {
    const p = path.join(__dirname, '../../assets/icon.png');
    const img = nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
    if (!img.isEmpty()) return img;
  } catch {}
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 0x7c; buf[i * 4 + 1] = 0x6c; buf[i * 4 + 2] = 0xff; buf[i * 4 + 3] = 0xff;
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}
function buildTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: '立即换一张 (Lolicon)', click: () => changeWallpaper('manual') },
    { label: 'AI 生成壁纸', click: () => changeWallpaper('ai') },
    { type: 'separator' },
    { label: '显示主界面', click: () => { win.show(); } },
    { label: '退出', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('ACG壁纸工作室 - ' + (lastRun ? ('上次: ' + lastRun.time + (lastRun.ok ? ' 成功' : ' 失败')) : '就绪'));
}

// ---------- 工具 ----------
const nowStr = () => new Date().toLocaleString('zh-CN', { hour12: false });
const ts = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); };

// ---------- IPC ----------
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (e, key, val) => {
  // key 支持 a.b.c 点路径
  const patch = {}; let cur = patch;
  const parts = key.split('.');
  parts.forEach((p, i) => { if (i === parts.length - 1) cur[p] = val; else cur = cur[p] = {}; });
  return saveConfig(patch);
});
ipcMain.handle('change-wallpaper', (e, reason) => changeWallpaper(reason || 'manual'));
ipcMain.handle('list-history', async () => {
  try {
    const files = (await fsp.readdir(wallDir())).filter(f => f.endsWith('.jpg')).sort().reverse();
    return files.map(f => ({ name: f, path: path.join(wallDir(), f) }));
  } catch { return []; }
});
ipcMain.handle('use-history', async (e, name) => {
  try {
    const safe = path.basename(name);
    const src = path.join(wallDir(), safe);
    if (!fs.existsSync(src)) return { ok: false, error: '文件不存在' };
    await setWallpaper(src);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('get-status', async () => {
  const cfg = await loadConfig();
  let nextRun = null;
  if (cfg.schedule.enabled && scheduleTimer) {
    nextRun = new Date(Date.now() + cfg.schedule.intervalMinutes * 60000).toLocaleTimeString('zh-CN', { hour12: false });
  }
  let currentPathStr = null;
  try { if (fs.existsSync(currentPath())) currentPathStr = currentPath(); } catch {}
  const imgSvc = findService(cfg, cfg.activeImageService);
  const meta = await readWallpaperMeta();
  return {
    lastInfo, nextRun, currentPath: currentPathStr,
    sourceLabel: cfg.source === 'ai'
      ? ('当前来源: AI 生图 (' + (imgSvc?.name || '未配置') + ')')
      : '当前来源: Lolicon 随机二次元',
    imageModels: imgSvc ? await fetchServiceModels(imgSvc).catch(() => []) : [],
    // 旧脚本回执与旧任务状态
    scriptMeta: meta,
    oldTaskRunning: !(cfg.migrate && cfg.migrate.oldTaskDisabled),
  };
});
ipcMain.handle('get-autorun', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('set-autorun', (e, on) => { app.setLoginItemSettings({ openAtLogin: !!on }); return app.getLoginItemSettings().openAtLogin; });
ipcMain.handle('open-wallpaper-dir', () => { ensureDir(); shell.openPath(wallDir()); });
ipcMain.handle('add-tag', async (e, tag) => {
  const cfg = await loadConfig();
  const t = String(tag).trim();
  if (t && !cfg.lolicon.tags.includes(t)) await saveConfig({ lolicon: { tags: [...cfg.lolicon.tags, t] } });
  return true;
});
ipcMain.handle('remove-tag', async (e, tag) => {
  const cfg = await loadConfig();
  await saveConfig({ lolicon: { tags: cfg.lolicon.tags.filter(t => t !== tag) } });
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
ipcMain.handle('save-service', async (e, svc) => {
  const cfg = await loadConfig();
  const list = cfg.services || [];
  const i = list.findIndex(s => s.id === svc.id);
  if (i >= 0) list[i] = svc; else list.push(svc);
  await saveConfig({ services: list });
  return { ok: true };
});
ipcMain.handle('delete-service', async (e, id) => {
  const cfg = await loadConfig();
  const list = (cfg.services || []).filter(s => s.id !== id);
  const patch = { services: list };
  if (cfg.activeImageService === id) patch.activeImageService = list.find(s => s.kind === 'image')?.id || '';
  if (cfg.activeTextService === id) patch.activeTextService = '';
  await saveConfig(patch);
  return { ok: true };
});
ipcMain.handle('set-active-service', async (e, kind, id) => {
  if (kind === 'image') await saveConfig({ activeImageService: id });
  else await saveConfig({ activeTextService: id });
  return { ok: true };
});
// 测试服务连通性:画图测 /v1/models,文本测 /v1/chat/completions 极小请求
ipcMain.handle('test-service', async (e, svc) => {
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

ipcMain.handle('fetch-models', async (e, svc) => {
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
  return { prompt: buildRandomPrompt(mode || 'any') };
});
ipcMain.handle('ai-assist-prompt', async (e, userTheme) => {
  const cfg = await loadConfig();
  const tags = (cfg.lolicon.tags || []).join(', ');
  const theme = String(userTheme || '').trim();
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
    const base = apiBase(textSvc.apiBase);
    const sys = '你是二次元壁纸提示词专家。把用户主题扩写成高质量英文 Danbooru 标签串(逗号分隔,含画质/构图/光线/场景词),不要解释,只输出标签串。可参考这些标签池元素: ' + tags;
    const res = await netFetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + textSvc.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: textSvc.model, messages: [
        { role: 'system', content: sys },
        { role: 'user', content: theme || '随机来一张好看的壁纸' }], max_tokens: 300 }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ': ' + (await res.text()).slice(0, 150) };
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    return text ? { ok: true, prompt: text, local: false } : { ok: false, error: '模型返回为空' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- 提示词预设槽 ----------
ipcMain.handle('save-preset', async (e, preset) => {
  const cfg = await loadConfig();
  const list = cfg.promptPresets || [];
  const i = list.findIndex(p => p.id === preset.id);
  if (i >= 0) list[i] = preset; else list.push(preset);
  await saveConfig({ promptPresets: list });
  return { ok: true };
});
ipcMain.handle('delete-preset', async (e, id) => {
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
    const dest = path.join(favDir, 'fav_' + ts() + '.jpg');
    await fsp.copyFile(currentPath(), dest);
    return { ok: true, file: dest };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('list-favorites', async () => {
  try {
    const favDir = path.join(wallDir(), 'favorites');
    await fsp.mkdir(favDir, { recursive: true });
    const files = (await fsp.readdir(favDir)).filter(f => f.endsWith('.jpg')).sort().reverse();
    return files.map(f => ({ name: f, path: path.join(favDir, f) }));
  } catch { return []; }
});
ipcMain.handle('delete-favorite', async (e, name) => {
  try {
    await fsp.unlink(path.join(wallDir(), 'favorites', path.basename(name)));
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- 元数据 ----------
ipcMain.handle('read-meta', async (e, fileName) => {
  try {
    const raw = await fsp.readFile(path.join(wallDir(), 'history.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    // 从后往前找该文件的记录(hist_ 文件名与归档时间对应)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        if (rec.file === fileName || fileName.startsWith('hist_')) {
          if (rec.file === fileName || (fileName.startsWith('hist_') && lines.slice(0, i + 1).filter(l => true).length)) {
            return rec;
          }
        }
      } catch {}
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

app.whenReady().then(async () => {
  createWindow();
  tray = new Tray(trayIcon());
  buildTrayMenu();
  applySchedule(await loadConfig());
  await ensureDir();
  startWatcher();
});

app.on('window-all-closed', () => { /* 保持托盘运行,不退出 */ });
app.on('before-quit', () => { if (scheduleTimer) clearInterval(scheduleTimer); });
