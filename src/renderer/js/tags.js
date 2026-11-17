// tags.js:标签池(现属工作台页)。自 renderer.js 逐行迁出。

function renderTags(tags) {
  const box = $('tag-list');
  box.textContent = '';
  if (!tags || !tags.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '标签池为空,换图时将不指定题材';
    box.appendChild(p);
    return;
  }
  tags.forEach((t, i) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip c' + (i % 6);
    chip.appendChild(document.createTextNode(t));
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '✕';
    x.addEventListener('click', () => delTag(t));
    chip.appendChild(x);
    box.appendChild(chip);
  });
}
async function addTag() {
  const v = $('tag-input').value.trim();
  if (!v) return;
  // 保存失败时保留输入框内容,方便用户重试;只有成功才清空并刷新列表
  try {
    const r = await api.addTag(v);
    if (r && r.ok === false) { toast('添加标签失败: ' + (r.error || '未知错误'), 4000); return; }
  } catch (e) {
    toast('添加标签失败: ' + ((e && e.message) || '通信异常'), 4000);
    return;
  }
  $('tag-input').value = '';
  try { renderTags((await api.getConfig()).lolicon.tags); } catch {}
}
async function delTag(t) {
  try {
    const r = await api.removeTag(t);
    if (r && r.ok === false) { toast('删除标签失败: ' + (r.error || '未知错误'), 4000); return; }
  } catch (e) {
    toast('删除标签失败: ' + ((e && e.message) || '通信异常'), 4000);
    return;
  }
  try { renderTags((await api.getConfig()).lolicon.tags); } catch {}
}

// ---------- 动作 ----------
