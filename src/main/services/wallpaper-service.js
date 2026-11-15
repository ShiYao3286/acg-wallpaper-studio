// 壁纸服务:换图事务 / 归档 / 启动自愈 / 回滚 / 历史清理
//
// 从 main.js 迁出(阶段2 第6步)。这是阶段1 列为"延期"的 wallpaper-service 拆分。
//
// 拆分原则:
//   1. 逻辑逐字迁出,不借机重构 —— 事务与回滚是本项目最容易出错的部分,
//      行为有任何漂移都可能造成用户壁纸丢失。原 552 项测试就是行为不变的证据。
//   2. 本模块不 require('electron'),也不 require main.js。
//      所有外部依赖(目录、配置、出网、设置壁纸、自写标记、状态上报)通过 init() 注入。
//   3. 依赖方向保持单向:main.js -> services/wallpaper-service -> shared。

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { stripBom } = require('../../shared/text');
const { ok, failFrom, ERROR_CODES } = require('../../shared/contracts');

// 注入的依赖(全部由 main.js 在 init 时提供)
let deps = {
  wallDir: () => '',
  currentPath: () => '',
  ensureDir: async () => {},
  loadConfig: async () => ({}),
  gameRunning: async () => null,
  fetchLolicon: async () => ({}),
  fetchAI: async () => Buffer.alloc(0),
  netFetch: async () => { throw new Error('netFetch 未注入'); },
  setWallpaper: async () => {},
  markSelfWrite: () => {},
  buildRandomPrompt: () => '',
  classifyError: () => ERROR_CODES.E_STATE,
  ts: () => '',
  nowStr: () => '',
  notifyUi: () => {},
  setLastInfo: () => {},
  setLastRun: () => {},
  acquireChanging: () => false,
  releaseChanging: () => {},
  isWinAlive: () => false,
  sendRefresh: () => {},
};

function init(opts) {
  deps = Object.assign({}, deps, opts || {});
}

const wallDir = () => deps.wallDir();
const currentPath = () => deps.currentPath();

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
  // 沿用历史数据里已有的 _1/_2 去重约定。
  const base = 'hist_' + deps.ts();
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

async function pruneHistory(cfg) {
  try {
    const files = (await fsp.readdir(wallDir())).filter(f => f.startsWith('hist_') && f.endsWith('.jpg'))
      .sort().reverse();
    const keep = cfg.history.keepCount || 30;
    if (files.length > keep) deps.markSelfWrite();
    for (const f of files.slice(keep)) {
      await fsp.unlink(path.join(wallDir(), f)).catch(() => {});
    }
  } catch {}
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
      const histPath = path.join(wallDir(), tx.archivedHist);
      if (fs.existsSync(histPath)) {
        try {
          deps.markSelfWrite();
          await fsp.copyFile(histPath, cur);
          restored = true;
          needReset = true;
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
          deps.markSelfWrite();
          await fsp.unlink(cur);
        }
        restored = true;
        needReset = false;
      } catch (e) {
        errs.push('清理 current 失败: ' + e.message);
      }
    } else if (tx.hadCurrent && !tx.archivedHist && tx.touchedCurrent) {
      // 情况 B2:并发边界。事务开始时 current 存在,但归档前被外部程序删除,
      // 于是 archiveCurrent() 返回 null(无归档凭据),随后新图被 rename 成 current。
      // 此时磁盘上的 current 是新图而非旧图,来源无法确认 -> 禁止设置系统壁纸,
      // 也绝不擅自删除用户目录下的文件。
      restored = false;
      needReset = false;
      errs.push('原壁纸归档凭据缺失，无法安全恢复');
    } else {
      // 情况 C:磁盘未发生变化(下载失败、归档前失败等)
      restored = false;
      needReset = false;
    }

    if (restored && needReset && fs.existsSync(cur)) {
      try {
        await deps.setWallpaper(cur);
      } catch (e) {
        errs.push('恢复系统壁纸失败: ' + e.message);
      }
    }
  } catch (e) {
    errs.push('回滚过程异常: ' + e.message);
  }
  return errs;
}

// 组装带回滚信息的错误结果:原始错误优先,回滚错误附加说明。
function buildFailureResult(originalErr, rollbackErrs) {
  const base = originalErr && originalErr.message ? originalErr.message : String(originalErr);
  deps.setLastRun({ time: deps.nowStr(), ok: false, detail: base + (rollbackErrs.length ? ' | 回滚异常' : '') });
  if (!rollbackErrs.length) {
    return failFrom(originalErr, deps.classifyError(originalErr));
  }
  return failFrom(originalErr, ERROR_CODES.E_ROLLBACK, {
    error: base + ' (回滚也出现问题: ' + rollbackErrs.join('; ') + ')',
    originalError: base,
    rollbackErrors: rollbackErrs,
  });
}

// ---------- 启动自愈 ----------
// 处理:把 histFile 复制回 current.jpg(保留 hist,与回滚策略一致,避免 histFile 引用悬空)
// 不做:不删除任何文件,不改动 history.jsonl,不设置系统壁纸(交给 UI 常规刷新)
async function healInterruptedTransaction() {
  try {
    const cur = currentPath();
    if (fs.existsSync(cur)) return null;

    const histDir = wallDir();
    if (!fs.existsSync(histDir)) return null;

    let last = null;
    try {
      const raw = stripBom(await fsp.readFile(path.join(histDir, 'history.jsonl'), 'utf8'));
      const rows = raw.trimEnd().split('\n');
      for (let i = rows.length - 1; i >= 0; i--) {
        try {
          const rec = JSON.parse(rows[i]);
          if (rec && rec.file === 'current.jpg') { last = rec; break; }
        } catch {}
      }
    } catch { return null; }

    if (!last || !last.histFile) return null;

    const histPath = path.join(histDir, last.histFile);
    if (!fs.existsSync(histPath)) return null;

    deps.markSelfWrite();
    await fsp.copyFile(histPath, cur);
    const msg = '检测到上次换图中断,已从 ' + last.histFile + ' 恢复 current.jpg';
    deps.setLastInfo(msg + ' (' + deps.nowStr() + ')');
    if (deps.isWinAlive()) {
      try { deps.sendRefresh('external'); } catch {}
    }
    return { recovered: true, from: last.histFile, message: msg };
  } catch (e) {
    return { recovered: false, error: e.message };
  }
}

// ---------- 核心:换壁纸流程 ----------
// 事务顺序:取图到 tmp -> 归档旧图 -> tmp 转正式 -> 设系统壁纸 -> 清理历史 -> 写回执
// 任一步失败都回滚到调用前状态;回滚错误与原始错误一起返回。
async function changeWallpaper(reason) {
  const why = reason || 'schedule';
  if (!deps.acquireChanging()) return { ok: false, error: '正在换图中,请稍候' };
  // 事务上下文:必须在进入流程前快照,"调用前 current 是否存在"是回滚的判据
  // 注意:不能在归档分支里才赋值——若在归档前就失败(如下载超时),hadCurrent 会保持初始值,
  // 回滚将误判为"原本无壁纸"并删除用户的 current.jpg
  const tx = { hadCurrent: fs.existsSync(currentPath()), archivedHist: null, touchedCurrent: false };
  const tmp = path.join(wallDir(), 'current.tmp.jpg');
  try {
    const cfg = await deps.loadConfig();
    const game = await deps.gameRunning(cfg);
    if (game && why === 'schedule') {
      deps.setLastInfo('检测到游戏 ' + game + ' 运行中,已跳过本次换图 (' + deps.nowStr() + ')');
      return { ok: false, error: 'game-running', game };
    }
    await deps.ensureDir();

    // 1. 获取图片到临时文件
    let buf, meta = {};
    if (why === 'ai' || cfg.source === 'ai') {
      const mode = cfg.ai.randomMode || 'any';
      const finalPrompt = (mode === 'custom' || why === 'ai-explicit')
        ? cfg.ai.prompt
        : deps.buildRandomPrompt(mode === 'custom' ? 'any' : mode);
      buf = await deps.fetchAI(cfg, cfg.activeImageService, finalPrompt);
      meta.prompt = finalPrompt;
      meta.randomMode = mode;
      meta.source = 'ai';
    } else {
      meta.source = 'lolicon';
      const info = await deps.fetchLolicon(cfg);
      meta = info;
      const r = await deps.netFetch(info.url, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('下载图片失败 HTTP ' + r.status);
      buf = Buffer.from(await r.arrayBuffer());
    }
    if (!buf || buf.length < 10240) throw new Error('下载的图片无效或过小');
    deps.markSelfWrite();
    await fsp.writeFile(tmp, buf);

    // 2. 旧图归档 —— 归档是回滚的唯一凭据,失败必须中断,不能静默继续
    deps.markSelfWrite();
    if (fs.existsSync(currentPath())) {
      tx.archivedHist = await archiveCurrent();
    }

    // 3. 临时文件转为正式壁纸
    tx.touchedCurrent = true;
    deps.markSelfWrite();
    await fsp.rename(tmp, currentPath());

    // 4. 设为系统壁纸 —— 失败需回滚文件,否则磁盘是新图而桌面是旧图
    await deps.setWallpaper(currentPath());

    // 5. 确认切换成功后才清理历史,避免回滚所需的归档被提前删除
    await pruneHistory(cfg);

    // 追加元数据记录(JSONL,按文件名可回查)
    // 注意:壁纸已成功替换,这里的失败不能让整次换图判为失败(否则 UI 会说"换图失败"而桌面其实已经换了),
    // 但也绝不能静默吞掉——错误写进 historyWriteError 一并返回。
    let historyWriteError = '';
    try {
      const record = { file: 'current.jpg', time: new Date().toISOString(), source: meta.source || 'lolicon',
        title: meta.title || '', author: meta.author || '', pid: meta.pid || '', tag: meta.tag || '',
        prompt: meta.prompt || '', bytes: buf.length };
      deps.markSelfWrite();
      await fsp.appendFile(path.join(wallDir(), 'history.jsonl'), JSON.stringify(record) + '\n', 'utf8');
      const receipt = { time: deps.nowStr(), source: 'app', tag: meta.tag || '',
        title: meta.title || '', author: meta.author || '', pid: meta.pid || '',
        file: 'current.jpg', bytes: buf.length, prompt: meta.prompt || '',
        randomMode: meta.randomMode || '' };
      deps.markSelfWrite();
      await fsp.writeFile(path.join(wallDir(), 'wallpaper_meta.json'), JSON.stringify(receipt, null, 2), 'utf8');
    } catch (e) {
      historyWriteError = (e && e.message) || String(e);
    }

    deps.setLastInfo((meta.title ? (meta.title + ' / ' + meta.author + ' / pid:' + meta.pid) : ('AI: ' + (meta.prompt || '').slice(0, 40) + '…')) +
      ' · ' + (buf.length / 1024).toFixed(0) + 'KB · ' + deps.nowStr());
    // 与原实现保持一致:先把同一个对象交给 lastRun,再改它的 detail。
    // 这样"历史记录写入失败"的说明能挂到 lastRun 上(托盘 tooltip 会读它),
    // 而不是被一次新的对象替换掉。
    const runInfo = { time: deps.nowStr(), ok: true };
    deps.setLastRun(runInfo);
    if (historyWriteError) {
      runInfo.detail = '历史记录写入失败: ' + historyWriteError;
      return ok({ ...meta, historyWriteError });
    }
    return ok({ ...meta });
  } catch (e) {
    try { if (fs.existsSync(tmp)) await fsp.unlink(tmp); } catch {}
    const rollbackErrs = await rollbackWallpaper(tx);
    return buildFailureResult(e, rollbackErrs);
  } finally {
    deps.releaseChanging();
  }
}

module.exports = {
  init,
  changeWallpaper,
  archiveCurrent,
  healInterruptedTransaction,
  rollbackWallpaper,
  buildFailureResult,
  pruneHistory,
};