// library.js:图库条目构建与历史/收藏加载(图片库页)。自 renderer.js 逐行迁出。

function makeGalleryItem(file, opts = {}) {
  const item = document.createElement('div');
  item.className = 'gitem';
  item.addEventListener('click', () => useHistory(file.name));
  const img = document.createElement('img');
  img.src = encodeURI('file:///' + String(file.path).replace(/\\/g, '/'));
  item.appendChild(img);
  if (opts.showName !== false) {
    const name = document.createElement('div');
    name.className = 'gname';
    name.textContent = file.name;
    item.appendChild(name);
  }
  if (opts.deletable) {
    const del = document.createElement('button');
    del.className = 'gdel';
    del.title = '删除收藏';
    del.addEventListener('click', (ev) => { ev.stopPropagation(); delFav(file.name); });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-trash');
    svg.appendChild(use);
    del.appendChild(svg);
    item.appendChild(del);
  }
  const act = document.createElement('button');
  act.className = 'gact';
  act.textContent = '设为壁纸';
  act.addEventListener('click', (ev) => { ev.stopPropagation(); useHistory(file.name); });
  item.appendChild(act);
  return item;
}
function setEmptyTip(box, text) {
  box.textContent = '';
  const tip = document.createElement('div');
  tip.className = 'empty-tip';
  tip.textContent = text;
  box.appendChild(tip);
}
// 只读通道失败提示(阶段2 第5步):
// 列表为空时再查一次 readErrors,区分"本来就没数据"与"磁盘读不了"。
// 两者在旧实现里完全同形,用户只能看到空列表,无法判断出了什么问题。
async function emptyTipOrError(box, channel, emptyText) {
  let err = '';
  try {
    const st = await api.getStatus();
    err = (st && st.readErrors && st.readErrors[channel]) || '';
  } catch {}
  if (err) {
    setEmptyTip(box, '读取失败: ' + err + '(不是"没有数据",请检查壁纸目录是否可访问)');
  } else {
    setEmptyTip(box, emptyText);
  }
}

async function loadHistory() {
  const files = await api.listHistory();
  const box = $('gallery');
  box.textContent = '';
  if (!files || !files.length) { await emptyTipOrError(box, 'list-history', '暂无历史壁纸,点「立即换一张」开始 ✨'); return; }
  files.forEach(f => box.appendChild(makeGalleryItem(f)));
}
async function loadFavorites() {
  const files = await api.listFavorites();
  const box = $('fav-gallery');
  box.textContent = '';
  if (!files || !files.length) { await emptyTipOrError(box, 'list-favorites', '暂无收藏 ♥ 主页右上角心形按钮可收藏当前壁纸'); return; }
  files.forEach(f => box.appendChild(makeGalleryItem(f, { showName: false, deletable: true })));
}
async function delFav(name) {
  const r = await api.deleteFavorite(name);
  toast(r.ok ? '已删除' : '失败: ' + r.error);
  loadFavorites();
}
async function useHistory(name) {
  const r = await api.useHistory(name);
  // 换图成功但历史/回执落盘失败时必须让用户看见,否则"已设为壁纸"会掩盖数据未记录的事实
  if (r.ok) {
    toast('已设为壁纸' + (r.historyWriteError ? '(历史记录未写入: ' + r.historyWriteError + ')' : ''), 4000);
  } else {
    toast('失败: ' + r.error);
  }
}

// ---------- API 服务 ----------
