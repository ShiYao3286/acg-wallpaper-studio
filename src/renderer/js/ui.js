// ui.js:共享 UI 原语(toast/setSwitch/fillModelOptions)。自 renderer.js 逐行迁出。

function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._tm); t._tm = setTimeout(() => t.style.display = 'none', ms);
}
function setSwitch(id, on) { const s = $(id); if (s) s.classList.toggle('on', !!on); }
// 填充模型下拉/候选列表(DOM API,模型名来自远端 API,不可拼 HTML)
// withValue=true 用于 datalist 候选(value 属性),false 用于 select 选项
function fillModelOptions(targetId, models, withValue = true) {
  const box = $(targetId);
  if (!box) return;
  box.textContent = '';
  (models || []).forEach(m => {
    const opt = document.createElement('option');
    const name = String(m);
    if (withValue) opt.value = name;
    opt.textContent = withValue ? '' : name;
    box.appendChild(opt);
  });
}

// ---------- 配置 ----------
