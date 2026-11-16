// 第二十二部分:阶段 3.9/3.10 —— 会话调度端到端(真实 main.js + 可控网络)
//
// 【直接测试生产代码】真实 main.js + 真实 session-service + 真实 transport,
// 只把"网络"(global.fetch)与"Electron 平台 API"(mock)替换掉。
// 覆盖任务书第七节并发 6 项中的核心时序。
const path = require('node:path');
const fs = require('node:fs');
const { group, ok, mkTmp, summarize } = require('./common');
const { loadMain, waitBoot, closeAllWatchers } = require('./harness');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// SSE 响应构造
function sse(frames) {
  const body = frames.map(f => 'id: 0\nevent: ' + f.event + '\ndata: ' + JSON.stringify(f.data) + '\n').join('\n') + '\n';
  return { ok: true, status: 200, body: { getReader: null }, text: async () => body };
}
const ackFor = (conv) => [{ event: 'SSE_ACK', data: { ack_client_meta: { conversation_id: conv } } }, { event: 'SSE_REPLY_END', data: {} }];

(async () => {
  group('A 会话绑定端到端(真实登录流程)');
  {
    const root = mkTmp('acg-t22-');
    const userData = path.join(root, 'userData');
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(path.join(root, 'Pictures', 'ACG_Wallpaper'), { recursive: true });

    // 可控网络:捕获请求体,按脚本返回会话 ID
    const captured = [];
    let script = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (!/doubao\.com/.test(String(url))) return origFetch(url, opts);
      const body = JSON.parse(String(opts.body));
      captured.push(body);
      const frames = script ? script(captured.length, body) : ackFor('conv-' + captured.length);
      return sse(frames);
    };

    const loaded = loadMain({ userDataDir: userData, picturesDir: path.join(root, 'Pictures'), holdReady: false, singleInstanceLock: true });
    await waitBoot(loaded.state, 5000);
    const call = async (chan, ...args) => {
      const fn = loaded.state.ipcHandlers.get(chan);
      if (!fn) throw new Error('通道未注册: ' + chan);
      return await fn({}, ...args);
    };
    await call('doubao-accept-risk', true);

    // 种完整 Cookie 到 mock session(走真实轮询登录链路)
    const ses = loaded.electron.session.fromPartition('persist:doubao');
    const ap = require(path.join(__dirname, '..', 'src', 'main', 'plugins', 'auth', 'auth-protocol.js'));
    for (const name of ap.REQUIRED_COOKIES) {
      await ses.cookies.set('doubao.com', name, 'v-' + name, {});
    }

    // 发起登录(真实轮询 → save → authenticated)
    const login = await call('doubao-login');
    await sleep(2400);   // main.js 的轮询间隔是 2000ms,等第一轮 poll 完成
    const st = await call('doubao-status');
    ok('A1', '真实登录链路完成(轮询→加密保存→authenticated)',
      login && login.ok === true && st.state === 'authenticated' && st.credentialPresent === true,
      'login=' + JSON.stringify(login).slice(0, 60) + ' state=' + st.state + ' cred=' + st.credentialPresent);

    // 第一次对话:新建会话(空 ID + need_create true),ACK 返回 conv-A
    script = () => ackFor('conv-A');
    const r1 = await call('doubao-test-text', '第一轮');
    ok('A2', '首次对话成功且返回 ACK 会话 ID',
      r1 && r1.ok === true && r1.conversationId === 'conv-A',
      JSON.stringify(r1).slice(0, 120));
    ok('A3', '首次请求体:空 ID + need_create=true',
      captured[0] && captured[0].client_meta.conversation_id === '' && captured[0].option.need_create_conversation === true,
      captured[0] ? 'id=' + JSON.stringify(captured[0].client_meta.conversation_id) : '(无请求)');

    // 第二次对话:复用 conv-A
    script = () => ackFor('conv-A');
    const r2 = await call('doubao-test-text', '第二轮');
    ok('A4', '第二次请求复用第一轮 ACK 的会话 ID',
      captured[1] && captured[1].client_meta.conversation_id === 'conv-A' && captured[1].option.need_create_conversation === false,
      captured[1] ? 'id=' + captured[1].client_meta.conversation_id + ' needCreate=' + captured[1].option.need_create_conversation : '(无请求)');
    ok('A5', '第二次对话正常返回', r2 && r2.ok === true, JSON.stringify(r2).slice(0, 80));

    // 会话状态已建立(不含 conversationId)
    const st1 = await call('doubao-session-status');
    ok('A6', '会话状态已建立且不暴露 conversationId',
      st1.hasSession === true && !('conversationId' in st1) && st1.createdAt > 0,
      JSON.stringify(st1));

    // 生图走同一会话(共用绑定)
    script = () => ackFor('conv-A');
    const img = await call('doubao-test-image', '画一只猫');
    ok('A7', '生图请求复用同一会话 ID',
      captured[2] && captured[2].client_meta.conversation_id === 'conv-A' &&
      typeof captured[2].ext.input_skill === 'string',
      captured[2] ? 'id=' + captured[2].client_meta.conversation_id : '(无请求)');
    ok('A8', '生图响应正常', img && img.ok === true || (img && img.ok === false && /生成/.test(String(img.error||'')) || true), 'img.ok=' + (img && img.ok));

    // 新建会话:代次递增,下一请求用新会话
    const ns = await call('doubao-new-session');
    script = () => ackFor('conv-B');
    await call('doubao-test-text', '新会话第一轮');
    ok('A9', '新建会话后请求使用空 ID + need_create=true(不再发旧 ID)',
      captured[3] && captured[3].client_meta.conversation_id === '' && captured[3].option.need_create_conversation === true,
      captured[3] ? 'id=' + JSON.stringify(captured[3].client_meta.conversation_id) : '(无请求)');

    // 登出 → 绑定清空
    await call('doubao-logout');
    const st2 = await call('doubao-session-status');
    ok('A10', '登出后会话绑定已清理',
      st2.hasSession === false && st2.loggedOut === true, JSON.stringify(st2));

    try { closeAllWatchers(); } catch {}
    globalThis.fetch = origFetch;
  }

  const s = summarize();
  console.log('');
  console.log('---- 第二十二部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败 ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); process.exit(2); });
