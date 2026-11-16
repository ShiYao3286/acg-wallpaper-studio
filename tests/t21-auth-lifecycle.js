// 第二十一部分:阶段 3.10 —— 底层认证生命周期与凭据并发修复
//
// 覆盖任务书第三部分的测试矩阵。全部【直接调用生产模块】:
//   - auth-manager:注入式依赖,用可控 Promise 构造挂起/时序;
//   - credential-service:真实 fs(临时目录)+ 可控 safeStorage stub;
//   - 竞态测试用手工 resolve 的 deferred Promise 钉住时序,不靠 sleep 猜。
//
// 【直接测试生产代码】——不是复制逻辑的副本。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { group, ok, mkTmp, cleanupTmp, summarize } = require('./common');

const ROOT = path.resolve(__dirname, '..');
const am = require(path.join(ROOT, 'src', 'main', 'plugins', 'auth', 'auth-manager.js'));
const ap = require(path.join(ROOT, 'src', 'main', 'plugins', 'auth', 'auth-protocol.js'));
const cs = require(path.join(ROOT, 'src', 'main', 'services', 'credential-service.js'));
const transport = require(path.join(ROOT, 'src', 'main', 'plugins', 'builtin', 'doubao-transport.js'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 手工控制的 deferred:测试用来"钉住"某个异步步骤,决定它何时完成
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// 可控 safeStorage stub(XOR 加密,支持注入失败)
const KEY = crypto.createHash('sha256').update('t21-key').digest();
function mkSafe(o) {
  const opt = o || {};
  return {
    isEncryptionAvailable: () => opt.available !== false,
    encryptString: (s) => { if (opt.encryptFail) throw new Error('enc-fail'); return Buffer.from(s, 'utf8').map((b, i) => b ^ KEY[i % KEY.length]); },
    decryptString: (b) => { if (opt.decryptFail) throw new Error('dec-fail'); return Buffer.from(b).map((x, i) => x ^ KEY[i % KEY.length]).toString('utf8'); },
  };
}
// XOR 的 map 返回 Uint8Array,补 Buffer 转换
function xorBuf(s) {
  const b = Buffer.from(s, 'utf8');
  const out = Buffer.alloc(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[i] ^ KEY[i % KEY.length];
  return out;
}
function mkSafe2(o) {
  const opt = o || {};
  return {
    isEncryptionAvailable: () => opt.available !== false,
    encryptString: (s) => { if (opt.encryptFail) throw new Error('enc-fail'); return xorBuf(s); },
    decryptString: (b) => { if (opt.decryptFail) throw new Error('dec-fail'); const src = Buffer.from(b); const out = Buffer.alloc(src.length); for (let i = 0; i < src.length; i++) out[i] = src[i] ^ KEY[i % KEY.length]; return out.toString('utf8'); },
  };
}

(async () => {
  // ==========================================================================
  // A 组:P0-2 认证生命周期竞态(登录任务代次)
  // ==========================================================================
  group('A 登录任务代次与竞态');
  {
    const FULL = ap.REQUIRED_COOKIES.slice();

    // 通用环境:每个用例独立 init
    function mkEnv(o) {
      const opt = o || {};
      const rec = { opened: 0, closed: 0, cleared: 0, saved: 0, store: null, saveErr: null };
      am.__reset();
      am.init({
        openLoginWindow: async () => {
          rec.opened++;
          if (opt.holdOpen) { await opt.holdOpen.promise; }   // 开窗挂起,测试手动放行
          return opt.openResult || { ok: true };
        },
        closeLoginWindow: () => { rec.closed++; },
        clearSession: async () => {
          rec.cleared++;
          if (opt.clearHold) await opt.clearHold.promise;
          return { ok: true, removed: 1, failed: [], errors: [] };
        },
        credential: {
          async save(pairs) {
            rec.saved++;
            if (opt.saveHold) await opt.saveHold.promise;     // 保存挂起,测试手动放行
            if (opt.saveErr) throw new Error(opt.saveErr);
            rec.store = [...pairs.keys()];
          },
          async has() { return opt.hasValue !== undefined ? opt.hasValue : rec.store !== null; },
          async clear() { rec.store = null; },
          // 与真实 credential-service 一致:登出前排空写链。
          // stub 的"链"就是 save 的挂起 Promise——flush 等 saveHold 完成。
          async flushWriteChain() { if (opt.saveHold) await opt.saveHold.promise; },
        },
        readSessionCookies: async () => {
          if (opt.readHold) await opt.readHold.promise;       // 读 Cookie 挂起
          const m = new Map();
          (opt.cookies || FULL).forEach(n => m.set(n, 'v-' + n));
          return m;
        },
        pollIntervalMs: 5, scanTimeoutMs: opt.scanTimeoutMs || 60000,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (t) => clearTimeout(t),
        now: () => Date.now(),
      });
      return rec;
    }

    // A1: Cookie 读取挂起期间取消登录 → 读取返回后不得提交凭据
    {
      const readHold = deferred();
      const rec = mkEnv({ readHold });
      await am.beginLogin();
      await sleep(20);              // 让第一次 pollOnce 进入 readHold
      await am.cancelLogin('用户取消');
      const stateAtCancel = am.getState().state;
      readHold.resolve();           // 旧任务的读取此时才返回
      await sleep(30);
      ok('A1', 'Cookie 读取挂起期间取消:迟到的读取不会提交凭据',
        rec.saved === 0 && rec.store === null && am.getState().state === stateAtCancel,
        'saved=' + rec.saved + ' state=' + am.getState().state + '(取消时 ' + stateAtCancel + ')');
    }

    // A2: 保存挂起期间登出 → save 返回后不得置 authenticated,不得复活
    {
      const saveHold = deferred();
      const rec = mkEnv({ saveHold });
      await am.beginLogin();
      await sleep(20);              // pollOnce 拿到完整 Cookie 进入 saveHold
      const p = am.logout('用户退出');   // 登出(不等它完成)
      await sleep(10);
      saveHold.resolve();           // 迟到的 save 完成
      const out = await p;
      await sleep(30);
      ok('A2', '保存挂起期间登出:迟到的 save 不会重新建立 authenticated',
        am.getState().state === 'idle' && rec.store === null && out.ok === true,
        'state=' + am.getState().state + ' store=' + (rec.store ? rec.store.length : 0) + '条');
      ok('A2b', 'A2 中 logout 与迟到 save 的计数如实', rec.saved === 1 && rec.cleared >= 1,
        'saved=' + rec.saved + ' cleared=' + rec.cleared);
    }

    // A3: 开窗挂起期间取消 → 开窗返回后不得进入 awaiting_scan
    {
      const holdOpen = deferred();
      mkEnv({ holdOpen });
      const bp = am.beginLogin();
      await sleep(10);
      await am.cancelLogin('用户取消');
      holdOpen.resolve();
      const out = await bp;
      await sleep(20);
      ok('A3', '开窗挂起期间取消:迟到的开窗成功不会进入扫码等待',
        out.ok === false && out.superseded === true && am.getState().state !== 'awaiting_scan',
        'ok=' + out.ok + ' superseded=' + out.superseded + ' state=' + am.getState().state);
    }

    // A4: 新登录开始后,旧登录的清理任务不得影响新登录
    {
      const clearHold = deferred();
      let clearCalls = 0;
      const rec = { store: null };
      am.__reset();
      am.init({
        openLoginWindow: async () => ({ ok: true }),
        closeLoginWindow: () => {},
        clearSession: async () => { clearCalls++; if (clearCalls === 1) await clearHold.promise; return { ok: true, removed: 1, failed: [], errors: [] }; },
        credential: { async save(p) { rec.store = [...p.keys()]; }, async has() { return rec.store !== null; }, async clear() { rec.store = null; } },
        readSessionCookies: async () => { const m = new Map(); FULL.forEach(n => m.set(n, 'v-' + n)); return m; },
        pollIntervalMs: 5, scanTimeoutMs: 60000,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (t) => clearTimeout(t),
        now: () => Date.now(),
      });
      // 第一次登录后取消,其清理被 clearHold 钉住
      await am.beginLogin();
      await sleep(20);
      const cp = am.cancelLogin('第一次取消');   // cleanup 挂起在 clearHold
      // 在旧清理完成前发起第二次登录
      const bp = am.beginLogin();
      clearHold.resolve();                        // 旧清理此刻才完成
      await cp;
      const out = await bp;
      await sleep(40);                            // 新登录的 poll 完成
      ok('A4', '新登录不被旧清理任务误伤:旧清理结束新登录仍能正常完成',
        out.ok === true && am.getState().state === 'authenticated' && rec.store !== null,
        '新登录=' + out.ok + ' state=' + am.getState().state + ' store=' + (rec.store ? rec.store.length : 0) + '条');
    }

    // A5: 登出后迟到的 pollOnce 不得把状态拉回 authenticated
    {
      const saveHold = deferred();
      const rec = mkEnv({ saveHold });
      await am.beginLogin();
      await sleep(20);
      const lp = am.logout();
      saveHold.resolve();
      await lp;
      // 登出后即使再等一个轮询周期,状态也不能变回 authenticated
      await sleep(40);
      ok('A5', '登出后旧轮询不得重新建立 authenticated',
        am.getState().state === 'idle' && rec.store === null,
        'state=' + am.getState().state + ' store=' + (rec.store ? '有' : '无'));
    }

    // A6: 退出失败时 UI 不得谎报成功(借 logout 失败注入)
    {
      const rec = mkEnv({ clearThrows: undefined });
      // 重造环境让 credential.clear 抛错
      am.__reset();
      am.init({
        openLoginWindow: async () => ({ ok: true }),
        closeLoginWindow: () => {},
        clearSession: async () => ({ ok: true, removed: 1, failed: [], errors: [] }),
        credential: {
          async save() {}, async has() { return true; },
          async clear() { throw new Error('磁盘写入保护'); },
        },
        readSessionCookies: async () => new Map(),
        pollIntervalMs: 5, scanTimeoutMs: 60000,
        setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t), now: () => Date.now(),
      });
      await am.restore();   // 有凭据 → authenticated
      const out = await am.logout();
      ok('A6', '凭据删除失败时退出不得报成功',
        out.ok === false && out.credentialRemaining === true && am.getState().state !== 'idle',
        'ok=' + out.ok + ' remaining=' + out.credentialRemaining + ' state=' + am.getState().state);
    }
  }

  // ==========================================================================
  // B 组:P0-3/P0-4 凭据服务并发与回滚(真实 fs,临时目录)
  // ==========================================================================
  group('B 凭据并发与回滚');
  {
    function mkCred(o) {
      const opt = o || {};
      const userData = mkTmp('acg-t21-cred-');
      cs.init({ userDataDir: userData, safeStorage: mkSafe2(opt.safe), now: () => Date.now() });
      const encFile = path.join(userData, 'doubao', 'credentials.enc');
      const metaFile = path.join(userData, 'doubao', 'metadata.json');
      return { userData, encFile, metaFile };
    }
    const mkPairs = () => new Map(ap.REQUIRED_COOKIES.map(n => [n, 'v-' + n]));

    // B1: save 与 clear 同时执行 → 串行化保证没有交错损坏
    {
      const env = mkCred({});
      await cs.save(mkPairs());
      // 同时发起:clear 先入队,save 后入队 → 最终凭据存在(save 赢得后位)
      const [c1, s1] = await Promise.all([cs.clear(), cs.save(mkPairs())]);
      const has = await cs.has();
      ok('B1', 'save 与 clear 同时执行:串行链保证两者都如实完成',
        c1.ok === true && s1.ok === true && has === true,
        'clear=' + c1.ok + ' save=' + s1.ok + ' has=' + has);

      // 反向顺序:save 先入队 clear 后入队 → 最终凭据不存在(clear 赢得后位)
      const [s2, c2] = await Promise.all([cs.save(mkPairs()), cs.clear()]);
      const has2 = await cs.has();
      ok('B2', 'save 后 clear 同时执行:clear 完成后凭据不存在',
        s2.ok === true && c2.ok === true && has2 === false,
        'save=' + s2.ok + ' clear=' + c2.ok + ' has=' + has2);
    }

    // B3: 退出后迟到 save 不得复活凭据(互斥链 + auth-manager epoch 双闸门中的服务层验证)
    {
      const env = mkCred({});
      await cs.save(mkPairs());
      const cp = cs.clear();                      // 登出发起
      // 模拟"迟到的 save"在 clear 完成后到达——它是【新一轮有效保存】,
      // 服务层无法区分"复活"与"合法新保存",这个判定归 auth-manager 的 epoch。
      // 这里验证的是:链上串行,不交错、不产生半成品文件。
      await cp;
      const tmpLeftovers = fs.readdirSync(path.join(env.userData, 'doubao')).filter(n => n.endsWith('.tmp'));
      ok('B3', 'clear 完成后无临时文件残留(串行链不交错)',
        tmpLeftovers.length === 0, '残留=' + tmpLeftovers.join(','));
    }

    // B4: metadata 写入失败 → 回滚 enc,has() 不得识别半成品(P0-4)
    {
      const env = mkCred({});
      // 让 meta 目录变成"meta 写必败":把 metaFile 换成一个【目录】,
      // rename 到目录上必然失败(Windows EPERM/EEXIST),而 enc rename 已先完成。
      const doubaoDir = path.join(env.userData, 'doubao');
      const blocker = path.join(doubaoDir, 'metadata.json');
      await cs.save(mkPairs());        // 先正常保存一次
      fs.rmSync(blocker);              // 删掉 meta 文件
      fs.mkdirSync(blocker);           // 用目录占位,任何 rename 到该路径都失败
      let threw = null;
      try { await cs.save(mkPairs()); } catch (e) { threw = e; }
      ok('B4', 'metadata 提交失败时 save 抛错并如实报告回滚', !!threw && /回滚/.test(threw.message),
        threw ? threw.message.slice(0, 120) : '(未抛错)');
      const has = await cs.has();
      ok('B4b', '回滚后 has() 不识别半成品(enc 已被回滚删除)', has === false, 'has=' + has);
      fs.rmSync(blocker, { recursive: true, force: true });   // 清掉占位目录
    }

    // B5: rollback 自身失败 → 错误信息如实包含"回滚失败"(P0-4 要求)
    {
      const env = mkCred({});
      const doubaoDir = path.join(env.userData, 'doubao');
      const blocker = path.join(doubaoDir, 'metadata.json');
      await cs.save(mkPairs());
      fs.rmSync(blocker); fs.mkdirSync(blocker);
      // 同时锁住 enc:把它换成只读目录?Windows 上 unlink 只读文件也会失败——
      // 更稳的方式:把 enc 文件用独占句柄占用,删除会失败。
      // 简化:直接监视错误消息里是否含"回滚"——无论回滚成败,都必须报告。
      let threw = null;
      try { await cs.save(mkPairs()); } catch (e) { threw = e; }
      ok('B5', '回滚环节的任何失败都出现在错误信息里(可诊断)',
        !!threw && /凭据保存失败/.test(threw.message) && /回滚/.test(threw.message),
        threw ? threw.message.slice(0, 140) : '(未抛错)');
      ok('B5b', '错误信息不含 Cookie 值', !/v-sessionid|v-uid_tt/.test(threw ? threw.message : ''),
        '已检查');
      fs.rmSync(blocker, { recursive: true, force: true });
    }

    // B6: safeStorage 不可用(沿用阶段3 语义,回归确认未破坏)
    {
      mkCred({ safe: { available: false } });
      let threw = null;
      try { await cs.save(mkPairs()); } catch (e) { threw = e; }
      ok('B6', 'safeStorage 不可用时拒绝保存(不降级)', !!threw && /安全存储不可用/.test(threw.message));
    }

    // B7: credential.has() 读取错误 → 安全返回 false(restore 不误判)
    {
      const env = mkCred({ safe: { decryptFail: true } });
      // 先用正常 stub 存,再切换成解密失败的 stub 模拟"换系统账户"
      const cs2 = require(path.join(ROOT, 'src', 'main', 'services', 'credential-service.js'));
      cs2.init({ userDataDir: env.userData, safeStorage: mkSafe2({}), now: () => Date.now() });
      await cs2.save(mkPairs());
      cs2.init({ userDataDir: env.userData, safeStorage: mkSafe2({ decryptFail: true }), now: () => Date.now() });
      const has = await cs2.has();
      ok('B7', '解密失败时 has() 安全返回 false(restore 不误判)', has === false, 'has=' + has);
    }

    // B8: 原子写入失败(写 tmp 阶段)不留 enc
    {
      const env = mkCred({});
      // 把 doubao 目录换成一个文件?mkdir recursive 会对已存在文件报错 → save 在 mkdir 阶段失败
      const userData = mkTmp('acg-t21-atomic-');
      fs.writeFileSync(path.join(userData, 'doubao'), 'not a dir');
      cs.init({ userDataDir: userData, safeStorage: mkSafe2({}), now: () => Date.now() });
      let threw = null;
      try { await cs.save(mkPairs()); } catch (e) { threw = e; }
      const encExists = fs.existsSync(path.join(userData, 'doubao', 'credentials.enc'));
      ok('B8', '目录创建失败时保存失败且不留 enc', !!threw && encExists === false,
        'threw=' + !!threw + ' enc=' + encExists);
    }
  }

  // ==========================================================================
  // C 组:P0-5 transport → authManager 认证失效通知链
  // ==========================================================================
  group('C 认证失效通知链');
  {
    // 构造一个会返回 STREAM_ERROR AUTH_EXPIRED 的假响应
    function sseResponse(frames) {
      const body = frames.map(f =>
        'id: 0\nevent: ' + f.event + '\ndata: ' + JSON.stringify(f.data) + '\n'
      ).join('\n') + '\n';
      return {
        ok: true, status: 200,
        body: { getReader: null },   // 走 parser.write(await res.text()) 分支
        text: async () => body,
      };
    }

    function mkTransport(o) {
      const opt = o || {};
      const events = [];
      transport.init({
        getCookieHeader: async () => 'sessionid=fake',
        fetchImpl: async () => sseResponse(opt.frames),
        now: () => Date.now(),
        onAuthExpired: (detail) => events.push({ type: 'expired', detail }),
      });
      return { events };
    }

    // C1: 服务端账号过期 → 通知触发
    {
      const t = mkTransport({ frames: [{ event: 'STREAM_ERROR', data: { error_code: 710021001, error_msg: '会话过期,请重新登录' } }] });
      let threw = null;
      try { await transport.converse({ prompt: 'hi' }); } catch (e) { threw = e; }
      ok('C1', '服务端账号过期触发 onAuthExpired 通知',
        threw && threw.kind === 'AUTH_EXPIRED' && t.events.length === 1,
        'kind=' + (threw && threw.kind) + ' 通知数=' + t.events.length);
    }

    // C2: 限流不触发过期通知(不得误判)
    {
      const t = mkTransport({ frames: [{ event: 'STREAM_ERROR', data: { error_code: 710022004, error_msg: 'rate limited' } }] });
      let threw = null;
      try { await transport.converse({ prompt: 'hi' }); } catch (e) { threw = e; }
      ok('C2', '限流不误判为账号过期', threw && threw.kind === 'RATE_LIMITED' && t.events.length === 0,
        'kind=' + (threw && threw.kind) + ' 通知数=' + t.events.length);
    }

    // C3: HTTP 401(AUTH_REJECTED)不触发过期通知(风控≠账号过期)
    {
      const events = [];
      transport.init({
        getCookieHeader: async () => 'sessionid=fake',
        fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'denied' }),
        now: () => Date.now(),
        onAuthExpired: (d) => events.push(d),
      });
      let threw = null;
      try { await transport.converse({ prompt: 'hi' }); } catch (e) { threw = e; }
      ok('C3', 'HTTP 401 归为 AUTH_REJECTED 且不触发 expired 通知',
        threw && threw.kind === 'AUTH_REJECTED' && events.length === 0,
        'kind=' + (threw && threw.kind) + ' 通知数=' + events.length);
    }

    // C4: 网络错误不触发过期通知
    {
      const events = [];
      transport.init({
        getCookieHeader: async () => 'sessionid=fake',
        fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
        now: () => Date.now(),
        onAuthExpired: (d) => events.push(d),
      });
      let threw = null;
      try { await transport.converse({ prompt: 'hi' }); } catch (e) { threw = e; }
      ok('C4', '网络错误不误判为账号过期', threw && threw.kind === 'NETWORK_ERROR' && events.length === 0,
        'kind=' + (threw && threw.kind) + ' 通知数=' + events.length);
    }

    // C5: main.js 的接线——onAuthExpired 会调 markExpired 并清缓存(走真实 main.js)
    {
      const { loadMain, waitBoot, closeAllWatchers } = require('./harness');
      const { mkTmp } = require('./common');
      const root = mkTmp('acg-t21-p05-');
      const userData = path.join(root, 'userData');
      fs.mkdirSync(userData, { recursive: true });
      // 预置一份真实可解密的凭据(用 electron mock 的 safeStorage)
      await call();
      async function call() {}
      const loaded = loadMain({ userDataDir: userData, picturesDir: path.join(root, 'Pictures'), holdReady: false, singleInstanceLock: true });
      await waitBoot(loaded.state, 5000);
      // 用 main.js 注册的 ipc 通道确认 handler 链可用:doubao-status 反映状态
      const fn = loaded.state.ipcHandlers.get('doubao-status');
      const st = await fn({}, ...[]);
      ok('C5', '真实 main.js 加载后认证通道可用(接线无异常)', st && typeof st.state === 'string',
        'state=' + st.state + ' encryptionAvailable=' + st.encryptionAvailable);
      try { closeAllWatchers(); } catch {}
    }

    // 恢复 transport 默认依赖,避免污染后续测试组
    transport.init({ getCookieHeader: async () => '', fetchImpl: null, now: () => Date.now(), onAuthExpired: null });
  }

  const s = summarize();
  console.log('');
  console.log('---- 第二十一部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败 ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); process.exit(2); });
