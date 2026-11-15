// 第十九部分:豆包接入 —— 凭据服务安全边界(阶段 3.3)
//
// 覆盖:加密保存、禁止明文降级、元信息脱敏、解密失败、损坏恢复、幂等清理。
// 全程使用临时目录与假 safeStorage(真做 XOR 变换),不接触用户真实数据。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { group, ok, summarize } = require('./common');

const ROOT = path.resolve(__dirname, '..');
const cs = require(path.join(ROOT, 'src', 'main', 'services', 'credential-service.js'));

const KEY = crypto.createHash('sha256').update('t19-fake-key').digest();
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
  group('C 凭据服务安全边界');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-t18-'));
    try {
      cs.init({ userDataDir: tmp, safeStorage: mkSafe({ available: false }) });
      let t1 = false;
      try { await cs.save(new Map([['sessionid', 'v']])); } catch (e) { t1 = /不可用/.test(e.message); }
      ok('C1', 'safeStorage 不可用时拒绝保存', t1);
      ok('C2', '拒绝后不产生凭据文件', !fs.existsSync(path.join(tmp, 'doubao', 'credentials.enc')));

      cs.init({ userDataDir: tmp, safeStorage: mkSafe() });
      const pairs = new Map([['sessionid', 'SECRET_A'], ['sid_tt', 'SECRET_B'], ['uid_tt', 'SECRET_C']]);
      const rs = await cs.save(pairs);
      ok('C3', '正常保存', rs.ok === true && rs.cookieCount === 3);

      const encBuf = fs.readFileSync(path.join(tmp, 'doubao', 'credentials.enc'));
      const encStr = encBuf.toString('utf8');
      ok('C4', '落盘内容不含明文', !encStr.includes('SECRET_A') && !encStr.includes('sessionid'));
      ok('C5', '凭据不写入 config.json', !fs.existsSync(path.join(tmp, 'config', 'config.json')));

      const metaStr = fs.readFileSync(path.join(tmp, 'doubao', 'metadata.json'), 'utf8');
      ok('C6', 'metadata 只存名字不存值', metaStr.includes('sessionid') && !metaStr.includes('SECRET_A'));

      ok('C7', 'has 反映存在性', (await cs.has()) === true);
      ok('C8', 'getCookieHeader 拼出完整头', (await cs.getCookieHeader()) === 'sessionid=SECRET_A; sid_tt=SECRET_B; uid_tt=SECRET_C');

      cs.invalidateCache();
      const d = await cs.describe();
      ok('C9', 'describe 不含敏感值', d.present === true && d.cookieCount === 3 && !JSON.stringify(d).includes('SECRET_A'));

      cs.init({ userDataDir: tmp, safeStorage: mkSafe({ decryptFail: true }) });
      let t2 = false;
      try { await cs.load(); } catch (e) { t2 = /解密失败/.test(e.message); }
      ok('C10', '解密失败明确报错', t2);
      ok('C11', '解密失败 has 安全返回 false', (await cs.has()) === false);

      fs.writeFileSync(path.join(tmp, 'doubao', 'credentials.enc'), Buffer.from('corrupted'));
      cs.init({ userDataDir: tmp, safeStorage: mkSafe() });
      ok('C12', '文件损坏 has 返回 false', (await cs.has()) === false);

      const c1 = await cs.clear(); const c2 = await cs.clear();
      ok('C13', 'clear 幂等', c1.ok === true && c2.ok === true);
      ok('C14', 'clear 后不可读', (await cs.has()) === false && (await cs.load()) === null);

      let t3 = false;
      try { await cs.save(new Map()); } catch (e) { t3 = /为空|无效/.test(e.message); }
      ok('C15', '空凭据拒绝', t3);

      let t4 = false;
      try { await cs.save(new Map([['sessionid', 'x'.repeat(70000)]])); } catch (e) { t4 = /体积异常/.test(e.message); }
      ok('C16', '超大凭据拒绝', t4);

      const tmpFiles = fs.readdirSync(path.join(tmp, 'doubao')).filter(n => n.endsWith('.tmp'));
      ok('C17', '无 .tmp 残留', tmpFiles.length === 0);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }


  const s = summarize();
  console.log('');
  console.log('---- 第十九部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败 ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); process.exit(2); });