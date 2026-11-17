// 任务中心服务:生图/应用/放弃/换图等主进程动作的统一记录与步骤追踪(阶段4)。
//
// 设计边界:
//   1. 纯内存记录,不落盘 —— 任务历史属于观测数据,阶段5 SQLite 才考虑持久化。
//   2. 不 require('electron'),不 require main.js;本模块无外部依赖,init() 可选。
//   3. 只记录,不控制 —— 并发互斥仍由 wallpaper-service.acquireChanging 负责,
//      任务状态与真实执行状态可能短暂不一致,调用方以业务返回值为准。
//   4. 单实例模块:main.js 与测试可能多次加载,靠 __reset() 支持重复初始化。

// 当前任务(同一时刻至多一个进行中)与最近完成历史(环形,上限 10 条)
let current = null;
const recent = [];
const RECENT_MAX = 10;

let seq = 0;

function newId() {
  // taskId 无安全语义,仅用于主进程内部关联与 renderer 引用;
  // 不使用外部可预测输入,碰撞概率由 seq + 随机段共同压低。
  seq = (seq + 1) % 0xffff;
  return 't' + Date.now().toString(36) + '-' + seq.toString(36) + '-' +
    Math.random().toString(36).slice(2, 8);
}

function snapshotTask(t) {
  if (!t) return null;
  return {
    id: t.id, kind: t.kind, detail: t.detail || '',
    steps: t.steps.map(s => ({ step: s.step, status: s.status, detail: s.detail || '' })),
    startedAt: t.startedAt, endedAt: t.endedAt || 0,
    ok: (typeof t.ok === 'boolean') ? t.ok : null,
    interrupted: !!t.interrupted,
  };
}

// 开始一个任务。同刻已有进行中任务时,旧任务按 interrupted 收尾(防御:不应发生,
// 正常路径由调用方保证串行)。
function beginTask(kind, detail) {
  if (current) {
    current.ok = false;
    current.endedAt = Date.now();
    current.interrupted = true;
    pushRecent(current);
    current = null;
  }
  current = {
    id: newId(), kind: String(kind || 'unknown'), detail: String(detail || ''),
    steps: [], startedAt: Date.now(), endedAt: 0, ok: null,
  };
  return current.id;
}

// 记录一步。step 重复时视为状态更新(同一步骤名只保留最新状态)。
function stepTask(id, step, status, detail) {
  if (!current || current.id !== id) return false;
  const s = String(step || '');
  if (!s) return false;
  const statusStr = (status === 'pending' || status === 'running' || status === 'done' || status === 'failed') ? status : 'running';
  const existing = current.steps.find(x => x.step === s);
  if (existing) {
    existing.status = statusStr;
    existing.detail = String(detail || '');
  } else {
    current.steps.push({ step: s, status: statusStr, detail: String(detail || '') });
  }
  return true;
}

// 结束任务并转入历史环形队列。
function endTask(id, okFlag, detail) {
  if (!current || current.id !== id) return false;
  current.ok = !!okFlag;
  current.endedAt = Date.now();
  if (detail) current.detail = String(detail);
  pushRecent(current);
  current = null;
  return true;
}

function pushRecent(t) {
  recent.push(t);
  if (recent.length > RECENT_MAX) recent.shift();
}

// 只读快照:get-status 透出用。不含任何敏感信息(生图 prompt 由调用方决定是否放入 detail,
// 本模块不做脱敏 —— 约束:调用方传入前自行保证无凭据/Cookie)。
function snapshot() {
  return {
    current: snapshotTask(current),
    recent: recent.map(snapshotTask),
  };
}

// 测试与重复加载支持
function __reset() { current = null; recent.length = 0; seq = 0; }

module.exports = { beginTask, stepTask, endTask, snapshot, __reset };