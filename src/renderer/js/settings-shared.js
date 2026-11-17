// settings-shared.js:配置保存原语与开关动作。自 renderer.js 逐行迁出。

async function saveStr(key, val) {
  const r = await api.saveConfig(key, String(val));
  if (r && r.ok === false) { toast('保存失败: ' + (r.error || '未知错误'), 4000); return; }
  toast('已保存');
}
async function saveNum(key, val) {
  const r = await api.saveConfig(key, parseInt(val) || 0);
  if (r && r.ok === false) { toast('保存失败: ' + (r.error || '未知错误'), 4000); return; }
  toast('已保存');
}
async function toggleSwitch(el, key) {
  el.classList.toggle('on');
  const on = el.classList.contains('on');
  const r = await api.saveConfig(key, on);
  if (r && r.ok === false) {
    // 落盘失败时把开关拨回原状,避免界面状态与磁盘状态不一致
    el.classList.toggle('on', !on);
    toast('保存失败: ' + (r.error || '未知错误'), 4000);
    return;
  }
  toast('已保存');
}
async function setSource(src) {
  $('seg-lolicon').classList.toggle('on', src !== 'ai');
  $('seg-ai').classList.toggle('on', src === 'ai');
  const r = await api.saveConfig('source', src);
  if (r && r.ok === false) { toast('切换失败: ' + (r.error || '未知错误'), 4000); return; }
  toast('壁纸来源已切换: ' + (src === 'ai' ? 'AI 生图' : 'Lolicon 二次元图'));
  refreshStatus();
}
function stepInterval(d) {
  const el = $('interval');
  el.value = Math.min(720, Math.max(5, (parseInt(el.value) || 30) + d));
  saveNum('schedule.intervalMinutes', el.value);
}
async function saveGameProcs(txt) {
  // 落盘失败必须让用户看见:原实现丢弃返回值,失败也提示"已保存"
  const r = await api.saveConfig('gameCheck.processes', txt.split('\n').map(s => s.trim()).filter(Boolean));
  if (r && r.ok === false) { toast('保存失败: ' + (r.error || '未知错误'), 4000); return; }
  toast('已保存');
}
async function disableOldTask() {
  const r = await api.disableOldTask();
  $('old-task-status').textContent = r.ok ? '已停用 ✓' : ('失败: ' + r.error);
  toast(r.ok ? '旧计划任务已停用' : '停用失败:' + r.error);
}
async function toggleAutoRun(el) {
  el.classList.toggle('on');
  const want = el.classList.contains('on');
  // setAutoRun 现在会拒绝非布尔入参,也可能因系统调用失败返回 ok:false;
  // 两种情况下都不能让界面停在"看起来开启/关闭成功"的假状态,必须拨回原状。
  const r = await api.setAutoRun(want);
  const applied = (r && typeof r === 'object' && r.ok === false) ? null : r;
  if (applied === null) {
    el.classList.toggle('on', !want);
    toast('设置失败: ' + (r.error || '未知错误'), 4000);
    return;
  }
  // setAutoRun 成功时返回系统实际状态(bool);以系统返回值为准纠正界面
  if (typeof applied === 'boolean' && applied !== want) {
    el.classList.toggle('on', applied);
  }
  toast(el.classList.contains('on') ? '已开启开机自启' : '已关闭开机自启');
}

// ---------- 标签池 ----------
