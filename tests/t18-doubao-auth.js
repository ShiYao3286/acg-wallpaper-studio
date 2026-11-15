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