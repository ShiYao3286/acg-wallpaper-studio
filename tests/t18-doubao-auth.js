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