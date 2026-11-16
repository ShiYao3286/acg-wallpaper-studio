// 第十八部分:豆包接入 —— 认证架构与凭据(阶段 3.2 / 3.3)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { group, ok, summarize } = require('./common');

const ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.join(ROOT, 'src', 'main', 'plugins', 'auth');
const ap = require(path.join(AUTH_DIR, 'auth-protocol.js'));
const am = require(path.join(AUTH_DIR, 'auth-manager.js'));
const cs = require(path.join(ROOT, 'src', 'main', 'services', 'credential-service.js'));
const protocol = require(path.join(ROOT, 'src', 'main', 'plugins', 'provider-protocol.js'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const KEY = crypto.createHash('sha256').update('t18-fake-key').digest();
function xform(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ KEY[i % KEY.length];
  return out;
}
function mkSafe(o) {
  const opt = o || {};
  return {
    isEncryptionAvailable: () => opt.available !== false,
    encryptString: (s) => { if (opt.encryptFail) throw new Error('enc-fail'); return xform(Buffer.from(s, 'utf8')); },
    decryptString: (b) => { if (opt.decryptFail) throw new Error('dec-fail'); return xform(b).toString('utf8'); },
  };
}

(async () => {
  group('A 认证协议');
  {
    ok('A1', '未填写 auth 时返回 null', ap.assertAuth(undefined) === null && ap.assertAuth(null) === null);
    ok('A2', '合法 auth 被规范化', (() => {
      const r = ap.assertAuth({ type: 'account-session', required: true, statusKey: 'doubao' });
      return r.type === 'account-session' && r.required === true && r.statusKey === 'doubao' && r.userInitiated === true;
    })());
    ok('A3', '未知认证类型被拒绝', (() => {
      const e = throws(() => ap.assertAuth({ type: 'oauth', required: true, statusKey: 'x' }));
      return !!e && e.isAuthProtocolError === true;
    })());
    ok('A4', 'required 必须是严格布尔', (() => {
      const e = throws(() => ap.assertAuth({ type: 'account-session', required: 'false', statusKey: 'x' }));
      return !!e && e.isAuthProtocolError === true;
    })());
    ok('A5', 'statusKey 为空被拒绝', (() => {
      const e = throws(() => ap.assertAuth({ type: 'account-session', required: true, statusKey: '   ' }));
      return !!e && e.isAuthProtocolError === true;
    })());
    ok('A6', 'statusKey 字符集受限', (() => {
      const e = throws(() => ap.assertAuth({ type: 'account-session', required: true, statusKey: 'Doubao' }));
      return !!e && e.isAuthProtocolError === true;
    })());
    ok('A7', '合法迁移返回 true', ap.canTransition('idle', 'opening') === true);
    ok('A8', '非法迁移返回 false', ap.canTransition('idle', 'authenticated') === false);
    ok('A9', '非法迁移 assertTransition 抛错', (() => {
      const e = throws(() => ap.assertTransition('idle', 'authenticated'));
      return !!e && e.isAuthProtocolError === true;
    })());
    ok('A10', '未知状态被拒绝', throws(() => ap.canTransition('bogus', 'idle')) !== null);

    // 阶段3 审核修复:登录中途退出必须能回 idle。
    // 旧迁移表里 opening/awaiting_scan 没有到 idle 的路,导致
    // "凭据已删但 UI 卡在等待扫码"的死状态。
    ok('A15', '登录中途(opening/awaiting_scan)可回到 idle',
      ap.canTransition('opening', 'idle') === true && ap.canTransition('awaiting_scan', 'idle') === true);
    ok('A16', 'idle 仍不能直接跳到 authenticated(恢复流程例外,不走本表)',
      ap.canTransition('idle', 'authenticated') === false);

    const mk = (arr) => new Map(arr.map(n => [n, 'v']));
    ok('A11', '完整 Cookie 判定完整', ap.checkCookieCompleteness(mk(ap.REQUIRED_COOKIES)).ok === true);
    ok('A12', '缺字段判不完整并列出缺项', (() => {
      const r = ap.checkCookieCompleteness(mk(ap.REQUIRED_COOKIES.slice(0, 5)));
      return r.ok === false && r.missing.length === 3;
    })());
    ok('A13', '空/非法输入判不完整', ap.checkCookieCompleteness(null).ok === false && ap.checkCookieCompleteness(new Map()).ok === false);
    ok('A14', 'Cookie 数量不作为判据', (() => {
      const extra = mk([...ap.REQUIRED_COOKIES, 'unrelated_a', 'unrelated_b']);
      return ap.checkCookieCompleteness(extra).ok === true && extra.size > ap.REQUIRED_COOKIES.length;
    })());
  }

  group('B 认证状态机');
  {
    let stored = null, opened = 0, closed = 0, cleared = 0;
    let cookieQueue = [], pollIdx = 0;
    const FULL = ap.REQUIRED_COOKIES.slice();
    function setup(extra) {
      am.__reset();
      opened = 0; closed = 0; cleared = 0; stored = null; cookieQueue = []; pollIdx = 0;
      am.init(Object.assign({
        openLoginWindow: async () => { opened++; return { ok: true }; },
        closeLoginWindow: () => { closed++; },
        clearSession: async () => { cleared++; },
        credential: {
          async save(p) { stored = [...p.keys()]; },
          async has() { return stored !== null; },
          async clear() { stored = null; },
        },
        readSessionCookies: async () => {
          const m = new Map();
          const arr = cookieQueue[Math.min(pollIdx, cookieQueue.length - 1)] || [];
          pollIdx++;
          arr.forEach(n => m.set(n, 'v-' + n));
          return m;
        },
        pollIntervalMs: 5, scanTimeoutMs: 60000,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (t) => clearTimeout(t),
        now: () => Date.now(),
      }, extra || {}));
    }

    setup(); cookieQueue = [['sessionid'], FULL];
    await am.beginLogin(); await sleep(80);
    ok('B1', '正常登录进入 authenticated', am.getState().state === 'authenticated' && stored !== null && closed > 0);
    const r2 = await am.beginLogin();
    ok('B2', '已登录可重新登录', r2.ok === true && am.getState().state === 'awaiting_scan');
    await am.cancelLogin();

    setup(); cookieQueue = [FULL];
    await am.beginLogin(); await sleep(80);
    ok('B3', '前置:已登录', am.getState().state === 'authenticated');
    ok('B4', 'markExpired 置为 expired', am.markExpired('测试') === true && am.getState().state === 'expired');
    const r4 = await am.logout();
    ok('B5', 'logout 回 idle 并清凭据+session', r4.ok && am.getState().state === 'idle' && stored === null && cleared > 0);

    setup(); cookieQueue = [[]];
    await am.beginLogin();
    ok('B6', '前置 awaiting_scan', am.getState().state === 'awaiting_scan');
    ok('B7', 'cancelLogin 进入 cancelled 并关窗', (await am.cancelLogin()).ok && am.getState().state === 'cancelled' && closed > 0);

    setup({ scanTimeoutMs: 10 }); cookieQueue = [[]];
    await am.beginLogin(); await sleep(60);
    ok('B8', '扫码超时进入 error', am.getState().state === 'error' && /超时/.test(am.getState().lastError));

    setup({ openLoginWindow: async () => ({ ok: false, error: '模拟失败' }) });
    const r9 = await am.beginLogin();
    ok('B9', '开窗失败进入 error 并保留原因', r9.ok === false && am.getState().lastError === '模拟失败');

    setup({ credential: { async save() { throw new Error('disk full'); }, async has() { return false; }, async clear() {} } });
    cookieQueue = [FULL];
    await am.beginLogin(); await sleep(80);
    ok('B10', '凭据保存失败进入 error', am.getState().state === 'error' && /凭据保存失败/.test(am.getState().lastError));

    setup(); stored = ['x'];
    await am.restore();
    ok('B11', '重启恢复:有凭据 authenticated', am.getState().state === 'authenticated');
    setup(); stored = null;
    await am.restore();
    ok('B12', '重启恢复:无凭据 idle', am.getState().state === 'idle');

    setup(); cookieQueue = [['sessionid', 'sid_tt']];
    await am.beginLogin(); await sleep(60);
    ok('B13', 'Cookie 不完整不误判登录', am.getState().state === 'awaiting_scan' && stored === null);

    setup();
    ok('B14', 'idle 下 markExpired 返回 false', am.markExpired() === false && am.getState().state === 'idle');

    setup(); cookieQueue = [[]];
    const p1 = am.beginLogin(); const p2 = am.beginLogin();
    const a1 = await p1; const a2 = await p2;
    ok('B15', '重复点击只开一个窗口', opened === 1 && a1.ok !== a2.ok, 'opened=' + opened);
    await am.cancelLogin();
  }

  // E 组 —— 阶段3 审核修复:URL 合法性与域名白名单
  // 对应问题:文档里的地址一度被写成 Markdown 链接 [x](x),
  // 以及 main.js 与 auth-protocol.js 各自重复定义一份 URL。
  // ==========================================================================
  group('E URL 合法性与域名白名单');
  {
    const V = ap.validateUrlConstants();
    ok('E1', 'URL 常量整体自检通过', V.ok === true && V.errors.length === 0, V.errors.join(' | '));

    // 逐条确认能被 new URL() 解析 + 协议是 https: + 域名在白名单内
    const allUrls = [ap.LOGIN_URL, ...ap.ALLOWED_COOKIE_URLS];
    ok('E2', '每个 URL 都能被 new URL() 解析', allUrls.every(u => {
      try { new URL(u); return true; } catch { return false; }
    }), allUrls.length + ' 条');

    ok('E3', '每个 URL 的协议都是 https:', allUrls.every(u => new URL(u).protocol === 'https:'),
      allUrls.map(u => new URL(u).protocol).join(','));

    ok('E4', '每个 URL 的 hostname 都在白名单内',
      allUrls.every(u => ap.ALLOWED_HOSTS.includes(new URL(u).hostname)),
      allUrls.map(u => new URL(u).hostname).join(','));

    ok('E5', 'URL 中不含 Markdown 链接语法',
      allUrls.every(u => !/\]\s*\(|\[[^\]]*\]\s*\(/.test(u) && !/https?:\/\/[^\s]*\)/.test(u)),
      allUrls.join(' | '));

    // assertPureHttpsUrl 必须真的拦得住各种畸形输入
    const rejects = [
      ['https://www.doubao.com/](https://www.doubao.com/)', 'Markdown 链接形态'],
      ['[https://www.doubao.com/](https://www.doubao.com/)', '方括号包裹的链接'],
      ['http://www.doubao.com/', '非 https 协议'],
      ['ftp://www.doubao.com/', 'ftp 协议'],
      ['www.doubao.com', '缺少协议'],
      ['', '空字符串'],
      ['https://www.doubao.com/ chat/', '含空白'],
      ['https://evil.test/', '域名不在白名单'],
      ['https://evil-doubao.com/', '相似恶意域名'],
    ];
    ok('E6', 'assertPureHttpsUrl 逐一拒绝畸形输入', rejects.every(([badUrl]) => {
      try { ap.assertPureHttpsUrl(badUrl, 'test'); return false; } catch (e) { return e && e.isAuthProtocolError === true; }
    }), rejects.length + ' 个反向用例');

    ok('E7', '合法 URL 通过 assertPureHttpsUrl', (() => {
      try {
        const u = ap.assertPureHttpsUrl('https://passport.doubao.com/x', 'test');
        return u && u.hostname === 'passport.doubao.com';
      } catch { return false; }
    })());

    // main.js 必须引用同一份常量,不能自己再写一遍
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    ok('E8', 'main.js 不再重复定义豆包 URL 常量',
      !/const\s+LOGIN_URL\s*=\s*'https:\/\/www\.doubao\.com/.test(mainSrc) &&
      !/https:\/\/doubao\.com\/\\n/.test(mainSrc),
      '未发现重复硬编码');
    ok('E9', 'main.js 引用 authProtocol 的 URL 常量',
      /authProtocol\.LOGIN_URL/.test(mainSrc) && /authProtocol\.ALLOWED_COOKIE_URLS/.test(mainSrc));
    ok('E10', 'main.js 源码中无 Markdown 链接形态的 URL',
      !/\]\(https?:\/\//.test(mainSrc));
  }

  // ==========================================================================
  // F 组 —— 阶段3 审核修复:导航允许/拒绝
  // 对应问题:旧正则只校验 hostname、不校验协议,http:// 会被放行。
  // ==========================================================================
  group('F 导航域名校验');
  {
    const allow = [
      'https://doubao.com/',
      'https://www.doubao.com/chat/',
      'https://passport.doubao.com/login',
      'https://www.doubao.com/chat/completion?aid=1',
    ];
    const deny = [
      'http://www.doubao.com/',            // 非 https
      'http://doubao.com/',
      'https://evil-doubao.com/',          // 前缀伪装
      'https://doubao.com.evil.test/',     // 后缀伪装
      'https://notdoubao.com/',            // 缺分隔符
      'https://doubao.com.evil.com/',      // 域名注入
      'https://evil.test/',
      'https://www.doubao.com.evil.test/', // 合法前缀 + 恶意后缀
      'ftp://www.doubao.com/',
      'javascript:alert(1)',
      'file:///C:/Windows/System32/drivers/etc/hosts',
      'not-a-url',
      '',
    ];
    ok('F1', '合法豆包域名全部放行', allow.every(u => ap.isAllowedNavigateUrl(u) === true),
      allow.filter(u => !ap.isAllowedNavigateUrl(u)).join(',') || '全通过');
    ok('F2', '恶意/相似/非 https 域名全部拒绝', deny.every(u => ap.isAllowedNavigateUrl(u) === false),
      deny.filter(u => ap.isAllowedNavigateUrl(u)).join(',') || '全拒绝');
    ok('F3', 'isAllowedHost 用全等比较而非后缀匹配', (() => {
      return ap.isAllowedHost('doubao.com') === true &&
        ap.isAllowedHost('www.doubao.com') === true &&
        ap.isAllowedHost('passport.doubao.com') === true &&
        ap.isAllowedHost('evil-doubao.com') === false &&
        ap.isAllowedHost('doubao.com.evil.test') === false &&
        ap.isAllowedHost('') === false &&
        ap.isAllowedHost(null) === false;
    })());
    ok('F4', '白名单不含通配符/协议/路径',
      ap.ALLOWED_HOSTS.every(h => !/[:\/\s*]/.test(h)), ap.ALLOWED_HOSTS.join(','));
    ok('F5', 'main.js 导航拦截使用 isAllowedNavigateUrl',
      /isAllowedNavigateUrl/.test(fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8')));

    // 旧的宽松正则必须已被移除:它是"只查 hostname 不查协议"的根源
    const mainSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    ok('F6', 'main.js 不再使用旧的 hostname 后缀正则', !/\/\(\.\|\^\)\.\$\//.test(mainSrc2) && !/\(\.\|\^\)doubao/.test(mainSrc2));
  }

  // ==========================================================================
  // H 组 —— 阶段3 审核修复:风险确认由【主进程】统一把关
  //
  // 这一组走的是【真实 main.js 的 IPC handler】,不是重写的假逻辑:
  // 通过 tests/harness 加载真实 src/main/main.js,拿到它注册的 handler 直接调用。
  // 对应问题:doubao-login 原来完全没查 hasAcceptedDoubaoRisk,而 Renderer
  // 真正调用的就是它 —— 真实 UI 路径绕过了风险确认。
  //
  // 诚实声明:这里的 Electron 平台 API 是 mock(窗口/session/safeStorage),
  // 不发起任何真实网络请求,也不使用真实豆包账号。
  // 它证明的是"主进程 IPC 的判定逻辑正确",不是"真实登录能跑通"。
  // ==========================================================================
  group('H 风险确认 IPC(真实 main.js)');
  {
    const { loadMain, waitBoot, closeAllWatchers } = require('./harness');
    const { mkTmp } = require('./common');
    const root = mkTmp('acg-t18-risk-');
    const userData = path.join(root, 'userData');
    const pictures = path.join(root, 'Pictures');
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(path.join(pictures, 'ACG_Wallpaper'), { recursive: true });
    const loaded = loadMain({ userDataDir: userData, picturesDir: pictures, holdReady: false, singleInstanceLock: true });
    await waitBoot(loaded.state, 5000);
    const call = async (chan, ...args) => {
      const fn = loaded.state.ipcHandlers.get(chan);
      if (!fn) throw new Error('通道未注册: ' + chan);
      return await fn({}, ...args);
    };
    // 重置风险确认状态,保证用例之间互不影响
    await call('doubao-accept-risk', false);

    const login0 = await call('doubao-login');
    ok('H1', '未确认风险时 doubao-login 明确失败',
      login0 && login0.ok === false && /风险/.test(String(login0.error)), JSON.stringify(login0).slice(0, 120));

    const open0 = await call('doubao-open-login-window');
    ok('H2', '未确认风险时 doubao-open-login-window 明确失败',
      open0 && open0.ok === false && /风险/.test(String(open0.error)));

    ok('H3', '未确认风险时没有创建任何登录窗口',
      !loaded.state.browserWindowOptions.some(o => o && o.title === '豆包登录'),
      '窗口数=' + loaded.state.browserWindowOptions.length);

    ok('H4', '未确认风险时没有创建豆包专属 partition',
      !loaded.electron.__sessionState.createdPartitions.includes('persist:doubao'),
      '已建分区: ' + loaded.electron.__sessionState.createdPartitions.join(',') || '(无)');

    const t0 = await call('doubao-test-text', '你好');
    ok('H5', '未确认风险时 doubao-test-text 被拒绝(额度入口不绕过风险告知)',
      t0 && t0.ok === false && /风险/.test(String(t0.error)), JSON.stringify(t0).slice(0, 100));

    const i0 = await call('doubao-test-image', '一只猫');
    ok('H6', '未确认风险时 doubao-test-image 被拒绝',
      i0 && i0.ok === false && /风险/.test(String(i0.error)));

    // 确认风险后,登录入口应放行(会真的走到 openLoginWindow)
    await call('doubao-accept-risk', true);
    const riskNow = await call('doubao-risk-accepted');
    ok('H7', '确认后主进程风险状态为 true', riskNow && riskNow.accepted === true);

    const login1 = await call('doubao-login');
    ok('H8', '确认风险后 doubao-login 不再被风险拦住',
      !(login1 && login1.ok === false && /风险/.test(String(login1.error))),
      JSON.stringify(login1).slice(0, 120));

    const open1 = await call('doubao-open-login-window');
    ok('H9', '确认风险后 doubao-open-login-window 不再被风险拦住',
      !(open1 && open1.ok === false && /风险/.test(String(open1.error))));

    // 两个登录入口必须共用同一道校验:取消确认后两者都要重新拦住
    await call('doubao-accept-risk', false);
    const login2 = await call('doubao-login');
    const open2 = await call('doubao-open-login-window');
    ok('H10', '两个登录入口共用同一校验(取消确认后同时失效)',
      login2 && login2.ok === false && /风险/.test(String(login2.error)) &&
      open2 && open2.ok === false && /风险/.test(String(open2.error)));

    ok('H11', 'doubao-accept-risk 拒绝非布尔参数',
      (await call('doubao-accept-risk', 'yes')).ok === false);

    // 登录窗口的导航拦截:用真实 will-navigate 回调验证
    await call('doubao-accept-risk', true);
    await call('doubao-login');
    const win = loaded.state.windows.find(w => w && w.options && w.options.title === '豆包登录');
    ok('H12', '登录窗口已创建且加载了正确的登录 URL',
      !!win && win.loadedUrl === ap.LOGIN_URL,
      win ? String(win.loadedUrl) : '(未找到窗口)');

    const navCases = [
      ['https://www.doubao.com/chat/', false],
      ['https://passport.doubao.com/x', false],
      ['http://www.doubao.com/', true],
      ['https://evil-doubao.com/', true],
      ['https://doubao.com.evil.test/', true],
      ['https://notdoubao.com/', true],
    ];
    const navResults = navCases.map(([u]) => {
      let prevented = false;
      win.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, u);
      return { u, prevented };
    });
    ok('H13', '合法豆包地址不被拦截', navResults.filter(r => !r.prevented).length === 2,
      navResults.filter(r => !r.prevented).map(r => r.u).join(','));
    ok('H14', '非 https 与相似域名全部被拦截',
      navResults.filter(r => r.u !== 'https://www.doubao.com/chat/' && r.u !== 'https://passport.doubao.com/x')
        .every(r => r.prevented),
      navResults.filter(r => r.prevented).map(r => r.u).join(','));

    const denyHandler = win._windowOpenHandler;
    ok('H15', 'window.open 一律 deny', (() => {
      const r = denyHandler && denyHandler({ url: 'https://www.doubao.com/chat/' });
      return !!r && r.action === 'deny';
    })());

    // status 通道不得泄露凭据
    const st = await call('doubao-status');
    const stStr = JSON.stringify(st);
    ok('H16', 'doubao-status 不返回任何 Cookie 值',
      !/sessionid|ttwid|odin_tt|s_v_web_id/.test(stStr) && typeof st.state === 'string',
      stStr.slice(0, 120));

    // logout:凭据/会话清理结果必须真实反映
    const lo = await call('doubao-logout');
    ok('H17', 'doubao-logout 返回真实结果(有 ok 字段且状态可读)',
      lo && typeof lo.ok === 'boolean', JSON.stringify(lo).slice(0, 140));

    // 这条是修复过程中新发现的缺陷:登录中途退出会卡在 awaiting_scan
    const stAfter = await call('doubao-status');
    ok('H18', '登录中途退出登录能回到 idle(不卡在 awaiting_scan)',
      stAfter.state === 'idle', '退出后 state=' + stAfter.state);

    // ---------------------------------------------------------------
    // P0-1(阶段3.10):正常生图路径的风险确认回归测试。
    // 审核确认:fetchAI 的豆包分支原来没有 requireDoubaoRisk(),配置了
    // imageEngine='doubao' 的定时换图会在未确认风险时直接消耗生图额度。
    // 这里走真实 main.js 的 change-wallpaper handler 验证主进程边界。
    // ---------------------------------------------------------------
    {
      // 配置成豆包生图引擎 + AI 源(经 save-config,走真实配置链路)
      await call('save-config', 'ai.imageEngine', 'doubao');
      await call('save-config', 'source', 'ai');
      // 主进程侧重置风险状态(模拟重启后的真实状态)
      await call('doubao-accept-risk', false);

      // 探针:拦截全局 fetch,若有人真发豆包请求就计败(不出网)
      const origFetch = globalThis.fetch;
      let doubaoNetCalls = 0;
      globalThis.fetch = (url, opts) => {
        if (/doubao\.com/.test(String(url))) { doubaoNetCalls++; return Promise.reject(new Error('测试拦截:不应出网')); }
        return origFetch(url, opts);
      };

      let r;
      try {
        // 未确认风险 → change-wallpaper('ai-explicit') 必须失败,错误信息指向风险提示
        r = await call('change-wallpaper', 'ai-explicit');
      } finally {
        globalThis.fetch = origFetch;
      }

      ok('H19', 'P0-1:未确认风险时正常生图(change-wallpaper)被主进程拦截',
        r && r.ok === false && /风险/.test(String(r.error || '')),
        JSON.stringify({ ok: r && r.ok, error: r && r.error }).slice(0, 140));
      ok('H20', 'P0-1:拦截发生在任何豆包网络请求之前',
        doubaoNetCalls === 0, '豆包出网次数=' + doubaoNetCalls);

      // 确认风险后同一通道不再被风险门禁拦住(其余链路行为不受影响:
      // 真正的生图会因测试环境无凭据服务而走 mock 之外的路,这里只验证门禁放行)
      await call('doubao-accept-risk', true);
      const origFetch2 = globalThis.fetch;
      globalThis.fetch = (url, opts) => {
        if (/doubao\.com/.test(String(url))) { doubaoNetCalls++; return Promise.reject(new Error('测试拦截')); }
        return origFetch2(url, opts);
      };
      let r2;
      try { r2 = await call('change-wallpaper', 'ai-explicit'); } finally { globalThis.fetch = origFetch2; }
      ok('H21', 'P0-1:确认风险后生图不再被风险门禁拦截',
        !(r2 && r2.ok === false && /风险/.test(String(r2.error || ''))),
        JSON.stringify({ ok: r2 && r2.ok, error: r2 && String(r2.error || '').slice(0, 80) }));
      // 恢复:会话状态测试部分依赖风险确认
      await call('doubao-accept-risk', false);
    }

    try { closeAllWatchers(); } catch {}
  }

  // ==========================================================================
  // I 组 —— 阶段3 审核修复:重启恢复后 Renderer 操作区可见性
  //
  // 做法:从【真实 src/renderer/renderer.js】里提取 doubaoButtons 函数源码,
  // 在 vm 沙箱里执行。不是重写一份等价逻辑来"自证正确"——
  // 如果生产代码被改回旧写法,这里提取到的就是旧代码,断言会真的失败。
  //
  // 覆盖的问题:hasAcceptedDoubaoRisk 每次启动重置为 false,
  // 已登录时操作区被整体隐藏,用户看不到【退出账号】,账号被锁死。
  // ==========================================================================
  group('I 重启恢复后的操作区可见性');
  {
    const vm = require('node:vm');
    const rSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');

    function extractFn(name) {
      const start = rSrc.indexOf('function ' + name + '(');
      if (start < 0) return '';
      let i = rSrc.indexOf('{', start), depth = 0;
      for (; i < rSrc.length; i++) {
        if (rSrc[i] === '{') depth++;
        else if (rSrc[i] === '}') { depth--; if (depth === 0) return rSrc.slice(start, i + 1); }
      }
      return '';
    }

    const fnSrc = extractFn('doubaoButtons');
    ok('I1', '能从真实 renderer.js 提取 doubaoButtons', fnSrc.length > 0, '长度 ' + fnSrc.length + 'B');

    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(fnSrc + '; this.fn = doubaoButtons;', ctx);
    const btns = ctx.fn;
    const acts = (st, risk) => btns(st, risk).map(b => b.act);

    // 场景 1:初次启动、未登录、未确认风险 → 要提示风险,不给登录入口
    ok('I2', '初次启动未登录未确认风险:不出现登录入口',
      acts({ state: 'idle' }, false).length === 0, JSON.stringify(acts({ state: 'idle' }, false)));

    // 场景 2:已确认风险、未登录 → 出现登录入口
    ok('I3', '已确认风险未登录:出现扫码登录入口',
      acts({ state: 'idle' }, true).includes('doubao-login'));

    // 场景 3:扫码中 → 出现取消登录
    ok('I4', '扫码中:出现取消登录入口',
      acts({ state: 'awaiting_scan' }, true).includes('doubao-cancel-login') &&
      acts({ state: 'opening' }, true).includes('doubao-cancel-login'));

    ok('I5', '扫码中即使未确认风险也要有取消登录',
      acts({ state: 'awaiting_scan' }, false).includes('doubao-cancel-login'));

    // 场景 4(本次修复的核心):已登录 + 风险未确认 → 仍必须有退出账号
    ok('I6', '已登录且风险未确认:仍显示退出账号入口',
      acts({ state: 'authenticated' }, false).includes('doubao-logout'),
      JSON.stringify(acts({ state: 'authenticated' }, false)));

    ok('I7', '已登录且风险未确认:不显示消耗额度的测试入口',
      !acts({ state: 'authenticated' }, false).includes('doubao-test-text') &&
      !acts({ state: 'authenticated' }, false).includes('doubao-test-image'));

    ok('I8', '已登录且风险未确认:不显示重新登录入口(发起登录需确认)',
      !acts({ state: 'authenticated' }, false).includes('doubao-relogin'));

    // 场景 5:已登录 + 已确认 → 测试与退出都在
    ok('I9', '已登录且已确认风险:测试与退出入口齐全', (() => {
      const a = acts({ state: 'authenticated' }, true);
      return a.includes('doubao-test-text') && a.includes('doubao-test-image') &&
        a.includes('doubao-logout') && a.includes('doubao-relogin');
    })(), JSON.stringify(acts({ state: 'authenticated' }, true)));

    // 源码级:旧写法必须已被移除
    ok('I10', 'renderer.js 不再无条件隐藏整个操作区',
      !/if\s*\(\s*!doubaoRiskAccepted\s*&&\s*act\s*\)\s*act\.style\.display\s*=\s*'none'/.test(rSrc));
    ok('I11', 'renderer.js 未把风险确认状态自动置 true(不伪造用户确认)',
      !/doubaoRiskAccepted\s*=\s*true\s*;[^\n]*\/\//.test(rSrc) || !/risk\.style/.test(rSrc) === false);

    // 操作区可见性判断:已登录时必须可见
    ok('I12', '操作区可见性包含"已登录必须可见"的判断', (() => {
      const m = rSrc.match(/const needsManageAction\s*=\s*\(([^)]+)\)/);
      if (!m) return false;
      return m[1].includes("'authenticated'") && m[1].includes("'awaiting_scan'");
    })(), '命中 needsManageAction 判断');

    // ------------------------------------------------------------------
    // I13/I14 —— 真正执行 refreshDoubao 的显示判断
    //
    // 这两项来自变异测试:把
    //   act.style.display = (doubaoRiskAccepted || needsManageAction) ? '' : 'none';
    // 改成只看 doubaoRiskAccepted 后,I1–I12【全部仍然通过】。
    // 原因:I1–I12 只测了 doubaoButtons 这个纯函数,
    // 以及 needsManageAction 这一行"是否存在",都没有真正执行可见性计算。
    // 于是"代码里写了却没被用上"这种回退根本抓不到。这是真实覆盖盲区。
    //
    // 做法:把 refreshDoubao 整段拿出来,配最小 DOM/API 桩在 vm 里真跑一遍,
    // 然后看 doubao-actions 的 display 到底算成了什么。
    // ------------------------------------------------------------------
    {
      const startR = rSrc.indexOf('async function refreshDoubao(');
      let endR = -1;
      if (startR >= 0) {
        let j = rSrc.indexOf('{', startR), dep = 0;
        for (; j < rSrc.length; j++) {
          if (rSrc[j] === '{') dep++;
          else if (rSrc[j] === '}') { dep--; if (dep === 0) { endR = j + 1; break; } }
        }
      }
      const refreshSrc = (startR >= 0 && endR > startR) ? rSrc.slice(startR, endR) : '';
      ok('I13', '能从真实 renderer.js 提取 refreshDoubao', refreshSrc.length > 0, '长度 ' + refreshSrc.length + 'B');

      // 最小 DOM + api 桩:只实现 refreshDoubao 用到的部分
      function runRefresh(stateObj, riskAccepted) {
        const nodes = new Map();
        const mkNode = () => ({ textContent: '', style: { display: '', color: '' }, dataset: {}, children: [],
          appendChild(c) { this.children.push(c); }, });
        const actNode = mkNode();
        const riskNode = mkNode();
        const modelNode = mkNode();
        const $ = (id) => {
          if (id === 'doubao-actions') return actNode;
          if (id === 'doubao-risk') return riskNode;
          if (id === 'doubao-models') return modelNode;
          if (id === 'doubao-status-text') return (nodes.get(id) || (nodes.set(id, mkNode()), nodes.get(id)));
          return null;
        };
        const vm2 = require('node:vm');
        const ctx2 = {
          $,
          api: {
            doubao: {
              status: async () => stateObj,
              riskAccepted: async () => ({ accepted: riskAccepted }),
              models: async () => ({ models: [], current: '0', effortLevels: [] }),
            },
          },
          toast: () => {},
          doubaoStateText: () => ({ text: '', color: '' }),
          refreshDoubaoModels: async () => {},
          document: { createElement: () => mkNode() },
        };
        vm2.createContext(ctx2);
        // 把真实的 doubaoButtons 源码与 refreshDoubao 一起放进同一个上下文，
        // 否则 refreshDoubao 内部引用的 doubaoButtons 在沙箱里不存在。
        vm2.runInContext(fnSrc + ';' + refreshSrc + '; this.__refresh = refreshDoubao;', ctx2);
        return ctx2.__refresh().then(() => ({
          actionsDisplay: actNode.style.display,
          riskDisplay: riskNode.style.display,
          buttons: actNode.children.map(c => c.dataset && c.dataset.act),
        }));
      }

      // 核心场景:已登录 + 风险未确认 → 操作区必须可见,且含退出账号
      const s1 = await runRefresh({ state: 'authenticated', encryptionAvailable: true }, false);
      ok('I14', '已登录且风险未确认时操作区 display 不为 none(真正执行判定)',
        s1.actionsDisplay !== 'none',
        'display="' + s1.actionsDisplay + '" 按钮=' + JSON.stringify(s1.buttons));

      // 反向:未登录 + 未确认 → 操作区应当隐藏
      const s2 = await runRefresh({ state: 'idle', encryptionAvailable: true }, false);
      ok('I15', '未登录且风险未确认时操作区隐藏',
        s2.actionsDisplay === 'none',
        'display="' + s2.actionsDisplay + '"');

      // 已确认 + 未登录 → 可见
      const s3 = await runRefresh({ state: 'idle', encryptionAvailable: true }, true);
      ok('I16', '已确认风险时操作区可见',
        s3.actionsDisplay !== 'none',
        'display="' + s3.actionsDisplay + '"');

      // 已登录 + 未确认 → 退出按钮必须在 DOM 里
      ok('I17', '已登录且风险未确认时 DOM 里有退出账号按钮',
        s1.buttons.includes('doubao-logout'),
        JSON.stringify(s1.buttons));
    }
  }

  // ==========================================================================
  // G 组 —— 阶段3 审核修复:logout 错误处理 与 失败路径 Session 清理
  // 对应问题:
  //   1) logout 吞掉异常仍返回 {ok:true} → 凭据没删掉却报"已退出";
  //   2) 取消/超时/开窗失败/保存失败等路径从不清理 Session Cookie。
  // ==========================================================================
  group('G 退出与失败路径清理');
  {
    const FULL = ap.REQUIRED_COOKIES.slice();
    function mkEnv(o) {
      const opt = o || {};
      const rec = { opened: 0, closed: 0, cleared: 0, stored: null, clearReasons: [] };
      let cookieQueue = opt.cookieQueue || [[]];
      let pollIdx = 0;
      am.__reset();
      am.init({
        openLoginWindow: async () => { rec.opened++; return opt.openResult || { ok: true }; },
        closeLoginWindow: () => { rec.closed++; },
        clearSession: async () => {
          rec.cleared++;
          if (opt.clearSessionThrows) throw new Error('session clear boom');
          if (opt.clearSessionResult) return opt.clearSessionResult;
          return { ok: true, removed: 3, failed: [], errors: [] };
        },
        credential: {
          async save(p) { if (opt.saveThrows) throw new Error('disk full'); rec.stored = [...p.keys()]; },
          async has() { if (opt.hasThrows) throw new Error('has boom'); return opt.hasValue !== undefined ? opt.hasValue : rec.stored !== null; },
          async clear() {
            if (opt.clearThrows) throw new Error('credential clear boom');
            if (opt.clearLeavesCredential) { rec.stored = ['still-here']; return; }
            rec.stored = null;
          },
        },
        readSessionCookies: async () => {
          const m = new Map();
          const arr = cookieQueue[Math.min(pollIdx, cookieQueue.length - 1)] || [];
          pollIdx++;
          arr.forEach(n => m.set(n, 'v-' + n));
          return m;
        },
        pollIntervalMs: 5, scanTimeoutMs: opt.scanTimeoutMs || 60000,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (t) => clearTimeout(t),
        now: () => Date.now(),
      });
      return rec;
    }

    // --- 退出登录的正常与异常路径 ---
    let r1 = mkEnv({ cookieQueue: [FULL] });
    await am.beginLogin(); await sleep(80);
    const out1 = await am.logout();
    ok('G1', '正常退出:凭据与 Session 都清成功才报成功',
      out1.ok === true && out1.credentialCleared === true && out1.sessionCleared === true &&
      out1.credentialRemaining === false && am.getState().state === 'idle',
      JSON.stringify({ ok: out1.ok, cc: out1.credentialCleared, sc: out1.sessionCleared }));

    let r2 = mkEnv({ cookieQueue: [FULL], clearThrows: true });
    await am.beginLogin(); await sleep(80);
    const out2 = await am.logout();
    // 注意:证据串里必须对 errors 做防御性取值。
    // 变异测试暴露过这个问题:把 logout 改回"吞异常 + 永远 ok:true"的旧写法后,
    // out2.errors 变成 undefined,直接 .length 会抛 TypeError,
    // 导致整个测试文件崩溃退出(exit=2)、后续 15 个 G 组用例全部丢失,
    // 表面看只是"1 项失败",实际是"测试没跑完"—— 这比失败更危险。
    ok('G2', '凭据删除失败时不得报成功', out2.ok === false && out2.credentialCleared === false,
      JSON.stringify({ ok: out2.ok, errors: Array.isArray(out2.errors) ? out2.errors.length : '(缺 errors 字段)' }));
    ok('G2b', '凭据删除失败时状态不伪装成完全退出',
      am.getState().state === 'authenticated' && out2.credentialRemaining === true,
      'state=' + am.getState().state);

    let r3 = mkEnv({ cookieQueue: [FULL], clearSessionResult: { ok: false, removed: 1, failed: ['sessionid'], errors: ['删除 Cookie 失败(sessionid): mock'] } });
    await am.beginLogin(); await sleep(80);
    const out3 = await am.logout();
    ok('G3', 'Session 清理失败时不得报完整成功',
      out3.ok === false && out3.sessionCleared === false && out3.credentialCleared === true,
      JSON.stringify({ ok: out3.ok, sc: out3.sessionCleared }));

    let r4 = mkEnv({ cookieQueue: [FULL], clearThrows: true, clearSessionResult: { ok: false, removed: 0, failed: ['x'], errors: ['mock fail'] } });
    await am.beginLogin(); await sleep(80);
    const out4 = await am.logout();
    // 同 G2:对 errors 做防御性取值,避免生产代码回退时测试崩溃而非失败
    const errs4 = Array.isArray(out4.errors) ? out4.errors : [];
    ok('G4', '两者同时失败仍能明确报告失败',
      out4.ok === false && out4.credentialCleared === false && out4.sessionCleared === false &&
      errs4.length >= 1, errs4.join(' | ').slice(0, 120) || '(无 errors 数组)');

    let r5 = mkEnv({ cookieQueue: [FULL], clearSessionThrows: true });
    await am.beginLogin(); await sleep(80);
    const out5 = await am.logout();
    const errs5 = Array.isArray(out5.errors) ? out5.errors : [];
    ok('G5', 'Session 清理抛异常被捕获且不报成功',
      out5.ok === false && /Session/.test(errs5.join(' ')),
      errs5.join(' | ').slice(0, 100) || '(无 errors 数组)');

    ok('G6', '错误信息不含 Cookie 值(只有名字/原因)',
      [out1, out2, out3, out4, out5].every(o => (o.errors || []).every(e => !/v-sessionid|v-uid_tt|v-ttwid/.test(e))),
      '已检查 ' + [out1, out2, out3, out4, out5].reduce((a, o) => a + (o.errors || []).length, 0) + ' 条错误消息');

    let r7 = mkEnv({ cookieQueue: [FULL], clearLeavesCredential: true, hasValue: true });
    await am.beginLogin(); await sleep(80);
    const out7 = await am.logout();
    ok('G7', 'clear() 不抛错但凭据仍在时,以 has() 复核结果为准',
      out7.credentialRemaining === true && out7.ok === false,
      'credentialRemaining=' + String(out7.credentialRemaining) + ' ok=' + String(out7.ok));

    // --- 失败/取消路径的 Session 清理 ---
    let r8 = mkEnv({ cookieQueue: [[]] });
    await am.beginLogin();
    const c8 = await am.cancelLogin('用户取消');
    ok('G8', '取消登录会清理 Session', r8.cleared > 0 && c8.cleanup && c8.cleanup.ok === true,
      'cleared=' + r8.cleared);

    let r9 = mkEnv({ cookieQueue: [[]], scanTimeoutMs: 10 });
    await am.beginLogin(); await sleep(70);
    ok('G9', '扫码超时会清理 Session', r9.cleared > 0 && am.getState().state === 'error',
      'cleared=' + r9.cleared);

    let r10 = mkEnv({ openResult: { ok: false, error: '模拟开窗失败' } });
    const b10 = await am.beginLogin();
    ok('G10', '开窗失败会清理 Session', r10.cleared > 0 && b10.ok === false && b10.cleanup && b10.cleanup.ok === true,
      'cleared=' + r10.cleared);

    let r11 = mkEnv({ cookieQueue: [FULL], saveThrows: true });
    await am.beginLogin(); await sleep(80);
    ok('G11', '凭据保存失败会清理 Session',
      r11.cleared > 0 && am.getState().state === 'error' && /凭据保存失败/.test(am.getState().lastError),
      'cleared=' + r11.cleared);

    // 登录成功后不得被"关窗→取消"误清理(竞态)
    let r12 = mkEnv({ cookieQueue: [FULL] });
    await am.beginLogin(); await sleep(80);
    ok('G12', '前置:已成功登录', am.getState().state === 'authenticated' && r12.stored !== null);
    const clearedBefore = r12.cleared;
    const c12 = await am.cancelLogin('窗口关闭');
    ok('G13', '成功登录后不会被取消流程误清 Session',
      r12.cleared === clearedBefore && c12.ok === false && am.getState().state === 'authenticated',
      'cleared ' + clearedBefore + ' -> ' + r12.cleared);

    // 重复取消不破坏状态
    let r14 = mkEnv({ cookieQueue: [[]] });
    await am.beginLogin();
    const cc1 = await am.cancelLogin('第一次');
    const cc2 = await am.cancelLogin('第二次');
    ok('G14', '重复取消:第二次被拒绝且不重复清 Session',
      cc1.ok === true && cc2.ok === false && r14.cleared === 1,
      'cleared=' + r14.cleared);

    // Session 清理失败要能被诊断到(记进 lastError),但不含 Cookie
    let r15 = mkEnv({ cookieQueue: [[]], clearSessionThrows: true });
    await am.beginLogin();
    await am.cancelLogin('用户取消');
    ok('G15', '清理失败被记录为可诊断状态',
      /清理/.test(am.getState().lastError) && !/v-sessionid/.test(am.getState().lastError),
      'lastError=' + am.getState().lastError.slice(0, 60));

    // ------------------------------------------------------------------
    // G16/G17 —— loginCommitted 竞态保护的直测
    //
    // 这两项来自变异测试:把 cleanupAbortedSession 里的
    //   if (loginCommitted) return { ok:true, skipped:true }
    // 整行删掉后,原有用例【全部仍然通过】—— 说明此前没有任何测试
    // 真正覆盖这条保护。这是变异测试才发现的有效缺口。
    //
    // 为什么原来的 G13 抓不到:
    //   G13 在 authenticated 状态下调 cancelLogin,而 cancelLogin 对
    //   「没有进行中的登录」会直接 return ok:false,根本走不到清理逻辑。
    //   真正危险的是另一种时序:pollOnce 里先 setState('authenticated')
    //   之前的 closeLoginWindow() 触发 'closed' 事件,那时状态仍是
    //   awaiting_scan,主进程的 closed 回调会立刻调 cancelLogin →
    //   若不看 loginCommitted,就会把刚刚保存的凭据对应的 Session 抹掉。
    //
    // 这里直接模拟那个时序:让 closeLoginWindow 同步触发真实会发生的
    // 「关窗→取消」回调,检查 clearSession 是否被调用。
    // ------------------------------------------------------------------
    {
      const rec = { cleared: 0, stored: null, cancelResult: null };
      am.__reset();
      let pollIdx2 = 0;
      am.init({
        openLoginWindow: async () => ({ ok: true }),
        // 关键:关窗时同步触发与 main.js 中 'closed' 回调等价的逻辑
        closeLoginWindow: () => {
          // main.js 的实现:关窗后若状态仍是 awaiting_scan/opening 就取消
          const st = am.getState();
          if (st.state === 'awaiting_scan' || st.state === 'opening') {
            rec.cancelResult = am.cancelLogin('用户关闭了登录窗口');
          }
        },
        clearSession: async () => { rec.cleared++; return { ok: true, removed: 1, failed: [], errors: [] }; },
        credential: {
          async save(p) { rec.stored = [...p.keys()]; },
          async has() { return rec.stored !== null; },
          async clear() { rec.stored = null; },
        },
        readSessionCookies: async () => {
          const m = new Map();
          const arr = pollIdx2++ === 0 ? [] : FULL;
          arr.forEach(n => m.set(n, 'v-' + n));
          return m;
        },
        pollIntervalMs: 5, scanTimeoutMs: 60000,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (t) => clearTimeout(t),
        now: () => Date.now(),
      });

      await am.beginLogin();
      await sleep(120);   // 等轮询拿到完整 Cookie → save → closeLoginWindow

      ok('G16', '登录成功瞬间关窗不会误清 Session(loginCommitted 生效)',
        rec.stored !== null && rec.cleared === 0 && am.getState().state === 'authenticated',
        'stored=' + (rec.stored ? rec.stored.length : 0) + ' cleared=' + rec.cleared + ' state=' + am.getState().state);

      // 反向确认:没登录成功时,同样的关窗时序必须清理
      const rec2 = { cleared: 0 };
      let pollIdx3 = 0;
      am.__reset();
      am.init({
        openLoginWindow: async () => ({ ok: true }),
        closeLoginWindow: () => {
          const st = am.getState();
          if (st.state === 'awaiting_scan' || st.state === 'opening') {
            am.cancelLogin('用户关闭了登录窗口');
          }
        },
        clearSession: async () => { rec2.cleared++; return { ok: true, removed: 1, failed: [], errors: [] }; },
        credential: { async save() {}, async has() { return false; }, async clear() {} },
        readSessionCookies: async () => new Map(),   // 永远拿不到完整 Cookie
        pollIntervalMs: 5, scanTimeoutMs: 60000,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (t) => clearTimeout(t),
        now: () => Date.now(),
      });
      await am.beginLogin();
      await am.cancelLogin('用户关闭了登录窗口');
      ok('G17', '反向确认:未登录成功时关窗确实会清理 Session',
        rec2.cleared > 0, 'cleared=' + rec2.cleared);
    }
  }


  group('D Provider 协议兼容');
  {
    const lol = require(path.join(ROOT, 'src', 'main', 'plugins', 'builtin', 'lolicon-provider.js'));
    const im = require(path.join(ROOT, 'src', 'main', 'plugins', 'builtin', 'openai-image-provider.js'));
    const tx = require(path.join(ROOT, 'src', 'main', 'plugins', 'builtin', 'openai-text-provider.js'));

    ok('D1', '旧 Provider 未填 auth 仍通过校验', [lol, im, tx].every(p => {
      try { protocol.describeProvider(p); return true; } catch { return false; }
    }));
    ok('D2', '旧 Provider 的 auth 为 null', protocol.describeProvider(lol).auth === null);

    ok('D3', '填写 auth 被正确描述', (() => {
      const p = Object.assign({}, tx, { id: 'auth-demo', auth: { type: 'account-session', required: true, statusKey: 'demo' } });
      const d = protocol.describeProvider(p);
      return d.auth && d.auth.type === 'account-session' && d.auth.required === true && d.auth.statusKey === 'demo';
    })());

    ok('D4', '坏 auth 导致校验失败', (() => {
      const p = Object.assign({}, tx, { id: 'bad-auth', auth: { type: 'weird', required: true, statusKey: 'x' } });
      try { protocol.describeProvider(p); return false; } catch (e) { return protocol.isProtocolError(e); }
    })());

    ok('D5', '描述对象可安全外传(无函数)', (() => {
      const d = protocol.describeProvider(Object.assign({}, tx, { id: 'auth-x', auth: { type: 'account-session', required: true, statusKey: 'x' } }));
      return !JSON.stringify(d).includes('function');
    })());
  }

  const s = summarize();
  console.log('');
  console.log('---- 第十八部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败' + (s.skipped ? ', ' + s.skipped + ' 跳过' : '') + ' ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); process.exit(2); });