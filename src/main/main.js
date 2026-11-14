// ACG壁纸工作室 - 主进程
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { DEFAULT_CONFIG, buildRandomPrompt } = require('../shared/defaults');
const { stripBom } = require('../shared/text');
const { ok } = require('../shared/contracts');
const { assertService, assertPreset, assertId, assertKind, assertReason, assertApiBase, argFail } = require('./validate');

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

// ---------- 配置存取 ----------
const confDir = () => path.join(app.getPath('userData'), 'config');
const confFile = () => path.join(confDir(), 'config.json');

async function loadConfig() {
  try {
    const raw = await fsp.readFile(confFile(), 'utf8');
    // 外部工具(如 PowerShell 5.1 的 Set-Content -Encoding UTF8)可能写出带 BOM 的 JSON;
    // 不剥 BOM 会让 JSON.parse 抛错并落入下面的 catch,直接返回默认配置,
    // 用户的全部设置与 API Key 会在内存中静默丢失。stripBom 对无 BOM 文本是恒等函数。
    return deepMerge(structuredClone(DEFAULT_CONFIG), JSON.parse(stripBom(raw)));
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
  // 原子写:先写同目录临时文件再 rename(同盘 rename 是原子的)。
  // 直接覆盖写若中途断电/强杀,config.json 会被截断,下次 loadConfig 只能回退默认配置,
  // 用户的全部设置与 API Key 会一次性丢失。
  const target = confFile();
  // 临时文件名必须唯一:固定的 .tmp 会让并发保存(如连续拖动开关)互相 rename,
  // 后完成的一方把先完成方的临时文件搬走,另一方 rename 时报 ENOENT。
  const tmpFile = target + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    await fsp.writeFile(tmpFile, JSON.stringify(cfg, null, 2), 'utf8');
    await fsp.rename(tmpFile, target);
  } catch (err) {
    // 失败时清掉临时文件,避免配置目录堆积残片
    try { await fsp.unlink(tmpFile); } catch {}
    throw err;
  }
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
    // 注意:壁纸已成功替换,这里的失败不能让整次换图判为失败(否则 UI 会说"换图失败"而桌面其实已经换了),
    // 但也绝不能静默吞掉——错误写进 historyWriteError 一并返回,让"换了图但历史没写"这件事可见。
    let historyWriteError = '';
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
    } catch (e) {
      historyWriteError = (e && e.message) || String(e);
    }

    lastInfo = (meta.title ? (meta.title + ' / ' + meta.author + ' / pid:' + meta.pid) : ('AI: ' + (meta.prompt || '').slice(0, 40) + '…')) +
      ' · ' + (buf.length / 1024).toFixed(0) + 'KB · ' + nowStr();
    lastRun = { time: nowStr(), ok: true };
    // 成功路径统一走 shared/contracts 的 ok() 构造器(展开对象,与原来的字面量完全等价)
    if (historyWriteError) {
      lastRun.detail = '历史记录写入失败: ' + historyWriteError;
      return ok({ ...meta, historyWriteError });
    }
    return ok({ ...meta });
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
  // 重名防护:同一秒内两次归档会拼出同名 hist 文件,而 Windows 的 rename 会静默覆盖,
  // 前一张历史图就此永久丢失(history.jsonl 里旧的 histFile 还会指向被覆盖的文件)。
  // 沿用历史数据里已有的 _1/_2 去重约定(history.jsonl:13 的 hist_20261111_002648_1.jpg)。
  const base = 'hist_' + ts();
  let histName = base + '.jpg';
  if (fs.existsSync(path.join(wallDir(), histName))) {
    for (let n = 1; n <= 99; n++) {
      histName = base + '_' + n + '.jpg';
      if (!fs.existsSync(path.join(wallDir(), histName))) break;
    }
  }
  await fsp.rename(currentPath(), path.join(wallDir(), histName));
  try {
    const f = path.join(wallDir(), 'history.jsonl');
    // history.jsonl 整体读取后逐行解析;BOM 只可能出现在文件首部(PowerShell 5.1 追加时会写出),
    // 行与行之间不会有,所以整体剥一次即可,不需要在循环内逐行处理。
    const raw = stripBom(await fsp.readFile(f, 'utf8'));
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
      // 同上:整体剥一次 BOM,避免首行解析失败导致自愈判据取不到
      const raw = stripBom(await fsp.readFile(path.join(histDir, 'history.jsonl'), 'utf8'));
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
//   touchedCurrent 本流程是否改写过 current.jpg
// 回滚策略:先恢复磁盘,只有磁盘确认回到操作前状态,才允许重新设置系统壁纸
//   1. 有归档 -> copyFile 从 hist 复制回 current(保留 hist,避免 history.jsonl 的 histFile 引用失效)
//              -> 恢复成功后才算 restored,允许重设系统壁纸
//   2. 原本无 current 且本流程写过 -> 删除新 current,恢复"无壁纸"
//              -> 磁盘已在操作前状态,但此时没有壁纸可设,不调用 setWallpaper
//   3. 原本有 current,本次改写过却无归档 -> 归档凭据缺失,current 来源未知
//              -> 既不能设置、也不能删除,只记录错误
//   4. 磁盘未变化(下载/归档前就失败)-> 什么都不做,更不重设壁纸
// 关键约束:归档丢失、恢复失败、归档凭据缺失等情况下磁盘处于未知状态,
//          绝不能把未经确认的 current.jpg 设置成桌面壁纸,只能记录错误。
// 回滚自身的错误全部收集返回,由调用方决定如何呈现,绝不静默丢弃原始错误。
async function rollbackWallpaper(tx) {
  const errs = [];
  const cur = currentPath();
  let restored = false;   // 磁盘是否已确认恢复到"操作前"状态
  let needReset = false;  // 恢复后是否需要(且允许)重新设置系统壁纸
  try {
    if (tx.archivedHist) {
      // 情况 A:本次归档过旧图,从归档恢复
      const histPath = path.join(wallDir(), tx.archivedHist);
      if (fs.existsSync(histPath)) {
        try {
          markSelfWrite();
          await fsp.copyFile(histPath, cur);
          restored = true;
          needReset = true;   // 旧壁纸已回到 current,需要重新应用
        } catch (e) {
          errs.push('从归档恢复 current 失败: ' + e.message);
        }
      } else {
        errs.push('归档文件不存在,无法恢复: ' + tx.archivedHist);
      }
    } else if (!tx.hadCurrent && tx.touchedCurrent) {
      // 情况 B:调用前没有壁纸,且本流程确实写过 current -> 清理,恢复"无壁纸"状态
      // 必须同时满足 touchedCurrent:若在写 current 之前就失败(如下载超时),
      // 磁盘上的 current 与本次操作无关,绝不能删除
      try {
        if (fs.existsSync(cur)) {
          markSelfWrite();
          await fsp.unlink(cur);
        }
        restored = true;
        needReset = false;  // 操作前就没有壁纸,没有可设置的目标
      } catch (e) {
        errs.push('清理 current 失败: ' + e.message);
      }
    } else if (tx.hadCurrent && !tx.archivedHist && tx.touchedCurrent) {
      // 情况 B2:并发边界。事务开始时 current 存在(hadCurrent=true),但归档前
      // 被外部程序删除,于是 archiveCurrent() 返回 null(无归档凭据),随后本次
      // 生成的新图被 rename 成 current。此时磁盘上的 current 是新图而非旧图,
      // 来源无法确认 -> 禁止设置系统壁纸,也绝不擅自删除用户目录下的文件。
      restored = false;
      needReset = false;
      errs.push('原壁纸归档凭据缺失，无法安全恢复');
    } else {
      // 情况 C:磁盘未发生变化(下载失败、归档前失败等)
      // current 仍是用户原本的壁纸,系统桌面也没被改过,无需任何动作
      // 注意:未执行过恢复动作,restored 必须为 false(它表示"已确认恢复")
      restored = false;
      needReset = false;
    }

    // 只有磁盘已确认恢复到操作前状态、且确实存在应恢复的壁纸时才重设
    // 其余情况(恢复失败/归档丢失)磁盘状态未知,绝不设置未经确认的文件
    if (restored && needReset && fs.existsSync(cur)) {
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
  // tray 可能尚未创建或已销毁:菜单点击回调、配置保存、自愈后刷新都会走到这里
  if (!tray || tray.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    { label: '立即换一张 (Lolicon)', click: () => changeWallpaper('manual') },
    { label: 'AI 生成壁纸', click: () => changeWallpaper('ai') },
    { type: 'separator' },
    { label: '显示主界面', click: () => { win.show(); } },
    { label: '退出', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  // 优先显示最近动作:lastRun 是换图结果,lastInfo 是更一般的状态文案(含启动自愈提示)。
  // 只读 lastRun 会让"已从归档恢复 current.jpg"这类自愈消息无处显示,托盘一直停在"就绪"。
  const tipText = lastRun ? ('上次: ' + lastRun.time + (lastRun.ok ? ' 成功' : ' 失败'))
    : (lastInfo ? lastInfo : '就绪');
  tray.setToolTip('ACG壁纸工作室 - ' + tipText);
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
  // 复合键旁路防护:save-service / save-preset 已各自校验元素,但 save-config 能直接
  // 写 services / promptPresets 整键或 services.N.apiBase 这类点路径,绕过那些校验。
  // 这里对流经 save-config 的复合值补一次元素级校验,保证两条写入路径强度一致。
  try {
    const top = parts[0];
    if (top === 'services') {
      if (Array.isArray(val)) {
        // 整键替换:每个元素都必须过 assertService
        val.forEach(x => assertService(x));
      } else if (parts.length === 3 && parts[2] === 'apiBase') {
        // 点路径改单个字段:只校验该字段,不要求整对象齐全(否则正常的单字段编辑会被误拦)
        assertApiBase(val);
      }
    } else if (top === 'promptPresets' && Array.isArray(val)) {
      val.forEach(x => assertPreset(x));
    }
  } catch (err) {
    return argFail(err);
  }
  const patch = {}; let cur = patch;
  parts.forEach((p, i) => { if (i === parts.length - 1) cur[p] = val; else cur = cur[p] = {}; });
  return saveConfig(patch);
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
ipcMain.handle('list-history', async () => {
  try {
    const files = (await fsp.readdir(wallDir())).filter(f => f.endsWith('.jpg')).sort().reverse();
    return files.map(f => ({ name: f, path: path.join(wallDir(), f) }));
  } catch { return []; }
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
  if (cfg.schedule.enabled && scheduleTimer) {
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
    startWatcher();
  });
}

app.on('window-all-closed', () => { /* 保持托盘运行,不退出 */ });
app.on('before-quit', () => { if (scheduleTimer) clearInterval(scheduleTimer); });
