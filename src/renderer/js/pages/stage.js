// stage.js:舞台视图(缩略带 / 命令条 / 任务条 / 快捷键)。
//
// 边界:只读 get-status 与 get-config 的公开字段,不碰主进程逻辑。
// 舞台不是 .page,而是 #view-stage;切页由 core.js 负责,这里只负责"舞台里的内容"。

let __stageTick = null;

function stageErr(msg) {
  const el = $('stage-err');
  if (!el) return;
  el.textContent = String(msg || '');
  el.classList.add('on');
  clearTimeout(stageErr._t);
  stageErr._t = setTimeout(() => el.classList.remove('on'), 6000);
}

function fmtHM(sec) {
  const s = Math.max(0, Math.floor(sec));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

// ---------- 缩略带 ----------
// 20 秒轮询会反复走这里:文件名没变就不重建,否则缩略图会每 20 秒闪一次。
let __stripSig = '\u0000';
function renderStrip(files) {
  const box = $('recent-strip');
  if (!box) return;
  const list = (files || []).slice(0, 8);
  const sig = list.map(f => f.name).join('|');
  if (sig === __stripSig && box.childElementCount) return;
  __stripSig = sig;
  box.textContent = '';
  const label = document.createElement('div');
  label.className = 'stall';
  label.textContent = 'RECENT';
  box.appendChild(label);

  if (!list.length) {
    const t = document.createElement('div');
    t.className = 'stall';
    t.textContent = 'NO HISTORY';
    box.appendChild(t);
    return;
  }

  list.forEach((f, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'st' + (i === 0 ? ' cur' : '');
    b.title = f.name;
    const img = document.createElement('img');
    img.alt = '';
    img.src = encodeURI('file:///' + String(f.path).replace(/\\/g, '/'));
    b.appendChild(img);
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(i + 1).padStart(2, '0');
    b.appendChild(n);
    if (i === 0) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'NOW';
      b.appendChild(tag);
    }
    b.addEventListener('click', () => useHistory(f.name));
    box.appendChild(b);
  });
}

// ---------- 任务条 ----------
function renderJob(task) {
  const job = $('job');
  if (!job) return;
  const cur = task && task.current;
  if (!cur) {
    job.classList.remove('on');
    return;
  }
  job.classList.add('on');
  const el = $('job-time');
  if (el) el.textContent = fmtHM((Date.now() - (cur.startedAt || Date.now())) / 1000);
  const state = $('cmd-state');
  if (state) state.textContent = String(cur.kind || 'BUSY').toUpperCase();
  const dot = $('cmd-dot');
  if (dot) dot.classList.add('busy');
}

// ---------- 命令条 ----------
function renderCmd(st, cfg) {
  const src = $('cmd-src');
  if (src) src.textContent = (cfg && cfg.source === 'ai') ? 'AI' : 'LOLI';

  const enabled = !!(cfg && cfg.schedule && cfg.schedule.enabled);
  const loop = $('cmd-loop');
  if (loop) {
    loop.textContent = enabled ? 'ON' : 'OFF';
    loop.classList.toggle('g', enabled);
    loop.classList.toggle('m', !enabled);
  }
  const segLoop = $('seg-loop');
  if (segLoop) segLoop.classList.toggle('off', !enabled);

  const next = $('cmd-next');
  if (next) next.textContent = (enabled && st && st.nextRun) ? String(st.nextRun).slice(0, 5) : '--:--';

  const game = $('cmd-game');
  const gameOn = !!(cfg && cfg.gameCheck && cfg.gameCheck.enabled);
  if (game) game.textContent = gameOn ? 'GUARD' : 'OFF';

  const auto = $('top-auto');
  if (auto) {
    const min = (cfg && cfg.schedule && cfg.schedule.intervalMinutes) || 0;
    auto.textContent = 'AUTO ' + (enabled ? (min + 'M') : 'OFF');
    auto.classList.toggle('on', enabled);
  }

  if (!st || !st.task || !st.task.current) {
    const state = $('cmd-state');
    if (state) state.textContent = 'READY';
    const dot = $('cmd-dot');
    if (dot) dot.classList.remove('busy');
  }
}

// ---------- 主编排 ----------
async function refreshStage() {
  clearTimeout(__stageTick);
  let busy = false;
  try {
    let st = null;
    try {
      // 先把壁纸图/标题刷成主进程的当前状态(status.js 负责这部分)
      await refreshStatus();
      st = await api.getStatus();
    } catch (e) {
      stageErr('读取状态失败: ' + ((e && e.message) || e));
      return;
    }

    let cfg = null;
    try { cfg = await api.getConfig(); } catch {}

    let files = [];
    try { files = await api.listHistory(); } catch {}

    // 空态:主进程没有当前壁纸文件
    const empty = $('stage-empty');
    if (empty) empty.classList.toggle('on', !(st && st.currentPath));

    // HUD:第几张 / 总数
    const idx = $('hud-index');
    if (idx) {
      const base = st && st.currentPath ? String(st.currentPath).split(/[\\/]/).pop() : '';
      const pos = base ? files.findIndex(f => f.name === base) : -1;
      const curNo = pos >= 0 ? pos + 1 : (files.length ? 1 : 0);
      idx.textContent = 'STAGE ' + String(curNo).padStart(2, '0') + ' / ' + String(files.length).padStart(2, '0');
    }
    const hsrc = $('hud-src');
    if (hsrc) hsrc.textContent = (cfg && cfg.source === 'ai') ? 'AI-GEN' : 'LOLICON';
    const hudMeta = $('hud-size');
    if (hudMeta) {
      const meta = st && st.scriptMeta;
      hudMeta.textContent = (meta && meta.time) ? ('T ' + String(meta.time)) : '--';
    }

    renderStrip(files);
    renderCmd(st, cfg);
    renderJob(st && st.task);

    // 收藏数
    try {
      const favs = await api.listFavorites();
      const fav = $('top-fav');
      if (fav) fav.textContent = 'FAV ' + ((favs && favs.length) || 0);
    } catch {}

    busy = !!(st && st.task && st.task.current);
  } catch (e) {
    stageErr('刷新舞台失败: ' + ((e && e.message) || e));
  } finally {
    // 轮询的续期放在 finally 里:上面任何一步抛错都不会把轮询掐死,
    // 否则舞台会停在一次失败的状态上,直到用户手点别的页面才恢复。
    clearTimeout(__stageTick);
    __stageTick = setTimeout(refreshStage, busy ? 1000 : 20000);
  }
}

// ---------- 命令条点击 ----------
async function cmdToggleSource() {
  let cfg = null;
  try { cfg = await api.getConfig(); } catch {}
  const nextSrc = (cfg && cfg.source === 'ai') ? 'lolicon' : 'ai';
  await setSource(nextSrc);
  await refreshStage();
}
async function cmdToggleLoop() {
  let cfg = null;
  try { cfg = await api.getConfig(); } catch {}
  const on = !(cfg && cfg.schedule && cfg.schedule.enabled);
  const r = await api.saveConfig('schedule.enabled', on);
  if (r && r.ok === false) { toast('保存失败: ' + (r.error || '未知错误'), 4000); return; }
  toast(on ? '自动换图已开启' : '自动换图已关闭');
  await refreshStage();
}
async function cmdToggleGame() {
  let cfg = null;
  try { cfg = await api.getConfig(); } catch {}
  const on = !(cfg && cfg.gameCheck && cfg.gameCheck.enabled);
  const r = await api.saveConfig('gameCheck.enabled', on);
  if (r && r.ok === false) { toast('保存失败: ' + (r.error || '未知错误'), 4000); return; }
  toast(on ? '游戏时暂停已开启' : '游戏时暂停已关闭');
  await refreshStage();
}
function cmdGotoSettings() {
  const btn = document.querySelector('.ri[data-page="settings"]');
  if (btn) btn.click();
}

// ---------- 快捷键(仅舞台视图生效,输入控件里不拦) ----------
document.addEventListener('keydown', (ev) => {
  const view = $('view-stage');
  if (!view || view.classList.contains('off')) return;
  if (ev.target && ev.target.closest && ev.target.closest('input,textarea,select')) return;
  if (ev.key === ' ') {
    ev.preventDefault();
    if (typeof changeNow === 'function') changeNow();
  } else if (ev.key === 'g' || ev.key === 'G') {
    if (typeof aiNow === 'function') aiNow();
  } else if (ev.key === 'f' || ev.key === 'F') {
    if (typeof favCurrent === 'function') favCurrent();
  }
});

// ---------- 事件接线 ----------
// 命令条的点击统一走 core.js 的 CLICK_ACTIONS 委托(cmd-source/cmd-loop/cmd-game/cmd-next),
// 这里不重复绑定,避免一次点击 toggle 两边。
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(refreshStage, 0);

  // 主进程推来的文件变化(自身换图/旧脚本换图)都刷新一次舞台
  try {
    api.onUiRefresh(() => { refreshStage(); });
  } catch {}
});
