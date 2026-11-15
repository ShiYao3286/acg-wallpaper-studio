// 第十七部分:阶段 2 审核修复批次
//   G. Provider ID 冲突(提交 1)
//   H. 插件符号链接安全(提交 2)
//   K. 只读通道错误记录(提交 3)
//
// 说明:本文件按提交顺序增量补充,三个提交各自只新增对应组。
const path = require('node:path');
const fs = require('node:fs');
const { group, ok, skip, summarize } = require('./common');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS = path.join(ROOT, 'src', 'main', 'plugins');

// 造一个最小可注册的 Provider 描述(含实现方法)
function mkProvider(id, builtin) {
  return {
    id,
    name: id,
    version: '1.0.0',
    kind: 'text',
    capabilities: ['complete'],
    builtin: builtin === true,
    async complete() { return { ok: true, prompt: 'x', local: false }; },
  };
}

(async () => {
  // ========== G. Provider ID 冲突 ==========
  group('G Provider ID 冲突');
  {
    const reg = require(path.join(PLUGINS, 'provider-registry.js'));
    const protocol = require(path.join(PLUGINS, 'provider-protocol.js'));

    reg.reset();

    reg.register(mkProvider('builtin-a', true));
    ok('G1', '内置 Provider 首次注册成功', reg.size() === 1 && !!reg.get('builtin-a'));

    reg.register(mkProvider('builtin-a', true));
    ok('G2', '内置 Provider 同 id 幂等重复注册被允许', reg.size() === 1 && !!reg.get('builtin-a'),
      'main.js 在同进程内多次加载依赖这条');

    ok('G3', '外部 Provider 覆盖内置被拒绝', (() => {
      try { reg.register(mkProvider('builtin-a', false)); return false; }
      catch (e) { return protocol.isProtocolError(e) && /与内置实现冲突/.test(e.message); }
    })(), '拒绝理由须指明是内置冲突');

    ok('G4', '拒绝后被覆盖风险不存在:内置实现未被替换', (() => {
      const meta = reg.getMeta('builtin-a');
      return !!meta && meta.builtin === true && !!reg.get('builtin-a');
    })());

    reg.register(mkProvider('ext-a', false));
    ok('G5', '外部 Provider 首次注册成功', !!reg.get('ext-a') && reg.getMeta('ext-a').builtin === false);

    ok('G6', '外部 Provider 之间同 id 重复被拒绝', (() => {
      try { reg.register(mkProvider('ext-a', false)); return false; }
      catch (e) { return protocol.isProtocolError(e) && /另一个外部插件/.test(e.message); }
    })());

    ok('G7', '同一批次内重复 id 被拒绝', (() => {
      try { reg.registerAll([mkProvider('dup-x', true), mkProvider('dup-x', true)]); return false; }
      catch (e) { return protocol.isProtocolError(e) && /重复 id/.test(e.message); }
    })());

    ok('G8', 'registerAll 不会部分成功(失败后不留下任何一条)', (() => {
      const before = reg.size();
      try { reg.registerAll([mkProvider('partial-a', true), mkProvider('partial-b', true), mkProvider('partial-a', true)]); } catch {}
      return reg.size() === before && !reg.has('partial-a') && !reg.has('partial-b');
    })(), '同批校验在落库之前完成');

    ok('G9', '内置与外部不同 id 可共存', reg.has('builtin-a') && reg.has('ext-a'));

    // 恢复真实内置三件套,确认 registerAll 幂等(模拟 main.js 多次加载)
    reg.reset();
    const lol = require(path.join(PLUGINS, 'builtin', 'lolicon-provider.js'));
    const img = require(path.join(PLUGINS, 'builtin', 'openai-image-provider.js'));
    const txt = require(path.join(PLUGINS, 'builtin', 'openai-text-provider.js'));
    reg.registerAll([lol, img, txt]);
    reg.registerAll([lol, img, txt]);
    ok('G10', '三个真实内置 Provider 重复 registerAll 仍为 3 个', reg.size() === 3,
      '模拟 main.js 热重载/测试脚手架反复加载');

    ok('G11', '内置 Provider 的实现方法真实可用', (() => {
      const p = reg.get('openai-text');
      return !!p && typeof p.complete === 'function';
    })());

    ok('G12', '冲突抛出的都是 ProtocolError 而非普通 Error', (() => {
      const cases = [() => reg.register(mkProvider('lolicon', false))];
      return cases.every(fn => { try { fn(); return false; } catch (e) { return protocol.isProtocolError(e); } });
    })());
  }

  // ========== H. 插件符号链接安全 ==========
  group('H 插件符号链接安全');
  {
    const loader = require(path.join(PLUGINS, 'plugin-loader.js'));
    const os = require('node:os');
    const { execFileSync } = require('node:child_process');

    const tmpRoots = [];
    const mkRoot = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-h17-')); tmpRoots.push(d); return d; };
    const cleanup = () => { for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } };

    const MANIFEST = { id: 'demo', name: 'demo', version: '1.0.0', kind: 'image-source', capabilities: ['fetch-random'] };
    const ENTRY = "module.exports = { async fetch(ctx){ return { url: 'http://x/y.jpg' }; } };";
    function put(dir, id, entryCode) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({}, MANIFEST, { id }), null, 2), 'utf8');
      fs.writeFileSync(path.join(dir, 'index.js'), entryCode || ENTRY, 'utf8');
      return dir;
    }

    // 能否创建文件符号链接(本机为 EPERM,需开发者模式或管理员)
    function canSymlinkFile() {
      const t = mkRoot();
      try {
        fs.writeFileSync(path.join(t, 'target.txt'), 'x');
        fs.symlinkSync(path.join(t, 'target.txt'), path.join(t, 'link.txt'), 'file');
        return true;
      } catch { return false; }
    }
    // 能否创建目录 junction(mklink /J,通常不需要特权)
    function canJunction() {
      const t = mkRoot();
      try {
        const target = path.join(t, 'target');
        fs.mkdirSync(target, { recursive: true });
        execFileSync('cmd', ['/c', 'mklink', '/J', path.join(t, 'link'), target], { stdio: 'pipe' });
        return true;
      } catch { return false; }
    }

    const symlinkFileOk = canSymlinkFile();
    const junctionOk = canJunction();
    console.log('    [环境] 文件符号链接可创建: ' + symlinkFileOk + ' / 目录 junction 可创建: ' + junctionOk);

    // ---------- H5:正常插件回归(无条件执行) ----------
    {
      const base = mkRoot();
      const root2 = path.join(base, 'plugins');
      put(path.join(root2, 'demo'), 'demo');
      const r = loader.discover(root2);
      ok('H5', '正常插件(无链接)发现行为不变', r.found.length === 1 && r.found[0].id === 'demo' && r.skipped.length === 0,
        'found=' + r.found.length + ' skipped=' + r.skipped.length);
    }

    // ---------- H3:插件目录是 junction 指向外部 ----------
    if (!junctionOk) {
      skip('H3', '插件目录是 junction 时被拒绝', '本机无法创建目录 junction');
    } else {
      const base = mkRoot();
      const root2 = path.join(base, 'plugins');
      const outside = path.join(base, 'outside');
      put(outside, 'demo');
      fs.mkdirSync(root2, { recursive: true });
      execFileSync('cmd', ['/c', 'mklink', '/J', path.join(root2, 'demo'), outside], { stdio: 'pipe' });
      const r = loader.discover(root2);
      ok('H3', '插件目录是 junction 时被拒绝', r.found.length === 0 && r.skipped.length === 1,
        'found=' + r.found.length + ' skipped=' + JSON.stringify(r.skipped.map(x => x.reason)));
    }

    // ---------- H4:插件根目录是 junction ----------
    if (!junctionOk) {
      skip('H4', '插件根目录是 junction 时整体拒绝', '本机无法创建目录 junction');
    } else {
      const base = mkRoot();
      const realRoot = path.join(base, 'real-plugins');
      put(path.join(realRoot, 'demo'), 'demo');
      const linkRoot = path.join(base, 'plugins');
      execFileSync('cmd', ['/c', 'mklink', '/J', linkRoot, realRoot], { stdio: 'pipe' });
      const r = loader.discover(linkRoot);
      ok('H4', '插件根目录是 junction 时整体拒绝', r.found.length === 0 && r.skipped.length === 1 && /根目录是符号链接/.test(r.skipped[0].reason),
        'skipped=' + JSON.stringify(r.skipped.map(x => x.reason)));
    }

    // ---------- H1:入口文件是指向外部的符号链接 ----------
    if (!symlinkFileOk) {
      skip('H1', '入口文件是符号链接时被拒绝', '本机无法创建文件符号链接(需开发者模式或管理员权限),待补测');
    } else {
      const base = mkRoot();
      const root2 = path.join(base, 'plugins');
      const outside = path.join(base, 'outside');
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'evil.js'), 'module.exports={};', 'utf8');
      const dir = path.join(root2, 'demo');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(MANIFEST, null, 2), 'utf8');
      fs.symlinkSync(path.join(outside, 'evil.js'), path.join(dir, 'index.js'), 'file');
      const r = loader.discover(root2);
      ok('H1', '入口文件是符号链接时被拒绝', r.found.length === 0 && r.skipped.length === 1 && /符号链接/.test(r.skipped[0].reason),
        'skipped=' + JSON.stringify(r.skipped.map(x => x.reason)));
    }

    // ---------- H2:入口文件是插件目录内的符号链接(也应拒绝) ----------
    if (!symlinkFileOk) {
      skip('H2', '入口链接指向插件目录内也被拒绝', '本机无法创建文件符号链接(需开发者模式或管理员权限),待补测');
    } else {
      const base = mkRoot();
      const root2 = path.join(base, 'plugins');
      const dir = path.join(root2, 'demo');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(MANIFEST, null, 2), 'utf8');
      fs.writeFileSync(path.join(dir, 'real-entry.js'), ENTRY, 'utf8');
      fs.symlinkSync(path.join(dir, 'real-entry.js'), path.join(dir, 'index.js'), 'file');
      const r = loader.discover(root2);
      ok('H2', '入口链接指向插件目录内也被拒绝', r.found.length === 0 && r.skipped.length === 1 && /符号链接/.test(r.skipped[0].reason),
        '即使目标在目录内也拒绝,语义更明确:用户放了什么文件就是什么文件');
    }

    // ---------- H6:循环符号链接 ----------
    if (!symlinkFileOk) {
      skip('H6', '循环符号链接不崩溃', '本机无法创建文件符号链接(需开发者模式或管理员权限),待补测');
    } else {
      const base = mkRoot();
      const root2 = path.join(base, 'plugins');
      const dir = path.join(root2, 'demo');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(MANIFEST, null, 2), 'utf8');
      try { fs.symlinkSync(path.join(dir, 'a.js'), path.join(dir, 'b.js'), 'file'); fs.symlinkSync(path.join(dir, 'b.js'), path.join(dir, 'a.js'), 'file'); } catch {}
      const r = loader.discover(root2);
      ok('H6', '循环符号链接不崩溃且被跳过', r.found.length === 0,
        'skipped=' + JSON.stringify(r.skipped.map(x => x.reason)));
    }

    // ---------- 纯函数单测(辅助,不替代真实文件系统测试) ----------
    ok('H7', '[纯函数] isInside 拒绝前缀伪装路径', (() => {
      const a = path.join('C:', 'tmp', 'plugin');
      const b = path.join('C:', 'tmp', 'plugin-evil');
      return loader.isInside(a, a) === true && loader.isInside(a, b) === false;
    })(), '不用 startsWith,避免 plugin 与 plugin-evil 误判');

    ok('H8', '[纯函数] isInside 拒绝跨盘/父级路径', (() => {
      const a = path.join('C:', 'tmp', 'plugin');
      return loader.isInside(a, path.join('C:', 'tmp')) === false
        && loader.isInside(a, path.join(a, 'sub', 'x.js')) === true;
    })());

    // 用一个真实的 junction 验证 isDir 语义,而不是靠 mock。
    // junction 不可用时显式 SKIP —— 不允许"因为没有前置条件所以算通过"。
    if (!junctionOk) {
      skip('H9', '[纯函数] isDir 对符号链接返回 false', '本机无法创建目录 junction');
    } else {
      const base = mkRoot();
      const target = path.join(base, 'target');
      fs.mkdirSync(target, { recursive: true });
      const link = path.join(base, 'link');
      execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
      ok('H9', '[纯函数] isDir 对符号链接返回 false', (() => {
        return loader.isDir(target) === true && loader.isDir(link) === false && loader.isSymlink(link) === true;
      })(), '真目录 true / junction false / isSymlink 能识别');
    }

    cleanup();
  }

  const s = summarize();
  console.log('');
  console.log('---- 第十七部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败' + (s.skipped ? ', ' + s.skipped + ' 跳过' : '') + ' ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); process.exit(2); });