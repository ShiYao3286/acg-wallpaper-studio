// services.js:API 服务管理卡(插件中心页)。自 renderer.js 逐行迁出。

let editingSvc = null;
async function loadServices() {
  const services = await api.listServices();
  const cfg = await api.getConfig();
  const box = $('svc-list');
  box.textContent = '';
  if (!services || !services.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '还没有服务,点下方添加。默认生图服务已预置。';
    box.appendChild(p);
  } else {
    services.forEach(s => {
      const isActiveImg = s.id === cfg.activeImageService && s.kind === 'image';
      const isActiveTxt = s.id === cfg.activeTextService && s.kind === 'text';
      const card = document.createElement('div');
      card.className = 'svc-card';
      const head = document.createElement('div');
      head.className = 'svc-head';
      const kindEl = document.createElement('span');
      kindEl.className = 'svc-kind ' + s.kind;
      kindEl.textContent = s.kind === 'image' ? '画图' : '文本';
      head.appendChild(kindEl);
      const nameEl = document.createElement('span');
      nameEl.className = 'svc-name';
      nameEl.textContent = s.name || '未命名';
      head.appendChild(nameEl);
      if (isActiveImg || isActiveTxt) {
        const badge = document.createElement('span');
        badge.className = 'active-badge';
        badge.textContent = '使用中';
        head.appendChild(badge);
      }
      const modelEl = document.createElement('span');
      modelEl.className = 'svc-model';
      modelEl.textContent = s.model || '';
      head.appendChild(modelEl);
      const actions = document.createElement('div');
      actions.className = 'svc-actions';
      const mkBtn = (label, onClick) => {
        const b = document.createElement('button');
        b.className = 'btn small ghost';
        b.textContent = label;
        b.addEventListener('click', onClick);
        actions.appendChild(b);
      };
      mkBtn(s.kind === 'image' ? '设为画图' : '设为文本', () => setActive(s.kind, s.id));
      mkBtn('编辑', () => editService(s.id));
      mkBtn('删除', () => deleteService(s.id));
      head.appendChild(actions);
      card.appendChild(head);
      const res = document.createElement('div');
      res.className = 'svc-test-result';
      res.id = 'svc-res-' + s.id;
      res.textContent = s.apiBase || '';
      card.appendChild(res);
      box.appendChild(card);
    });
  }
  refreshAssistEngine();
}
function newService() {
  editingSvc = { id: 'svc-' + Date.now(), kind: 'image', name: '', apiBase: '', apiKey: '', model: '' };
  $('svc-editor-title').textContent = '添加服务';
  $('svc-name').value = ''; $('svc-kind').value = 'image'; $('svc-base').value = '';
  $('svc-key').value = ''; $('svc-model').value = ''; $('svc-model-list').innerHTML = '';
  $('svc-editor-result').textContent = '';
  $('svc-editor').style.display = 'block';
}
async function editService(id) {
  const services = await api.listServices();
  const s = services.find(x => x.id === id);
  if (!s) return;
  editingSvc = { ...s };
  $('svc-editor-title').textContent = '编辑服务: ' + (s.name || '');
  $('svc-name').value = s.name || ''; $('svc-kind').value = s.kind;
  $('svc-base').value = s.apiBase || ''; $('svc-key').value = s.apiKey || '';
  $('svc-model').value = s.model || ''; $('svc-model-list').innerHTML = '';
  $('svc-editor-result').textContent = '';
  $('svc-editor').style.display = 'block';
}
function closeEditor() { $('svc-editor').style.display = 'none'; editingSvc = null; }
async function saveService() {
  if (!editingSvc) return;
  editingSvc.name = $('svc-name').value.trim();
  editingSvc.kind = $('svc-kind').value;
  editingSvc.apiBase = $('svc-base').value.trim();
  editingSvc.apiKey = $('svc-key').value.trim();
  editingSvc.model = $('svc-model').value.trim();
  if (!editingSvc.apiBase) { toast('API 地址不能为空'); return; }
  // 失败时保留编辑器打开状态与全部输入,只有真正保存成功才关闭并刷新
  try {
    const r = await api.saveService(editingSvc);
    if (!r || r.ok === false) { toast('保存失败: ' + ((r && r.error) || '未知错误'), 4000); return; }
  } catch (e) {
    toast('保存失败: ' + ((e && e.message) || '通信异常'), 4000);
    return;
  }
  closeEditor();
  loadServices();
  toast('服务已保存');
}
async function deleteService(id) {
  if (!confirm('确定删除该服务?')) return;
  try {
    const r = await api.deleteService(id);
    if (!r || r.ok === false) { toast('删除失败: ' + ((r && r.error) || '未知错误'), 4000); return; }
  } catch (e) {
    toast('删除失败: ' + ((e && e.message) || '通信异常'), 4000);
    return;
  }
  loadServices();
  toast('已删除');
}
async function setActive(kind, id) {
  try {
    const r = await api.setActiveService(kind, id);
    if (!r || r.ok === false) { toast('切换失败: ' + ((r && r.error) || '未知错误'), 4000); return; }
  } catch (e) {
    toast('切换失败: ' + ((e && e.message) || '通信异常'), 4000);
    return;
  }
  loadServices();
  toast(kind === 'image' ? '已设为画图服务' : '已设为提示词助手引擎');
}
async function fetchModels() {
  if (!editingSvc) return;
  // 先暂存当前编辑内容再拉取
  editingSvc.apiBase = $('svc-base').value.trim();
  editingSvc.apiKey = $('svc-key').value.trim();
  if (!editingSvc.apiBase) { toast('请先填 API 地址'); return; }
  const btn = $('btn-fetch-models'); btn.disabled = true; $('svc-editor-result').textContent = '拉取模型列表中…';
  try {
    const r = await api.fetchModels(editingSvc);
    if (r.ok) {
      fillModelOptions('svc-model-list', r.models);
      $('svc-editor-result').textContent = '拉取到 ' + r.models.length + ' 个模型: ' + r.models.slice(0, 6).join(', ') + (r.models.length > 6 ? ' …' : '');
    } else {
      $('svc-editor-result').textContent = '拉取失败: ' + r.error;
    }
  } finally { btn.disabled = false; }
}
async function testEditing() {
  if (!editingSvc) return;
  editingSvc.name = $('svc-name').value.trim();
  editingSvc.kind = $('svc-kind').value;
  editingSvc.apiBase = $('svc-base').value.trim();
  editingSvc.apiKey = $('svc-key').value.trim();
  editingSvc.model = $('svc-model').value.trim();
  if (!editingSvc.apiBase) { toast('请先填 API 地址'); return; }
  $('svc-editor-result').textContent = '测试连通中…';
  const r = await api.testService(editingSvc);
  $('svc-editor-result').textContent = r.ok ? ('✓ ' + r.detail) : ('✗ ' + r.error);
}


// AI 页「模型」下拉:把"用哪个引擎生图"和"具体模型"合成一个选择。
//
// 值域约定:
//   'doubao'            -> 走豆包账号 Seedream(cfg.ai.imageEngine = 'doubao')
//   'svc:<modelName>'   -> 走 OpenAI 兼容服务,model 写入 cfg.ai.model
// 这样用户在一个下拉里就能选"用豆包还是用某个 API 服务",不用去两个页面来回切。
async function refreshImageEngineOptions(st) {
  const sel = $('ai-model');
  if (!sel) return;
  try {
    const cfg = await api.getConfig();
    const engine = (cfg.ai && cfg.ai.imageEngine) || 'service';
    const curModel = (cfg.ai && cfg.ai.model) || '';
    // 模型列表来自远端拉取,可能为空(服务不可达 / 尚未拉取)。
    // 【不能用空列表就只剩豆包一个选项】—— 那样用户会以为服务没了。
    // 兜底:把当前激活服务配置的模型名也放进去,保证至少能看到自己在用的模型。
    const fetched = (st && Array.isArray(st.imageModels)) ? st.imageModels : [];
    const services = await api.listServices();
    const activeSvc = services.find(s => s.id === cfg.activeImageService && s.kind === 'image');
    const models = fetched.slice();
    if (curModel && !models.includes(curModel)) models.unshift(curModel);
    if (activeSvc && activeSvc.model && !models.includes(activeSvc.model)) models.push(activeSvc.model);
    const prev = sel.value;
    sel.textContent = '';

    // 豆包选项:仅在已登录时可用
    let doubaoReady = false;
    try {
      const ds = await api.doubao.status();
      doubaoReady = ds && ds.state === 'authenticated';
    } catch { doubaoReady = false; }

    const optD = document.createElement('option');
    optD.value = 'doubao';
    optD.textContent = '豆包 Seedream' + (doubaoReady ? '' : '(未登录)');
    if (!doubaoReady) { optD.disabled = true; optD.style.color = '#6b7280'; }
    sel.appendChild(optD);

    // 服务模型选项
    for (const m of models) {
      const o = document.createElement('option');
      o.value = 'svc:' + m;
      o.textContent = m;
      sel.appendChild(o);
    }

    // 回填当前值。优先级:配置里的模型 > 上次选中的值 > 列表第一项。
    // 不能无条件用 models[0],否则会把用户已选好的模型悄悄改掉。
    if (engine === 'doubao' && doubaoReady) {
      sel.value = 'doubao';
    } else if (curModel && models.includes(curModel)) {
      sel.value = 'svc:' + curModel;
    } else if (prev && [...sel.options].some(o => o.value === prev && !o.disabled)) {
      sel.value = prev;
    } else if (models.length) {
      sel.value = 'svc:' + models[0];
    } else if (doubaoReady) {
      sel.value = 'doubao';
    }
  } catch (e) {
    // 读取失败时保持原样,不把下拉清空
  }
}

// 下拉变更:切换引擎或模型
async function onAiModelChange() {
  const sel = $('ai-model');
  if (!sel) return;
  const v = String(sel.value || '');
  if (v === 'doubao') {
    await api.saveConfig('ai.imageEngine', 'doubao');
    toast('已切换到豆包 Seedream 生图', 3000);
    return;
  }
  if (v.startsWith('svc:')) {
    const model = v.slice(4);
    await api.saveConfig('ai.imageEngine', 'service');
    await api.saveConfig('ai.model', model);
    toast('已切换到服务模型: ' + model, 3000);
  }
}

// ---------- 状态栏 ----------


// ---------- 插件中心:插件列表(阶段4 UI 重构批2,渲染逻辑;启停见下方按钮委托) ----------
// 使用既有 IPC:api.listPlugins()(阶段2 已暴露,返回 { builtin, external, skipped })。
// 安全模型(方案 12.8.5):启用 = 信任并执行外部插件全部代码,UI 必须把这点讲清楚。
async function loadPluginList() {
  const box = $('plugin-list');
  if (!box) return;
  box.textContent = '';
  let data;
  try { data = await api.listPlugins(); } catch (e) {
    setEmptyTip(box, '插件列表加载失败: ' + (e && e.message || e));
    return;
  }
  const all = [].concat(
    (data.builtin || []).map(p => ({ ...p, __group: 'builtin' })),
    (data.external || []).map(p => ({ ...p, __group: 'external' })),
  );
  if (!all.length) { setEmptyTip(box, '没有已注册的插件'); return; }
  for (const p of all) {
    const row = document.createElement('div');
    row.className = 'svc-card';
    const head = document.createElement('div');
    head.className = 'svc-head';
    const name = document.createElement('b');
    name.className = 'svc-name';
    name.textContent = p.name || p.id;
    const kind = document.createElement('span');
    kind.className = 'svc-kind';
    kind.textContent = p.builtin ? '内置' : '外部';
    kind.style.background = p.builtin ? 'linear-gradient(135deg,#64748b,#475569)' : 'linear-gradient(135deg,#f59e0b,#d97706)';
    const badge = document.createElement('span');
    badge.className = 'active-badge';
    badge.style.opacity = p.enabled ? '1' : '0.45';
    badge.textContent = p.enabled ? '已启用' : '已停用';
    const actions = document.createElement('div');
    actions.className = 'svc-actions';
    const btn = document.createElement('button');
    btn.className = 'btn small ' + (p.enabled ? 'ghost' : '');
    btn.textContent = p.enabled ? '停用' : '启用';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        if (!p.builtin && !p.enabled) {
          if (!confirm('启用外部插件「' + (p.name || p.id) + '」?\n\n启用等于信任并执行该插件的全部代码(主进程内运行,无沙箱)。')) return;
        }
        const r = await api.setPluginEnabled(p.id, !p.enabled);
        if (r && r.ok === false) { toast('操作失败: ' + (r.error || '未知错误'), 4000); return; }
        toast((!p.enabled ? '已启用 ' : '已停用 ') + (p.name || p.id));
        loadPluginList();
      } finally { btn.disabled = false; }
    });
    actions.appendChild(btn);
    head.appendChild(name); head.appendChild(kind); head.appendChild(badge); head.appendChild(actions);
    const meta = document.createElement('div');
    meta.className = 'svc-model';
    meta.textContent = 'v' + (p.version || '?') + ' · ' + (p.kind || '(未声明)') + ' · ' + (p.capabilities || []).join(', ');
    row.appendChild(head); row.appendChild(meta);
    box.appendChild(row);
  }
  if ((data.skipped || []).length) {
    const tip = document.createElement('p');
    tip.className = 'hint';
    tip.textContent = '以下插件目录被跳过: ' + data.skipped.map(s => s.dir + '(' + s.reason + ')').join('; ');
    box.appendChild(tip);
  }
}