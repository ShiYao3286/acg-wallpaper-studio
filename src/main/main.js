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

// ---------- 模型列表缓存(避免 get-status 同步等待网络) ----------
let modelsCache = { key: '', models: [] };
let modelsRefreshing = false;
const imgSvcKey = (svc) => svc.id + '|' + apiBase(svc.apiBase);
function refreshImageModels(svc) {
  if (!svc || modelsRefreshing) return;
  const key = imgSvcKey(svc);
  if (modelsCache.key === key) return;
  modelsRefreshing = true;
  fetchServiceModels(svc).then((models) => {
    modelsCache = { key, models };
    notifyUiRefresh('models');
  }).catch(() => {}).finally(() => { modelsRefreshing = false; });
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
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function deepMerge(base, over) {
  for (const k of Object.keys(over)) {
    if (FORBIDDEN_KEYS.has(k)) continue; // 防原型污染
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
  if (!acquireChanging()) return { ok: false, error: '正在换图中,请稍候' };
  // 事务上下文:必须在进入流程前快照,"调用前 current 是否存在"是回滚的判据
  // 注意:不能在归档分支里才赋值——若在归档前就失败(如下载超时),hadCurrent 会保持初始值,
  // 回滚将误判为"原本无壁纸"并删除用户的 current.jpg
  const tx = { hadCurrent: fs.existsSync(currentPath()), archivedHist: null, touchedCurrent: false };
  const tmp = path.join(wallDir(), 'current.tmp.jpg');
  try {
    const cfg = await loadConfig();
    const game = await gameRunning(cfg);
    if (game && reason === 'schedule') {
      lastInfo = '检测到游戏 ' + game + ' 运行中,已跳过本次换图 (' + nowStr() + ')';
      return { ok: false, error: 'game-running', game };
    }
    await ensureDir();

    // 1. 获取图片到临时文件
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
    markSelfWrite();
    await fsp.writeFile(tmp, buf);

    // 2. 旧图归档 —— 归档是回滚的唯一凭据,失败必须中断,不能静默继续
    //    (若归档失败仍继续 rename,旧图会被直接覆盖且无法恢复)
    markSelfWrite();
    if (fs.existsSync(currentPath())) {
      tx.archivedHist = await archiveCurrent();
    }

    // 3. 临时文件转为正式壁纸
    //    touchedCurrent 在改动磁盘前置位,保证失败路径能被回滚识别
    tx.touchedCurrent = true;
    markSelfWrite();
    await fsp.rename(tmp, currentPath());

    // 4. 设为系统壁纸 —— 失败需回滚文件,否则磁盘是新图而桌面是旧图
    await setWallpaper(currentPath());

    // 5. 确认切换成功后才清理历史,避免回滚所需的归档被提前删除
    await pruneHistory(cfg);

    // 追加元数据记录(JSONL,按文件名可回查)
    try {
      const record = { file: 'current.jpg', time: new Date().toISOString(), source: meta.source || 'lolicon',
        title: meta.title || '', author: meta.author || '', pid: meta.pid || '', tag: meta.tag || '',
        prompt: meta.prompt || '', bytes: buf.length };
      markSelfWrite();
      await fsp.appendFile(path.join(wallDir(), 'history.jsonl'), JSON.stringify(record) + '\n', 'utf8');
      // 同步写回执(与旧脚本同一文件、同一格式),UI 通过 watcher 感知
      const receipt = { time: nowStr(), source: 'app', tag: meta.tag || '',
        title: meta.title || '', author: meta.author || '', pid: meta.pid || '',
        file: 'current.jpg', bytes: buf.length, prompt: meta.prompt || '',
        randomMode: meta.randomMode || '' };
      markSelfWrite();
      await fsp.writeFile(path.join(wallDir(), 'wallpaper_meta.json'), JSON.stringify(receipt, null, 2), 'utf8');
    } catch {}

    lastInfo = (meta.title ? (meta.title + ' / ' + meta.author + ' / pid:' + meta.pid) : ('AI: ' + (meta.prompt || '').slice(0, 40) + '…')) +
      ' · ' + (buf.length / 1024).toFixed(0) + 'KB · ' + nowStr();
    lastRun = { time: nowStr(), ok: true };
    return { ok: true, ...meta };
  } catch (e) {
    // 任一步失败:先清理临时文件,再回滚到调用前状态,保留原始错误
    try { if (fs.existsSync(tmp)) await fsp.unlink(tmp); } catch {}
    const rollbackErrs = await rollbackWallpaper(tx);
    return buildFailureResult(e, rollbackErrs);
  } finally {
    releaseChanging();
  }
}

// 归档当前壁纸为 hist_<时间戳>.jpg,并把归档名回写到 history.jsonl 末条记录
// (旧格式只多一个可选字段 histFile,不影响旧脚本读取)
// 返回归档文件名;current 不存在时返回 null
// 注意:调用前是否已有 current 由调用方的事务上下文(tx.hadCurrent)记录,
//      本函数不承担该语义,避免两套 hadCurrent 混淆
// rename 失败会抛出,由调用方决定中断或回滚;history.jsonl 回写失败仅吞错,不影响归档本身
async function archiveCurrent() {
  if (!fs.existsSync(currentPath())) return null;
  const histName = 'hist_' + ts() + '.jpg';
  await fsp.rename(currentPath(), path.join(wallDir(), histName));
  try {
    const f = path.join(wallDir(), 'history.jsonl');
    const raw = await fsp.readFile(f, 'utf8');
    const rows = raw.trimEnd().split('\n');
    if (!rows.length) return histName;
    for (let i = rows.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(rows[i]);
        if (rec && rec.file === 'current.jpg') {
          rec.histFile = histName;
          rows[i] = JSON.stringify(rec);
          await fsp.writeFile(f, rows.join('\n') + '\n', 'utf8');
          break;
        }
      } catch {}
    }
  } catch {}
  return histName;
}

// ---------- 启动自愈:修复事务中断留下的状态 ----------
// 场景:换图事务在"已归档旧图、尚未写回 current"之间被强杀(断电/任务管理器结束进程)
//      结果是 current.jpg 消失,旧图只剩在 hist_<ts>.jpg 里,桌面壁纸还能显示但图库丢失当前项
// 判据(必须同时满足,避免误判):
//   1. current.jpg 不存在
//   2. history.jsonl 末条 current 记录带 histFile,且该文件确实存在
//      (histFile 是归档时回写的关联字段;只有走完 archiveCurrent 才会写入)
//   3. 该 histFile 不是更早的归档(必须是最末条记录,证明是"刚被归档还没来得及替换")
// 处理:把 histFile 复制回 current.jpg(保留 hist,与回滚策略一致,避免 histFile 引用悬空)
// 不做:不删除任何文件,不改动 history.jsonl,不设置系统壁纸(交给 UI 常规刷新)
async function healInterruptedTransaction() {
  try {
    const cur = currentPath();
    if (fs.existsSync(cur)) return null;      // 正常:current 存在,无需处理

    const histDir = wallDir();
    if (!fs.existsSync(histDir)) return null;

    // 读 history.jsonl 末条 current 记录
    let last = null;
    try {
      const raw = await fsp.readFile(path.join(histDir, 'history.jsonl'), 'utf8');
      const rows = raw.trimEnd().split('\n');
      for (let i = rows.length - 1; i >= 0; i--) {
        try {
          const rec = JSON.parse(rows[i]);
          if (rec && rec.file === 'current.jpg') { last = rec; break; }
        } catch {}
      }
    } catch { return null; }

    // 末条记录没有 histFile,说明上次换图是正常完成的(或从未归档),不是中断
    if (!last || !last.histFile) return null;

    const histPath = path.join(histDir, last.histFile);
    if (!fs.existsSync(histPath)) {
      // 有关联字段但文件没了:可能是被 pruneHistory 清理,属于正常历史淘汰,不恢复
      return null;
    }

    // 确认是本次中断留下的归档,复制回 current
    markSelfWrite();
    await fsp.copyFile(histPath, cur);
    const msg = '检测到上次换图中断,已从 ' + last.histFile + ' 恢复 current.jpg';
    lastInfo = msg + ' (' + nowStr() + ')';
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('ui-refresh', 'external'); } catch {}
    }
    return { recovered: true, from: last.histFile, message: msg };
  } catch (e) {
    return { recovered: false, error: e.message };
  }
}

// ---------- 换壁纸事务:失败回滚 ----------
// 事务上下文:
//   hadCurrent    调用前 current.jpg 是否存在
//   archivedHist  归档产生的 hist 文件名(回滚来源);为空表示本次未归档
// 回滚策略(按优先级):
//   1. 有归档 -> 用 copyFile 从 hist 复制回 current(保留 hist 文件,避免 history.jsonl 的 histFile 引用失效)
//      - 不能用 rename:会让刚回写的 histFile 变成悬空引用
//   2. 原本无 current 且归档也没产生 -> 删除本次生成的新 current,恢复"无壁纸"状态
//   3. 回滚后尝试重新设置系统壁纸;重设失败只记录,不覆盖原始错误
// 回滚自身的错误全部收集返回,由调用方决定如何呈现,绝不静默丢弃原始错误。
async function rollbackWallpaper(tx) {
  const errs = [];
  const cur = currentPath();
  try {
    if (tx.archivedHist) {
      // 情况 A:本次归档过旧图,从归档恢复
      const histPath = path.join(wallDir(), tx.archivedHist);
      if (fs.existsSync(histPath)) {
        markSelfWrite();
        await fsp.copyFile(histPath, cur);
      } else {
        errs.push('归档文件不存在,无法恢复: ' + tx.archivedHist);
      }
    } else if (!tx.hadCurrent && tx.touchedCurrent) {
      // 情况 B:调用前没有壁纸,且本流程确实写过 current -> 清理,恢复"无壁纸"状态
      // 必须同时满足 touchedCurrent:若流程在写 current 之前就失败(如下载超时),
      // 磁盘上的 current 与本次操作无关,绝不能删除
      if (fs.existsSync(cur)) {
        markSelfWrite();
        await fsp.unlink(cur).catch((e) => { errs.push('清理 current 失败: ' + e.message); });
      }
    }
    // 情况 C:未归档也未写过 current(如下载失败)-> 磁盘无变化,无需回滚
    // 恢复系统桌面壁纸(仅当磁盘上确实有 current 时才有意义)
    if (fs.existsSync(cur)) {
      try {
        await setWallpaper(cur);
      } catch (e) {
        errs.push('恢复系统壁纸失败: ' + e.message);
      }
    }
  } catch (e) {
    errs.push('回滚过程异常: ' + e.message);
  }
  return errs;
}

// 组装带回滚信息的错误结果:原始错误优先,回滚错误附加说明
function buildFailureResult(originalErr, rollbackErrs) {
  const base = originalErr && originalErr.message ? originalErr.message : String(originalErr);
  lastRun = { time: nowStr(), ok: false, detail: base + (rollbackErrs.length ? ' | 回滚异常' : '') };
  if (!rollbackErrs.length) return { ok: false, error: base };
  return {
    ok: false,
    error: base + ' (回滚也出现问题: ' + rollbackErrs.join('; ') + ')',
    originalError: base,
    rollbackErrors: rollbackErrs,
  };
}

async function pruneHistory(cfg) {
  try {
    const files = (await fsp.readdir(wallDir())).filter(f => f.startsWith('hist_') && f.endsWith('.jpg'))
      .sort().reverse();
    const keep = cfg.history.keepCount || 30;
    if (files.length > keep) markSelfWrite();
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
const CONFIG_TOP_KEYS = new Set(Object.keys(DEFAULT_CONFIG));
ipcMain.handle('save-config', (e, key, val) => {
  // key 支持 a.b.c 点路径;顶层键必须在默认配置白名单内,并拦截原型污染键
  if (typeof key !== 'string' || !key) return { ok: false, error: '无效的配置键' };
  const parts = key.split('.');
  if (parts.some(x => FORBIDDEN_KEYS.has(x))) return { ok: false, error: '非法配置键' };
  if (!CONFIG_TOP_KEYS.has(parts[0])) return { ok: false, error: '不允许的配置键: ' + parts[0] };
  const patch = {}; let cur = patch;
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
  if (!acquireChanging()) return { ok: false, error: '正在换图中,请稍候' };
  // 事务上下文:进入流程前先快照,"调用前 current 是否存在"是回滚判据
  const tx = { hadCurrent: fs.existsSync(currentPath()), archivedHist: null, touchedCurrent: false };
  try {
    const safe = path.basename(name);
    const historyPath = path.join(wallDir(), safe);
    const favoritePath = path.join(wallDir(), 'favorites', safe);
    const isFavorite = !fs.existsSync(historyPath) && fs.existsSync(favoritePath);
    const src = isFavorite ? favoritePath : historyPath;
    if (!fs.existsSync(src)) return { ok: false, error: '文件不存在' };

    await ensureDir();
    markSelfWrite();

    // 1. 来源若已是当前壁纸,直接应用,不重复归档
    if (path.resolve(src) === path.resolve(currentPath())) {
      await setWallpaper(currentPath());
      return { ok: true, current: true };
    }

    // 2. 先读出来源图片内容(历史图保持原样,不删除)
    const buf = await fsp.readFile(src);

    // 3. 归档当前壁纸;若内容与来源相同则跳过,避免重复归档同一张图
    //    归档是回滚的唯一凭据,失败必须中断
    if (fs.existsSync(currentPath())) {
      const curBuf = await fsp.readFile(currentPath());
      if (curBuf.length === buf.length && curBuf.equals(buf)) {
        // 内容相同:不归档,current 保持原样
      } else {
        tx.archivedHist = await archiveCurrent();
      }
    }

    // 4. 写入 current.jpg
    //    touchedCurrent 必须在写入"之前"置位:writeFile 可能中途失败留下半成品,
    //    若写在成功之后,失败路径会漏掉清理
    tx.touchedCurrent = true;
    markSelfWrite();
    await fsp.writeFile(currentPath(), buf);

    // 5. 设壁纸 —— 失败需回滚文件
    await setWallpaper(currentPath());

    // 6. 同步历史记录与回执(与 changeWallpaper 同一格式)
    try {
      // 查找来源元数据:
      //   历史图 -> 按 histFile 精确匹配;老数据没有 histFile 时退化为按字节数匹配
      //   收藏图 -> 收藏时未存元数据,退化为按字节数匹配最近一条记录
      let meta = null;
      try {
        const raw = await fsp.readFile(path.join(wallDir(), 'history.jsonl'), 'utf8');
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
    } catch {}

    lastInfo = ('已应用' + (isFavorite ? '收藏' : '历史') + '壁纸') + ' · ' + (buf.length / 1024).toFixed(0) + 'KB · ' + nowStr();
    lastRun = { time: nowStr(), ok: true };
    return { ok: true };
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
  if (cfg.schedule.enabled && scheduleTimer) {
    nextRun = new Date(Date.now() + cfg.schedule.intervalMinutes * 60000).toLocaleTimeString('zh-CN', { hour12: false });
  }
  let currentPathStr = null;
  try { if (fs.existsSync(currentPath())) currentPathStr = currentPath(); } catch {}
  const imgSvc = findService(cfg, cfg.activeImageService);
  const meta = await readWallpaperMeta();
  // 模型列表走缓存,后台异步刷新;本函数不等待网络
  let imageModels = [];
  if (imgSvc) {
    if (modelsCache.key === imgSvcKey(imgSvc)) imageModels = modelsCache.models;
    else refreshImageModels(imgSvc);
  }
  return {
    lastInfo, nextRun, currentPath: currentPathStr,
    sourceLabel: cfg.source === 'ai'
      ? ('当前来源: AI 生图 (' + (imgSvc?.name || '未配置') + ')')
      : '当前来源: Lolicon 随机二次元',
    imageModels,
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
    markSelfWrite();
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
  // 启动自愈:修复上次异常退出(断电/强杀)遗留的 current 缺失
  // 必须在 startWatcher 之前,避免自愈写入触发"旧脚本换图"误报
  const healed = await healInterruptedTransaction();
  if (healed && healed.recovered) {
    buildTrayMenu(); // 刷新托盘 tooltip
  }
  startWatcher();
});

app.on('window-all-closed', () => { /* 保持托盘运行,不退出 */ });
app.on('before-quit', () => { if (scheduleTimer) clearInterval(scheduleTimer); });
