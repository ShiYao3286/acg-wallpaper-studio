// status.js:状态栏/代理探测/旧任务徽标。自 renderer.js 逐行迁出。

async function refreshStatus() {
  const st = await api.getStatus();
  // AI 页模型下拉:跟随当前画图服务的模型列表 + 豆包引擎(阶段3)
  await refreshImageEngineOptions(st);
  // 模型列表拉取失败不再静默:明确告诉用户失败了、原因是什么,而不是留一个空下拉框让人猜
  const modelsErrTip = st.imageModelsError ? ('模型列表获取失败: ' + st.imageModelsError) : '';
  if (st.currentPath) {
    $('preview').src = encodeURI('file:///' + st.currentPath.replace(/\\/g, '/')) + '?t=' + Date.now();
  }
  // 优先展示回执信息(新旧脚本动作统一走 wallpaper_meta.json)
  const meta = st.scriptMeta;
  if (meta && meta.time) {
    const who = meta.source === 'script' ? '旧脚本' : (meta.source === 'app' ? '软件' : meta.source);
    if (meta.source === 'app' && meta.prompt) {
      // AI 随机生成的图:展示这张图的提示词(截断)
      const p = meta.prompt.length > 96 ? meta.prompt.slice(0, 96) + '…' : meta.prompt;
      $('hero-title').textContent = 'AI 随机壁纸 · ' + (meta.randomMode === 'portrait' ? '人物' : meta.randomMode === 'scenery' ? '风景' : '随机');
      $('hero-sub').textContent = who + ' · ' + meta.time + ' · 提示词: ' + p;
    } else {
      const desc = meta.title ? (meta.title + (meta.author ? ' / ' + meta.author : '') + (meta.pid ? ' / pid:' + meta.pid : '')) : (meta.tag || '');
      $('hero-title').textContent = desc || '当前壁纸';
      $('hero-sub').textContent = (who ? who + ' 于 ' + meta.time + ' 更新' : '') + (meta.tag ? ' · 标签: ' + meta.tag : '');
    }
  } else {
    const info = st.lastInfo || '';
    if (info) {
      $('hero-title').textContent = info.split(' · ')[0] || '当前壁纸';
      $('hero-sub').textContent = info;
    }
  }
  $('status-text').textContent = st.sourceLabel + (meta && meta.time ? ' · 上次动作: ' + (meta.source === 'script' ? '旧脚本' : '软件') + ' ' + meta.time : (st.lastInfo ? ' · 上次: ' + st.lastInfo : ''));
  $('status-right').textContent = (modelsErrTip ? modelsErrTip + ' · ' : '') + (st.oldTaskRunning ? '旧任务运行中 · ' : '') + (st.nextRun ? '下次自动换图 ' + st.nextRun : '自动换图已关闭');
}

// ---------- 代理探测 ----------
async function detectProxy() {
  $('proxy-detect-result').textContent = '探测常见端口中(7897/7890/10809…)…';
  const r = await api.detectProxy();
  if (r.found.length) {
    $('proxy-detect-result').textContent = '✓ 发现代理: ' + r.found.join(', ');
    $('proxy-url').value = r.found[0];
    await api.saveConfig('proxy.url', r.found[0]);
    toast('已自动填入 ' + r.found[0] + ',记得打开「启用代理」开关');
  } else {
    $('proxy-detect-result').textContent = '✗ 未发现常见代理端口,请确认代理软件已运行';
  }
}

// ---------- 旧脚本联动 ----------
// 主进程监听到壁纸目录文件变化(旧脚本换图/归档)时推送此事件
api.onUiRefresh(async (reason) => {
  // 主进程推送时若 get-status 抛错,不 catch 会产生 unhandled rejection
  try {
    await refreshStatus();
  } catch (e) {
    $('status-text').textContent = '状态刷新失败: ' + ((e && e.message) || e);
  }
  // 只有真正来自外部(旧脚本等)的写入才提示,本程序自身写入不打扰用户
  if (reason === 'external') {
    toast('检测到旧脚本更换了壁纸,已同步', 2200);
  }
  // 阶段3:豆包登录状态变化由主进程推送
  if (typeof reason === 'string' && reason.startsWith('doubao:')) {
    try { await refreshDoubao(); } catch {}
  }
});

// 设置页旧任务徽章
async function refreshOldTaskBadge() {
  const st = await api.queryOldTask();
  const el = $('old-task-status');
  if (!el) return;
  el.textContent = st.exists ? (st.enabled ? '⚠ 旧任务启用中(每30分钟会换图)' : '已停用 ✓') : '未找到(可能已删除)';
}

const _origLoadConfig = loadConfig;
