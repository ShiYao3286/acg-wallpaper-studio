// ---------- 定时换图调度(scheduler) ----------
// 职责边界:只负责按配置起停定时器,并把"该换图了"这件事回调出去。
// 依赖方向:system/scheduler -> 无(纯注入)。
// 不直接 require main.js 或 wallpaper 流程,避免循环引用;
// 真正的换图动作由 main.js 在 init 时作为回调注入。
let timer = null;
let onChange = null;

// opts.onChange: () => Promise|void,到点时调用(通常是 changeWallpaper('schedule'))
function init(opts) {
  onChange = (opts && opts.onChange) || null;
}

function applySchedule(cfg) {
  if (timer) { clearInterval(timer); timer = null; }
  if (!cfg || !cfg.schedule || !cfg.schedule.enabled) return;
  const ms = Math.max(1, cfg.schedule.intervalMinutes) * 60000;
  timer = setInterval(() => {
    // 单次换图失败不影响下一次调度;错误由 onChange 内部处理,这里只兜住 Promise 拒绝
    try {
      const r = onChange && onChange();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {}
  }, ms);
  // 不让定时器阻止进程退出(与拆分前行为一致)
  timer.unref && timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

// 仅供测试/状态展示:当前定时器是否在跑
const isRunning = () => !!timer;

module.exports = { init, applySchedule, stop, isRunning };
