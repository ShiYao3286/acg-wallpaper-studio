// services.js:模型页(画图 / 提示词引擎面板)+ 服务编辑器 + 插件列表。
// 模型与服务的选择只在这里;插件中心只管插件。

let editingSvc = null;

// ---------- 引擎面板 ----------
// 20 秒轮询会反复进来,用签名挡住无意义的 DOM 重建(否则用户正展开下拉时会被刷掉)。
let __engSig = '';
// 每个服务手动「拉取模型」拿到的列表,只存内存,不落盘。
let __svcModels = {};

function mkEngRow(o) {
  const row = document.createElement('div');
  row.className = 'eng-row' + (o.active ? ' on' : '');

  const dot = document.createElement('span');
  dot.className = 'eng-dot';
  row.appendChild(dot);

  const main = document.createElement('div');
  main.className = 'eng-main';
  const nm = document.createElement('strong');
  nm.textContent = o.name;
  main.appendChild(nm);
  if (o.sub) {
    const sub = document.createElement('span');
    sub.className = 'eng-sub';
    sub.textContent = o.sub;
    main.appendChild(sub);
  }
  row.appendChild(main);

  const right = document.createElement('div');
  right.className = 'eng-right';

  if (o.models && o.models.length) {
    const sel = document.createElement('select');
    sel.className = 'eng-model';
    for (const m of o.models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    }
    sel.value = o.model || o.models[0];
    if (o.onModel) sel.addEventListener('change', () => o.onModel(sel.value));
    right.appendChild(sel);
  }

  if (o.onPull) {
    const pb = document.createElement('button');
    pb.className = 'btn small ghost';
    pb.textContent = '拉取模型';
    pb.addEventListener('click', () => o.onPull(pb));
    right.appendChild(pb);
  }

  if (o.active) {
    const cur = document.createElement('span');
    cur.className = 'eng-cur';
    cur.textContent = '使用中';
    right.appendChild(cur);
  } else {
    const use = document.createElement('button');
    use.className = 'btn small';
    use.textContent = '使用';
    use.addEventListener('click', () => { if (o.onUse) o.onUse(); });
    right.appendChild(use);
  }

  if (o.onEdit) {
    const eb = document.createElement('button');
    eb.className = 'btn small ghost';
    eb.textContent = '编辑';
    eb.addEventListener('click', () => o.onEdit());
    right.appendChild(eb);
  }
  if (o.onDelete) {
    const db = document.createElement('button');
    db.className = 'btn small ghost';
    db.textContent = '删除';
    db.addEventListener('click', () => o.onDelete());
    right.appendChild(db);
  }

  row.appendChild(right);
  return row;
}

function engEmpty(box, text) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  box.appendChild(p);
}

// 提示行只渲染主进程给的那一条诊断结果(imageIssue),
// 渲染层不再自己拼"没服务/没登录/拉不到"四种文案 —— 文案只有一处真源。
function updateModelHint(status) {
  const hint = $('ai-model-hint');
  if (!hint) return;
  const issue = status && status.imageIssue;
  let msg = '';
  let warn = false;
  if (issue && issue.message) {
    msg = issue.message + (issue.action ? ' · ' + issue.action : '');
    warn = issue.level === 'warn';
  }
  hint.textContent = msg;
  hint.style.display = msg ? '' : 'none';
  hint.style.color = msg ? (warn ? '#FBBF24' : '#6B7686') : '';
}

async function loadServices(st) {
  let cfg, services, status;
  try {
    cfg = await api.getConfig();
    services = await api.listServices();
    status = st || await api.getStatus();
  } catch (e) {
    toast('读取模型配置失败: ' + ((e && e.message) || e), 4000);
    return;
  }
  services = services || [];
  status = status || { imageModels: [], imageModelsError: '' };

  let doubaoState = null;
  try { doubaoState = await api.doubao.status(); } catch {}
  const doubaoReady = !!(doubaoState && doubaoState.state === 'authenticated');
  const engine = (cfg.ai && cfg.ai.imageEngine) || 'service';
  const imgActive = cfg.activeImageService || '';
  const txtActive = cfg.activeTextService || '';
  const imgs = services.filter(s => s.kind === 'image');
  const txts = services.filter(s => s.kind === 'text');

  const sig = JSON.stringify([
    engine, imgActive, txtActive, doubaoReady,
    status.imageModels || [], status.imageModelsError || '',
    services.map(s => [s.id, s.kind, s.name, s.model, s.apiBase]),
    imgs.map(s => (__svcModels[s.id] || []).length),
  ]);
  if (sig === __engSig) { updateModelHint(status); return; }
  __engSig = sig;

  const imgBox = $('engine-image-list');
  if (imgBox) {
    imgBox.textContent = '';
    imgBox.appendChild(mkEngRow({
      active: engine === 'doubao',
      name: '豆包 Seedream',
      sub: doubaoReady ? '已登录 · 个人账号(非官方接入)' : '未登录 · 选它生成一定失败',
      onUse: () => useImageEngine('doubao'),
    }));

    for (const s of imgs) {
      const activeRow = engine === 'service' && s.id === imgActive;
      const pulled = __svcModels[s.id] || [];
      // 当前生效的服务直接用主进程缓存的模型表;其余用手动拉到的;再不济只有配置里的默认模型
      let models = (activeRow && status.imageModels && status.imageModels.length)
        ? status.imageModels.slice()
        : (pulled.length ? pulled.slice() : []);
      if (!models.length && s.model) models = [s.model];
      if (s.model && !models.includes(s.model)) models.unshift(s.model);

      imgBox.appendChild(mkEngRow({
        active: activeRow,
        name: s.name || s.id,
        sub: s.apiBase || '',
        models,
        model: s.model,
        onModel: (m) => changeServiceModel(s.id, m),
        onPull: (btn) => pullServiceModels(s.id, btn),
        onUse: () => useImageEngine(s.id, s.model),
        onEdit: () => editService(s.id),
        onDelete: () => deleteService(s.id),
      }));
    }
    if (!imgs.length) engEmpty(imgBox, '还没有画图服务。点下方「添加画图服务」填地址与密钥。');
  }

  const txtBox = $('engine-text-list');
  if (txtBox) {
    txtBox.textContent = '';
    txtBox.appendChild(mkEngRow({
      active: !txtActive,
      name: '本地词池(不调模型)',
      sub: '主题 + 标签池 + 风格词随机拼装,不消耗额度',
      onUse: () => useTextEngine(''),
    }));
    // 内置豆包文本模型:之前只列 kind=text 的 API 服务,豆包永远选不到
    txtBox.appendChild(mkEngRow({
      active: txtActive === 'builtin:doubao',
      name: '豆包 文本模型',
      sub: doubaoReady ? '已登录 · 扩写会消耗额度' : '未登录 · 选了也调不动,先回上面扫码登录',
      onUse: () => useTextEngine('builtin:doubao'),
    }));
    for (const s of txts) {
      const activeRow = s.id === txtActive;
      const pulled = __svcModels[s.id] || [];
      let models = pulled.length ? pulled.slice() : [];
      if (!models.length && s.model) models = [s.model];
      if (s.model && !models.includes(s.model)) models.unshift(s.model);
      txtBox.appendChild(mkEngRow({
        active: activeRow,
        name: s.name || s.id,
        sub: s.apiBase || '',
        models,
        model: s.model,
        onModel: (m) => changeServiceModel(s.id, m),
        onPull: (btn) => pullServiceModels(s.id, btn),
        onUse: () => useTextEngine(s.id),
        onEdit: () => editService(s.id),
        onDelete: () => deleteService(s.id),
      }));
    }
    if (!txts.length) engEmpty(txtBox, '还没有文本服务。不添加也能用本地词池。');
  }

  updateModelHint(status);

  // 创作页那行只读摘要
  const brief = $('ai-model-brief');
  if (brief) {
    if (engine === 'doubao') {
      brief.textContent = '豆包 Seedream' + (doubaoReady ? '' : '(未登录)');
    } else {
      const svc = imgs.find(s => s.id === imgActive);
      const m = (cfg.ai && cfg.ai.model) || (svc && svc.model) || '';
      brief.textContent = (svc ? (svc.name || svc.id) : '未选服务') + (m ? ' · ' + m : '');
    }
  }
  const sizeBrief = $('ai-size-brief');
  if (sizeBrief) {
    const sz = $('ai-size');
    sizeBrief.textContent = (sz && sz.value) || '—';
  }
}

// ---------- 切换生效项 ----------
async function useImageEngine(target, model) {
  try {
    if (target === 'doubao') {
      const r = await api.saveConfig('ai.imageEngine', 'doubao');
      if (r && r.ok === false) { toast('切换失败: ' + (r.error || '未知错误'), 4000); return; }
      toast('画图引擎已切到豆包 Seedream');
    } else {
      const services = await api.listServices();
      const svc = services.find(s => s.id === target);
      const r1 = await api.setActiveService('image', target);
      if (r1 && r1.ok === false) { toast('切换失败: ' + (r1.error || '未知错误'), 4000); return; }
      await api.saveConfig('ai.imageEngine', 'service');
      await api.saveConfig('ai.model', model || (svc && svc.model) || '');
      toast('画图引擎已切到 ' + ((svc && svc.name) || target) + (model ? ' · ' + model : ''));
    }
  } catch (e) {
    toast('切换失败: ' + ((e && e.message) || e), 4000);
    return;
  }
  __engSig = '';
  loadServices();
}

async function useTextEngine(id) {
  try {
    const r = await api.setActiveService('text', id);
    if (r && r.ok === false) { toast('切换失败: ' + (r.error || '未知错误'), 4000); return; }
  } catch (e) {
    toast('切换失败: ' + ((e && e.message) || e), 4000);
    return;
  }
  toast(id ? '提示词引擎已切换' : '已改用本地词池');
  __engSig = '';
  loadServices();
  refreshAssistEngine().catch(() => {});
}

// 行内模型下拉:写回该服务的默认模型;若它正好是当前画图服务,同步 ai.model
async function changeServiceModel(id, model) {
  try {
    const services = await api.listServices();
    const svc = services.find(s => s.id === id);
    if (!svc) return;
    const r = await api.saveService({ ...svc, model });
    if (r && r.ok === false) { toast('保存模型失败: ' + (r.error || '未知错误'), 4000); return; }
    const cfg = await api.getConfig();
    if (cfg.activeImageService === id && ((cfg.ai && cfg.ai.imageEngine) || 'service') === 'service') {
      await api.saveConfig('ai.model', model);
    }
    toast('模型已设为 ' + model, 2600);
    __engSig = '';
    loadServices();
  } catch (e) {
    toast('保存失败: ' + ((e && e.message) || e), 4000);
  }
}

// 单个服务拉取模型列表(按钮上的动作,不依赖"当前服务")
async function pullServiceModels(id, btn) {
  if (btn) btn.disabled = true;
  try {
    const services = await api.listServices();
    const svc = services.find(s => s.id === id);
    if (!svc) return;
    toast('正在向 ' + (svc.name || svc.id) + ' 拉取模型列表…', 3000);
    const r = await api.fetchModels(svc);
    if (!r || !r.ok) { toast('拉取失败: ' + ((r && r.error) || '未知错误'), 6000); return; }
    const list = Array.isArray(r.models) ? r.models : [];
    __svcModels[id] = list;
    toast('已拉到 ' + list.length + ' 个模型', 2600);
    __engSig = '';
    loadServices();
  } catch (e) {
    toast('拉取失败: ' + ((e && e.message) || e), 5000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- 服务编辑器 ----------
function newService(kind) {
  const k = (kind === 'text') ? 'text' : 'image';
  editingSvc = { id: 'svc-' + Date.now(), kind: k, name: '', apiBase: '', apiKey: '', model: '' };
  $('svc-editor-title').textContent = k === 'text' ? '添加文本服务' : '添加画图服务';
  $('svc-name').value = ''; $('svc-kind').value = k; $('svc-base').value = '';
  $('svc-key').value = ''; $('svc-model').value = ''; $('svc-model-list').innerHTML = '';
  $('svc-editor-result').textContent = '';
  $('svc-editor').style.display = 'block';
  try { $('svc-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
}

async function editService(id) {
  const services = await api.listServices();
  const s = services.find(x => x.id === id);
  if (!s) return;
  editingSvc = { ...s };
  // 列表已脱敏(不带密钥),要回显密钥得单独取一次
  let key = '';
  try { const r = await api.serviceKey(s.id); if (r && r.ok) key = r.apiKey || ''; } catch {}
  editingSvc.apiKey = key;
  $('svc-editor-title').textContent = '编辑服务: ' + (s.name || '');
  $('svc-name').value = s.name || ''; $('svc-kind').value = s.kind;
  $('svc-base').value = s.apiBase || ''; $('svc-key').value = key;
  $('svc-model').value = s.model || ''; $('svc-model-list').innerHTML = '';
  $('svc-editor-result').textContent = '';
  $('svc-editor').style.display = 'block';
  try { $('svc-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
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
  __engSig = '';
  loadServices();
  toast('服务已保存');
}

async function deleteService(id) {
  if (!confirm('确定删除该服务?')) return;
  try {
    const r = await api.deleteService(id);
    if (!r || r.ok === false) { toast('删除失败: ' + ((r && r.error) || '未知错误'), 4000); return; }
    if (r.fellBackToDoubao) toast('画图服务已删完,已自动切回豆包(需要登录)', 4500);
  } catch (e) {
    toast('删除失败: ' + ((e && e.message) || '通信异常'), 4000);
    return;
  }
  delete __svcModels[id];
  __engSig = '';
  loadServices();
  toast('已删除');
}

// 编辑器里的「拉取模型」:只填 datalist 提示,不改服务
async function fetchModels() {
  if (!editingSvc) return;
  editingSvc.apiBase = $('svc-base').value.trim();
  editingSvc.apiKey = $('svc-key').value.trim();
  if (!editingSvc.apiBase) { toast('请先填 API 地址'); return; }
  const btn = $('btn-fetch-models'); btn.disabled = true; $('svc-editor-result').textContent = '拉取模型列表中…';
  try {
    const r = await api.fetchModels(editingSvc);
    if (r && r.ok) {
      fillModelOptions('svc-model-list', r.models);
      $('svc-editor-result').textContent = '拉取到 ' + r.models.length + ' 个模型: ' + r.models.slice(0, 6).join(', ') + (r.models.length > 6 ? ' …' : '');
    } else {
      $('svc-editor-result').textContent = '拉取失败: ' + ((r && r.error) || '未知错误');
    }
  } catch (e) {
    $('svc-editor-result').textContent = '拉取失败: ' + ((e && e.message) || e);
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
  try {
    const r = await api.testService(editingSvc);
    $('svc-editor-result').textContent = (r && r.ok) ? ('✓ ' + r.detail) : ('✗ ' + ((r && r.error) || '未知错误'));
  } catch (e) {
    $('svc-editor-result').textContent = '✗ ' + ((e && e.message) || e);
  }
}

// status.js 每轮 refreshStatus 都会调这里:传进来它的 get-status 快照,避免重复请求
async function refreshImageEngineOptions(st) {
  try { await loadServices(st); } catch {}
}

// ---------- 插件中心:插件列表 ----------
// 使用既有 IPC:api.listPlugins()(阶段2 已暴露,返回 { builtin, external, skipped })。
// 安全模型(方案 12.8.5):启用 = 信任并执行外部插件全部代码,UI 必须把这点讲清楚。
async function loadPluginList() {
  const box = $('plugin-list');
  if (!box) return;
  box.textContent = '';
  let data;
  try { data = await api.listPlugins(); } catch (e) {
    setEmptyTip(box, '插件列表加载失败: ' + ((e && e.message) || e));
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
