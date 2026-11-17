// 第二十三部分:task-service 任务中心单元测试(阶段4 批1)
//   纯新增模块,不涉及 main.js;直接加载真实模块测行为。
const { group, ok, summarize } = require('./common');
const taskService = require('../src/main/services/task-service');

// 断言经 common.ok 记录;小结行由 summarize() 生成,格式与 run-all.js 解析正则兼容
const T = (id, title, cond, ev) => ok(id, title, cond, ev);

(async () => {
  group('A begin/end 基本流');
  {
    taskService.__reset();
    const id = taskService.beginTask('generate', '测试任务');
    T('A1', 'beginTask 返回非空 id', typeof id === 'string' && id.length > 4, id);
    let snap = taskService.snapshot();
    T('A2', '进行中任务出现在 current', snap.current && snap.current.id === id, JSON.stringify(snap.current));
    T('A3', 'current.ok 为 null(未结束)', snap.current.ok === null, String(snap.current.ok));
    T('A4', 'stepTask 记录 running 步骤', taskService.stepTask(id, 'generate', 'running', '调用模型') &&
      taskService.snapshot().current.steps.some(x => x.step === 'generate' && x.status === 'running'), '');
    T('A5', 'stepTask 同名步骤状态更新不重复追加', taskService.stepTask(id, 'generate', 'done') &&
      taskService.snapshot().current.steps.filter(x => x.step === 'generate').length === 1, '');
    T('A6', 'endTask 确认后转入 recent 且 current 清空', taskService.endTask(id, true) &&
      taskService.snapshot().current === null && taskService.snapshot().recent.length === 1, '');
    const done = taskService.snapshot().recent[0];
    T('A7', 'recent 记录 ok=true 且有 endedAt', done.ok === true && done.endedAt > 0, JSON.stringify(done));
  }

  group('B 结束后操作与 id 校验');
  {
    taskService.__reset();
    const id = taskService.beginTask('apply', '');
    taskService.endTask(id, true);
    T('B1', '结束后 stepTask 返回 false', taskService.stepTask(id, 'x', 'done') === false, '');
    T('B2', '结束后 endTask 返回 false', taskService.endTask(id, false) === false, '');
    T('B3', '错误 id 的 stepTask 返回 false', taskService.stepTask('bogus', 'x', 'running') === false, '');
    T('B4', '错误 id 的 endTask 返回 false', taskService.endTask('bogus', true) === false, '');
    T('B5', '空 step 名被拒绝', (() => { const i = taskService.beginTask('k', ''); const r = taskService.stepTask(i, '', 'done'); taskService.endTask(i, true); return r === false; })(), '');
    T('B6', '非法 status 归一为 running', (() => { const i = taskService.beginTask('k', ''); taskService.stepTask(i, 's', 'bogus-status'); const st = taskService.snapshot().current.steps[0].status; taskService.endTask(i, true); return st === 'running'; })(), '');
  }

  group('C 并发防御与环形上限');
  {
    taskService.__reset();
    const id1 = taskService.beginTask('generate', '旧');
    const id2 = taskService.beginTask('apply', '新');
    const snap = taskService.snapshot();
    T('C1', '未收尾的旧任务被标记 interrupted 转入历史', snap.recent.length === 1 && snap.recent[0].id === id1 &&
      snap.recent[0].interrupted === true && snap.recent[0].ok === false, JSON.stringify(snap.recent[0]));
    T('C2', '新任务成为 current', snap.current && snap.current.id === id2, '');
    // 环形上限:再产生 12 个完成任务,recent 应保持 <= 10 且是最新的 10 个
    taskService.endTask(id2, true);
    for (let i = 0; i < 12; i++) {
      const iid = taskService.beginTask('k' + i, '');
      taskService.endTask(iid, true);
    }
    const r = taskService.snapshot().recent;
    T('C3', 'recent 上限 10 条', r.length === 10, String(r.length));
    T('C4', 'recent 保留最新任务(旧的被挤出)', r[r.length - 1].kind === 'k11' && r[0].kind === 'k2', r.map(x => x.kind).join(','));
  }

  group('D snapshot 无泄漏面');
  {
    taskService.__reset();
    const id = taskService.beginTask('generate', 'd1');
    taskService.stepTask(id, 's1', 'running', 'd2');
    const snap = taskService.snapshot();
    const js = JSON.stringify(snap);
    T('D1', 'snapshot 可 JSON 序列化(供 IPC)', (() => { JSON.parse(js); return true; })(), '');
    T('D2', 'current 含 kind/detail/steps/startedAt/endedAt/ok 字段', snap.current &&
      ['id','kind','detail','steps','startedAt','endedAt','ok'].every(k => k in snap.current), Object.keys(snap.current).join(','));
    T('D3', 'steps 元素只含 step/status/detail', snap.current.steps.every(x => Object.keys(x).length === 3 && ['step','status','detail'].every(k => k in x)), '');
    taskService.endTask(id, true);
    T('D4', '快照与内部对象无共享引用(改快照不影响后续)', (() => {
      const s1 = taskService.snapshot();
      if (s1.recent[0]) s1.recent[0].kind = 'tampered';
      const s2 = taskService.snapshot();
      return s2.recent[0] && s2.recent[0].kind !== 'tampered';
    })(), '');
  }

  const sum = summarize();
  console.log('---- 第二十三部分小结: ' + sum.passed + '/' + sum.total + ' 通过, ' + sum.failed + ' 失败' + (sum.skipped ? ', ' + sum.skipped + ' 跳过' : ''));
  process.exit(sum.failed ? 1 : 0);
})().catch(e => { console.error('[FATAL]', e && e.stack || e); process.exit(1); });