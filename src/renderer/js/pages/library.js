// library.js:图库页(历史 / 收藏)。条目构建、筛选、大图预览、删除。
//
// 与旧实现的差别:
//   1. 历史条目现在带元数据(提示词/来源/标签),能搜索、能按来源筛 —— 旧版只有文件名
//   2. 点缩略图 = 看大图(旧版是直接换壁纸,误点就把桌面换了)
//   3. 历史图也能删(旧版只能删收藏,历史只能等它被 30 张上限挤掉)
//   4. 缩略图延迟解码 + 按修改时间排序(旧版按文件名字典序,老数据 hist_1.jpg 会乱)

const LIB_SRC_LABEL = { ai: 'AI', lolicon: 'Lolicon', favorite: '收藏', history: '历史' };

// 与主进程 delete-history 的白名单保持一致:只有归档文件可删。
// current.jpg 也在 list-history 里(首页胶片的 NOW 标记和 HUD 序号都依赖它),
// 但它不是归档,给它画删除按钮只会得到一个必然失败的死按钮。
const LIB_HIST_RE = /^hist_[A-Za-z0-9_-]+\.jpg$/i;
function libCanDelete(name) { return LIB_HIST_RE.test(String(name || '')); }

let __libAll = [];      // 全量历史条目(带元数据)
let __libQuery = '';    // 搜索词
let __libSource = '';   // 来源筛选
let __libPreviewName = '';

function libFileUrl(p) {
  return encodeURI('file:///' + String(p || '').replace(/\\/g, '/'));
}

function libSrcText(src) {
  return LIB_SRC_LABEL[src] || src || '—';
}

function makeGalleryItem(file, opts = {}) {
  const item = document.createElement('div');
  item.className = 'gitem';
  // 点缩略图看大图。旧实现直接调 useHistory,手滑就把壁纸换了。
  item.addEventListener('click', () => openPreview(file));

  const img = document.createElement('img');
  img.src = libFileUrl(file.path);
  img.alt = file.name || '';
  // 30 张 4K 图一次性全解码会明显卡顿,交给浏览器按需解
  img.loading = 'lazy';
  img.decoding = 'async';
  item.appendChild(img);

  if (opts.showName !== false) {
    const name = document.createElement('div');
    name.className = 'gname';
    // 有提示词就显示提示词(对人有意义),没有才回落文件名。
    // current.jpg 是"正在用的这张",不是历史,直接给它一个说得清的名字。
    const isCurrent = /^current\.(jpg|tmp\.jpg)$/i.test(String(file.name || ''));
    const hint = isCurrent ? '当前壁纸' : (file.prompt || file.title || '');
    name.textContent = hint ? hint.slice(0, 24) + (hint.length > 24 ? '…' : '') : (file.name || '');
    name.title = isCurrent ? '当前壁纸' : (hint || file.name || '');
    item.appendChild(name);
  }

  if (opts.deletable) {
    const del = document.createElement('button');
    del.className = 'gdel';
    del.title = opts.deletableHistory ? '删除这张历史壁纸' : '删除收藏';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (opts.deletableHistory) deleteHistoryFile(file.name); else delFav(file.name);
    });
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

// ---------- 历史 ----------
function renderHistory() {
  const box = $('gallery');
  if (!box) return;
  const q = __libQuery.trim().toLowerCase();
  const list = __libAll.filter(f => {
    if (__libSource && (f.source || '') !== __libSource) return false;
    if (!q) return true;
    return String(f.prompt || '').toLowerCase().includes(q)
      || String(f.name || '').toLowerCase().includes(q)
      || String(f.tag || '').toLowerCase().includes(q)
      || String(f.title || '').toLowerCase().includes(q);
  });

  const cnt = $('lib-count');
  if (cnt) cnt.textContent = list.length === __libAll.length
    ? __libAll.length + ' 张'
    : list.length + ' / ' + __libAll.length + ' 张';

  box.textContent = '';
  if (!list.length) {
    if (q || __libSource) setEmptyTip(box, '没有符合条件的壁纸,清空搜索或筛选再试');
    else setEmptyTip(box, '暂无历史壁纸,点「立即换一张」开始 ✨');
    return;
  }
  list.forEach(f => box.appendChild(makeGalleryItem(f, {
    deletable: libCanDelete(f.name), deletableHistory: true,
  })));
}

async function loadHistory() {
  let files = [];
  try { files = (await api.listHistory()) || []; } catch { files = []; }
  __libAll = files;
  if (!files.length) {
    const box = $('gallery');
    if (box) await emptyTipOrError(box, 'list-history', '暂无历史壁纸,点「立即换一张」开始 ✨');
    const cnt = $('lib-count'); if (cnt) cnt.textContent = '0 张';
    return;
  }
  renderHistory();
}

async function deleteHistoryFile(name) {
  if (!confirm('从磁盘删除这张历史壁纸?\n删除后无法恢复。')) return;
  const r = await api.deleteHistory(name);
  toast(r && r.ok ? '已删除' : '删除失败: ' + ((r && r.error) || '未知错误'), 3000);
  loadHistory();
}

// ---------- 收藏 ----------
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
    closePreview();
    // 换图会 bump current.jpg 的 mtime,列表是按 mtime 排的,不刷新顺序就是旧的
    loadHistory();
  } else {
    toast('失败: ' + r.error);
  }
}

// ---------- 大图预览 ----------
function openPreview(file) {
  const box = $('lib-preview');
  if (!box) return;
  __libPreviewName = file.name || '';
  const img = $('lib-preview-img');
  if (img) { img.src = libFileUrl(file.path); img.alt = __libPreviewName; }
  const bits = [];
  const src = libSrcText(file.source);
  if (src && src !== '—') bits.push('来源: ' + src);
  if (file.prompt) bits.push('提示词: ' + file.prompt);
  if (file.tag) bits.push('标签: ' + file.tag);
  if (file.title) bits.push('作品: ' + file.title + (file.author ? ' / ' + file.author : ''));
  bits.push('文件: ' + __libPreviewName);
  const meta = $('lib-preview-meta');
  if (meta) meta.textContent = bits.join('\n');
  box.style.display = 'flex';
}

function closePreview() {
  const box = $('lib-preview');
  if (box) box.style.display = 'none';
  __libPreviewName = '';
}

// ---------- 绑定(脚本在 body 末尾加载,元素此时已存在) ----------
(function bindLibraryTools() {
  const search = $('lib-search');
  if (search) {
    search.addEventListener('input', () => {
      __libQuery = search.value || '';
      renderHistory();
    });
  }
  const src = $('lib-source');
  if (src) {
    src.addEventListener('change', () => {
      __libSource = src.value || '';
      renderHistory();
    });
  }
  const use = $('lib-preview-use');
  if (use) use.addEventListener('click', () => { if (__libPreviewName) useHistory(__libPreviewName); });
  const close = $('lib-preview-close');
  if (close) close.addEventListener('click', closePreview);
  // 点遮罩空白处关闭;点内容区不关(冒泡目标判定)
  const overlay = $('lib-preview');
  if (overlay) overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closePreview(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      const box = $('lib-preview');
      if (box && box.style.display !== 'none') closePreview();
    }
  });
})();

// ---------- API 服务 ----------
