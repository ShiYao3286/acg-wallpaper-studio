// doubao.js:豆包账号域(状态机/登录/风险/模型/测试)。自 renderer.js 逐行迁出。

let doubaoRiskAccepted = false;
let doubaoState = null;

// 模型选择:全部列出,但只允许选 available 的。
// 工作任务模型列出来是让用户知道豆包有什么,不是给他用的 ——
// 选中后服务端会让那一轮变成工作任务并尝试调用本地工具执行器,本项目不接这个能力。
async function refreshDoubaoModels() {
  const sel = $('doubao-model-select');
  const eff = $('doubao-effort-select');
  const hint = $('doubao-model-hint');
  const box = $('doubao-models');
  if (!sel || !box) return;
  try {
    const m = await api.doubao.models();
    sel.textContent = '';
    for (const item of m.models) {
      const opt = document.createElement('option');
      opt.value = item.key;
      opt.textContent = item.name
        + (item.taskMode ? ' [工作任务]' : '')
        + (item.available ? '' : ' — 不可选');
      // 不可用的置灰并禁用,但仍展示(选 B 方案)
      if (!item.available) { opt.disabled = true; opt.style.color = '#6b7280'; }
      sel.appendChild(opt);
    }
    sel.value = m.current;

    // 推理强度:仅对支持思考的模型有意义,但不隐藏(用户可能切换模型)
    if (eff) {
      eff.textContent = '';
      for (const lv of m.effortLevels) {
        const o = document.createElement('option');
        o.value = String(lv.level);
        o.textContent = lv.name;
        eff.appendChild(o);
      }
      eff.value = String(m.reasoningEffort || 5);
    }

    // 提示:生图模型不可选(服务端路由)
    // 画图模型:由豆包服务端按账号权益路由,客户端选不了;这里只如实展示
    const imgEl = $('doubao-image-model');
    const imgName = (m.imageModel && m.imageModel.name) || '未上报';
    if (imgEl) imgEl.textContent = imgName;
    if (hint) {
      hint.textContent = '文本模型与推理强度可自选;画图模型由豆包服务端按账号权益路由,不可自选。';
    }
    box.style.display = '';
  } catch (e) {
    if (hint) hint.textContent = '读取模型列表失败: ' + ((e && e.message) || e);
  }
}

async function saveDoubaoModel() {
  const sel = $('doubao-model-select');
  const eff = $('doubao-effort-select');
  if (!sel) return;
  try {
    const r = await api.doubao.setModel(sel.value, Number(eff ? eff.value : 5));
    if (r && r.ok) {
      toast('已切换模型: ' + sel.options[sel.selectedIndex].textContent, 3000);
    } else {
      toast('切换失败: ' + ((r && r.error) || '未知'), 4000);
    }
  } catch (e) {
    toast('切换失败: ' + ((e && e.message) || e), 3200);
  }
}

// 状态 → 人话 + 颜色。
function doubaoStateText(st) {
  if (!st) return { text: '正在读取状态…', color: '' };
  switch (st.state) {
    case 'idle':
      return { text: '未登录。点击「扫码登录豆包」开始。', color: '' };
    case 'opening':
      return { text: '正在打开登录窗口…', color: '' };
    case 'awaiting_scan':
      return { text: '等待扫码中…请在豆包窗口里完成登录(5 分钟内有效)', color: '' };
    case 'authenticated':
      return { text: '已登录' + (st.savedAt ? '(' + new Date(st.savedAt).toLocaleString('zh-CN', { hour12: false }) + ' 登录)' : ''), color: '#4ade80' };
    case 'expired':
      return { text: '登录已过期,需要重新扫码登录。' + (st.lastError || ''), color: '#fbbf24' };
    case 'cancelled':
      return { text: '已取消登录。', color: '' };
    case 'error':
      return { text: '登录出错: ' + (st.lastError || '未知原因'), color: '#f87171' };
    default:
      return { text: '状态未知: ' + st.state, color: '' };
  }
}

// 渲染按钮组。按状态决定能做什么,避免点了没反应。
//
// riskAccepted 参与判断的原因(阶段3 审核问题):
//   - 消耗额度的按钮和"发起新登录"必须要求风险已确认;
//   - 但"退出账号""取消登录"是止损操作,任何时候都必须给得出来,
//     否则已登录用户重启后被锁在账号里出不去。
function doubaoButtons(st, riskAccepted) {
  const btns = [];
  const S = st ? st.state : 'idle';
  const risk = !!riskAccepted;
  if (S === 'authenticated') {
    if (risk) {
      btns.push({ act: 'doubao-test-text', label: '测试文本(消耗额度)' });
      btns.push({ act: 'doubao-test-image', label: '测试生图(消耗额度)' });
      // 新建会话:换上下文用。原来只有 IPC 没有入口,等于该功能不存在。
      btns.push({ act: 'doubao-new-session', label: '新建会话', ghost: true });
    }
    // 退出账号:永远显示。它是止损路径,不能被风险确认状态挡住。
    btns.push({ act: 'doubao-logout', label: '退出账号', ghost: true });
    // 重新登录要开新窗口,属于"发起登录",需要风险确认
    if (risk) btns.push({ act: 'doubao-relogin', label: '重新登录', ghost: true });
  } else if (S === 'awaiting_scan' || S === 'opening') {
    // 取消登录:永远显示,同样是止损路径
    btns.push({ act: 'doubao-cancel-login', label: '取消登录', ghost: true });
  } else {
    // 新登录入口:必须风险已确认
    if (risk) btns.push({ act: 'doubao-login', label: '扫码登录豆包' });
  }
  return btns;
}

async function refreshDoubao() {
  try {
    const st = await api.doubao.status();
    doubaoState = st;
    const box = $('doubao-status-text');
    if (!box) return;
    const info = doubaoStateText(st);
    box.textContent = info.text;
    box.style.color = info.color || '';

    // safeStorage 不可用要明确告知:这种情况下无法保存凭据
    if (st.encryptionAvailable === false) {
      box.textContent += ' 【系统安全存储不可用,无法保存登录凭据】';
      box.style.color = '#f87171';
    }

    // 风险确认状态要在渲染按钮【之前】拿到:
    // 按钮组本身就要靠它决定显示哪些按钮,顺序反了会先渲染出登录入口再隐藏,
    // 视觉上有闪烁,逻辑上也会让"已登录未确认"这一态短暂出现错误按钮。
    try {
      const r = await api.doubao.riskAccepted();
      doubaoRiskAccepted = !!(r && r.accepted);
    } catch { doubaoRiskAccepted = false; }

    const act = $('doubao-actions');
    if (act) {
      act.textContent = '';
      for (const b of doubaoButtons(st, doubaoRiskAccepted)) {
        const btn = document.createElement('button');
        btn.className = 'btn small' + (b.ghost ? ' ghost' : '');
        btn.textContent = b.label;
        btn.dataset.act = b.act;
        act.appendChild(btn);
      }
    }

    const risk = $('doubao-risk');
    if (risk) {
      // 已登录但未确认也必须显示:原来只在"未登录"时显示,导致已登录 + 未确认时
      // 按钮组只剩「退出账号」,用户没有任何入口去补确认。
      risk.style.display = doubaoRiskAccepted ? 'none' : 'block';
    }

    // 操作区可见性。
    //
    // 阶段3 审核发现的 bug:旧实现是
    //   if (!doubaoRiskAccepted) act.style.display = 'none';
    // 而 hasAcceptedDoubaoRisk 每次启动都重置为 false,于是
    // "重启 → authManager.restore() 恢复成 authenticated → 风险提示隐藏
    //   → 操作区也被隐藏" 三者叠加,已登录用户看不到【退出账号】按钮,
    // 只能去删配置文件,等于把账号锁死在应用里。
    //
    // 正确语义:风险确认只该拦住"发起新登录"和"消耗额度",
    // 不该拦住退出账号、取消登录这类【必要的管理/止损操作】。
    // 已登录时即使风险未确认,也必须给得出退出账号。
    //
    // 这里只改显示判断,【不】把 doubaoRiskAccepted 自动置 true ——
    // 那等于伪造用户确认,是更严重的错误。
    if (act) {
      const needsManageAction = (st.state === 'authenticated' || st.state === 'awaiting_scan' || st.state === 'opening');
      act.style.display = (doubaoRiskAccepted || needsManageAction) ? '' : 'none';
    }

    // 阶段3.9:工作会话状态行(不展示 conversationId)
    const sessBox = $('doubao-session');
    if (sessBox) {
      if (st.state === 'authenticated') {
        try {
          const ss = await api.doubao.sessionStatus();
          let text;
          if (ss.invalid) {
            text = '当前工作会话已失效。下一次请求将自动创建新会话，之前的上下文不会自动继承。';
            sessBox.style.color = '#fbbf24';
          } else if (ss.hasSession) {
            text = '工作会话 ' + (ss.sessionTag ? '#' + ss.sessionTag + ' ' : '') + '进行中 · 自 ' + new Date(ss.createdAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' 起。连续对话会继承此前上下文，旧要求可能影响后续结果。';
            sessBox.style.color = '';
          } else {
            text = '尚未建立工作会话，下一次请求会自动创建。';
            sessBox.style.color = '';
          }
          sessBox.textContent = text;
          sessBox.style.display = '';
        } catch { sessBox.style.display = 'none'; }
      } else {
        sessBox.textContent = '';
        sessBox.style.display = 'none';
      }
    }

    // 绑定已有会话:仅登录后出现 —— 从豆包网页复制会话链接粘进来即可
    const bindBox = $('doubao-bind');
    if (bindBox) bindBox.style.display = (st.state === 'authenticated') ? '' : 'none';
    // 拉取账号会话列表:同样仅登录后出现(走非公开接口,失败不影响粘贴绑定)
    const convBox = $('doubao-conv');
    if (convBox) convBox.style.display = (st.state === 'authenticated') ? '' : 'none';

    // 模型选择区:仅登录后显示;未登录时没有意义
    const modelBox = $('doubao-models');
    if (modelBox) {
      if (st.state === 'authenticated') { await refreshDoubaoModels(); }
      else { modelBox.style.display = 'none'; }
    }
  } catch (e) {
    const box = $('doubao-status-text');
    if (box) box.textContent = '读取豆包状态失败: ' + ((e && e.message) || e);
  }
}

async function doubaoLogin() {
  if (!doubaoRiskAccepted) {
    toast('请先阅读并确认风险提示', 3200);
    return;
  }
  try {
    const r = await api.doubao.login();
    toast(r.ok ? '已打开登录窗口,请扫码' : ('登录启动失败: ' + (r.error || '')), 4000);
    refreshDoubao();
  } catch (e) {
    toast('登录启动失败: ' + ((e && e.message) || e), 4000);
  }
}

async function doubaoAcceptRisk() {
  try {
    const r = await api.doubao.acceptRisk(true);
    if (r && r.ok) {
      doubaoRiskAccepted = true;
      toast('已确认风险提示', 2600);
      refreshDoubao();
    }
  } catch (e) {
    toast('操作失败: ' + ((e && e.message) || e), 3200);
  }
}

function doubaoDeclineRisk() {
  const risk = $('doubao-risk');
  if (risk) risk.style.display = 'none';
  toast('已取消。未确认风险提示前不会启用豆包登录。', 3200);
}

async function doubaoTestText() {
  toast('正在请求豆包(会消耗少量额度)…', 6000);
  try {
    const r = await api.doubao.testText('你好，请只回复两个字：收到');
    if (r && r.ok) {
      toast('豆包回复: ' + String(r.text || '').slice(0, 40), 6000);
    } else {
      toast('失败: ' + ((r && r.error) || '未知'), 6000);
    }
    if (r && r.errorKind === 'AUTH_EXPIRED') {
      refreshDoubao();
    }
  } catch (e) {
    toast('请求失败: ' + ((e && e.message) || e), 5000);
  }
}

async function doubaoTestImage() {
  toast('正在生成测试图(会消耗一次生图额度,约 30-90 秒)…', 10000);
  try {
    const r = await api.doubao.testImage('一只白色的猫，坐姿，简洁背景，二次元风格');
    if (r && r.ok) {
      toast('生成成功: ' + r.width + 'x' + r.height + ' ' + String(r.format).toUpperCase() + ' ' + (r.bytes/1024).toFixed(0) + 'KB', 8000);
    } else {
      toast('生图失败: ' + ((r && r.error) || '未知'), 8000);
    }
    if (r && r.errorKind === 'AUTH_EXPIRED') refreshDoubao();
  } catch (e) {
    toast('生图请求失败: ' + ((e && e.message) || e), 6000);
  }
}

// 新建会话:确认提示明确告知"旧上下文不继承"(任务书 S4)。
async function doubaoNewSession() {
  if (!confirm('确定新建豆包工作会话吗？\n\n· 新会话不会继承当前对话的上下文。\n· 旧会话的记录仍保留在你的豆包账号中。')) return;
  try {
    const r = await api.doubao.newSession();
    toast(r && r.ok ? '已新建工作会话,下一次请求生效' : '新建会话失败: ' + ((r && r.error) || '未知'), 4000);
    refreshDoubao();
  } catch (e) {
    toast('新建会话失败: ' + ((e && e.message) || e), 4000);
  }
}

// 绑定已有会话:接上自己在豆包里已有的对话,继承那边的上下文。
async function doubaoBindSession() {
  const inp = $('bind-session-input');
  const val = (inp && inp.value || '').trim();
  if (!val) { toast('先粘贴会话链接或会话 ID', 3500); return; }
  const btn = document.querySelector('[data-act="doubao-bind-session"].btn');
  if (btn) btn.disabled = true;
  try {
    const r = await api.doubao.bindSession(val);
    if (r && r.ok) {
      toast('已绑定会话' + (r.sessionTag ? ' #' + r.sessionTag : '') + ',下一次请求会在这个对话里继续', 5000);
      if (inp) inp.value = '';
    } else {
      toast('绑定失败: ' + ((r && r.error) || '未知'), 5000);
    }
    refreshDoubao();
  } catch (e) {
    toast('绑定失败: ' + ((e && e.message) || e), 5000);
  } finally { if (btn) btn.disabled = false; }
}

// 拉取账号里的会话列表(方案B):豆包非公开接口,失败时要说得清楚,别留个空下拉。
async function doubaoConvList() {
  toast('正在拉取账号会话列表…', 5000);
  try {
    const r = await api.doubao.conversationList();
    if (!r || !r.ok) { toast('拉取失败: ' + ((r && r.error) || '未知错误'), 7000); return; }
    const items = (r.items || []).slice();
    const sel = $('conv-select');
    const bindBtn = $('btn-conv-bind');
    if (!sel) return;
    sel.textContent = '';
    for (const it of items) {
      const o = document.createElement('option');
      o.value = String(it.index);
      o.textContent = it.title + '  #' + it.tag;
      sel.appendChild(o);
    }
    if (!items.length) {
      sel.style.display = 'none';
      if (bindBtn) bindBtn.style.display = 'none';
      toast('账号下没有可用于拉取的会话', 5000);
      return;
    }
    sel.style.display = '';
    if (bindBtn) bindBtn.style.display = '';
    toast('拉到 ' + items.length + ' 个会话,选一条再点「绑定所选」', 5000);
  } catch (e) {
    toast('拉取失败: ' + ((e && e.message) || e), 6000);
  }
}

// 绑定下拉里选中的那条会话(完整 ID 在主进程内存里,这里只传序号)
async function doubaoConvBind() {
  const sel = $('conv-select');
  if (!sel || sel.value === '') { toast('先点「拉取账号会话」再选一条', 4000); return; }
  try {
    const r = await api.doubao.conversationSelect(sel.value);
    if (r && r.ok) {
      toast('已绑定会话' + (r.sessionTag ? ' #' + r.sessionTag : '') + (r.title ? '(' + r.title + ')' : '') + ',下一次请求在这个对话里继续', 6000);
    } else {
      toast('绑定失败: ' + ((r && r.error) || '未知'), 5000);
    }
    refreshDoubao();
  } catch (e) {
    toast('绑定失败: ' + ((e && e.message) || e), 5000);
  }
}

async function doubaoLogout() {
  try {
    const r = await api.doubao.logout();
    toast(r.ok ? '已退出豆包账号,凭据已删除' : ('退出失败: ' + (r.error || '')), 4000);
    refreshDoubao();
  } catch (e) {
    toast('退出失败: ' + ((e && e.message) || e), 3200);
  }
}
