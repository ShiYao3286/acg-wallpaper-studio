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