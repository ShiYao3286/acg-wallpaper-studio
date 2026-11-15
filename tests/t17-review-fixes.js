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
    // ---------- G13: registerAll 与已有 registry 冲突,必须整体不生效 ----------
    {
      const reg2 = require(path.join(PLUGINS, 'provider-registry.js'));
      reg2.reset();
      reg2.register(mkProvider('existing-bi', true));
      const implBefore = reg2.get('existing-bi');
      const metaBefore = reg2.getMeta('existing-bi');
      const sizeBefore = reg2.size();
      reg2.setEnabled('existing-bi', false);
      const enabledBefore = reg2.isEnabled('existing-bi');
      const threw = (() => {
        try {
          reg2.registerAll([mkProvider('new-one', true), mkProvider('existing-bi', false)]);
          return null;
        } catch (e) { return e; }
      })();
      ok('G13', 'registerAll 与已有 registry 冲突时整体失败', !!threw && protocol.isProtocolError(threw),
        threw ? threw.message : '未抛错');
      ok('G13b', '失败后前一个新 Provider 未被部分注册', !reg2.has('new-one') && reg2.size() === sizeBefore,
        'size=' + reg2.size() + ' (期望 ' + sizeBefore + ')');
      // 注意:get() 在 disabled 状态下返回 null,因此这里不能用 get() 比引用。
      // 先恢复 enabled 拿到实现引用做比对,再置回 disabled 保持后续状态断言的前提。
      reg2.setEnabled('existing-bi', true);
      const implAfter = reg2.get('existing-bi');
      reg2.setEnabled('existing-bi', false);
      ok('G13c', '失败后原有 Provider 实现引用不变', implAfter === implBefore,
        'disabled 时 get() 返回 null,故先临时启用再比对');
      ok('G13d', '失败后原有 Provider 元数据不变', JSON.stringify(reg2.getMeta('existing-bi')) === JSON.stringify(metaBefore));
      ok('G13e', '失败后 enabled/disabled 状态不变', reg2.isEnabled('existing-bi') === enabledBefore,
        '期望 ' + enabledBefore + ' 实际 ' + reg2.isEnabled('existing-bi'));
    }
    // ---------- G14: 内置 Provider 严格幂等(不替换实现、不动状态) ----------
    {
      const reg3 = require(path.join(PLUGINS, 'provider-registry.js'));
      reg3.reset();
      const first = mkProvider('idem-bi', true);
      reg3.register(first);
      const implA = reg3.get('idem-bi');
      ok('G14a', '内置 Provider 首次注册成功', !!implA && reg3.size() === 1);
      // 第二次用"实现不同"的同 id 内置对象注册
      const second = mkProvider('idem-bi', true);
      second.complete = async () => ({ replaced: true });
      reg3.register(second);
      ok('G14b', '内置同 id 再次注册不替换现有实现(引用不变)', reg3.get('idem-bi') === implA,
        '严格幂等:原实现引用必须保持');
      // 再验证 disabled 状态不被改动
      reg3.setEnabled('idem-bi', false);
      reg3.register(mkProvider('idem-bi', true));
      ok('G14c', '内置同 id 再次注册不改变 disabled 状态', reg3.isEnabled('idem-bi') === false,
        '幂等不应把已停用的条目悄悄启用');
    }
    // ---------- G15: 外部插件自报 builtin:true 不能获得内置身份 ----------
    // 走真实加载器路径(discover + loadOne),不是直接调 describeProvider
    {
      const loader2 = require(path.join(PLUGINS, 'plugin-loader.js'));
      const os2 = require('node:os');
      const base = fs.mkdtempSync(path.join(os2.tmpdir(), 'acg-g15-'));
      try {
        const dir = path.join(base, 'faker');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
          id: 'faker', name: 'faker', version: '1.0.0',
          kind: 'text', capabilities: ['complete'],
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(dir, 'index.js'),
          'module.exports = { builtin: true, async complete(){ return { ok:true, prompt:"x", local:false }; } };', 'utf8');
        const scan = loader2.discover(base);
        ok('G15a', '自报 builtin 的插件可被发现', scan.found.length === 1, 'found=' + scan.found.length);
        const loaded = loader2.loadOne(scan.found[0]);
        ok('G15b', '加载成功', loaded.ok === true, loaded.ok ? '' : loaded.reason);
        ok('G15c', '加载后 builtin 被强制为 false(不能自封内置)', loaded.ok && loaded.provider.builtin === false,
          'builtin=' + (loaded.ok ? loaded.provider.builtin : 'n/a'));
        ok('G15d', '自报的 complete 方法仍被保留(只改身份,不改实现)',
          loaded.ok && typeof loaded.provider.complete === 'function');
        // 用真实 registry 验证:该外部实现不能覆盖内置
        const reg4 = require(path.join(PLUGINS, 'provider-registry.js'));
        reg4.reset();
        reg4.register(mkProvider('mimic-target', true));
        const faker2 = { ...loaded.provider, id: 'mimic-target' };
        ok('G15e', '伪装 builtin 的外部实现仍被内置冲突规则拦下', (() => {
          try { reg4.register(faker2); return false; }
          catch (e) { return protocol.isProtocolError(e) && /与内置实现冲突/.test(e.message); }
        })(), 'builtin:false 使得它无法绕过内置保护');
      } finally {
        try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
      }
    }
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

  // ========== K. 只读通道错误记录 ==========
  group('K 只读通道错误记录');
  {
    const os = require('node:os');
    const { loadMain, waitBoot, closeAllWatchers } = require('./harness');

    const tmpRoots = [];
    async function mkEnv() {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-k17-'));
      tmpRoots.push(base);
      const userData = path.join(base, 'userData');
      const pictures = path.join(base, 'Pictures');
      const wallDir = path.join(pictures, 'ACG_Wallpaper');
      const confDir = path.join(userData, 'config');
      fs.mkdirSync(confDir, { recursive: true });
      fs.mkdirSync(wallDir, { recursive: true });
      const loaded = loadMain({ userDataDir: userData, picturesDir: pictures, holdReady: false, singleInstanceLock: true });
      await waitBoot(loaded.state, 5000);
      const call = async (ch, ...a) => { const fn = loaded.state.ipcHandlers.get(ch); return await fn({}, ...a); };
      return { base, userData, pictures, wallDir, confDir, confFile: path.join(confDir, 'config.json'), call };
    }

    // ---------- K1 正常无错误 ----------
    {
      const e = await mkEnv();
      const st = await e.call('get-status');
      ok('K1', 'get-config 正常时 readErrors 为空', Object.keys(st.readErrors).length === 0,
        'readErrors=' + JSON.stringify(st.readErrors));
      closeAllWatchers();
    }

    // ---------- K2 config 损坏 -> 记错误,返回形状不变 ----------
    {
      const e = await mkEnv();
      fs.writeFileSync(e.confFile, '{ broken json', 'utf8');
      const cfg = await e.call('get-config');
      const st = await e.call('get-status');
      ok('K2', 'config 损坏时返回配置对象(形状不变)', typeof cfg === 'object' && cfg !== null && typeof cfg.source === 'string',
        'source=' + (cfg && cfg.source));
      ok('K3', 'config 损坏时 readErrors[get-config] 有值',
        typeof st.readErrors['get-config'] === 'string' && st.readErrors['get-config'].length > 0,
        '记录=' + String(st.readErrors['get-config']).slice(0, 60));
      closeAllWatchers();
    }

    // ---------- K4 config 不存在(ENOENT)按首次使用,不算错误 ----------
    {
      const e = await mkEnv();
      fs.rmSync(e.confFile, { force: true });
      const cfg = await e.call('get-config');
      const st = await e.call('get-status');
      ok('K4', 'config 不存在时返回默认配置', typeof cfg === 'object' && cfg !== null && cfg.source === 'lolicon');
      ok('K5', 'config 不存在(ENOENT)不计入 readErrors', !st.readErrors['get-config'],
        '首次使用不是错误;实际=' + JSON.stringify(st.readErrors['get-config'] || null));
      closeAllWatchers();
    }

    // ---------- K6 history.jsonl 被目录占据(EISDIR/ENOTDIR) ----------
    {
      const e = await mkEnv();
      fs.mkdirSync(path.join(e.wallDir, 'history.jsonl'));
      const m = await e.call('read-meta', 'x.jpg');
      const st = await e.call('get-status');
      ok('K6', 'read-meta 读取失败时返回 null(形状不变)', m === null);
      ok('K7', 'read-meta 真实读取异常被记录',
        typeof st.readErrors['read-meta'] === 'string' && st.readErrors['read-meta'].length > 0,
        '记录=' + String(st.readErrors['read-meta']).slice(0, 60));
      closeAllWatchers();
    }

    // ---------- K8 history.jsonl 不存在(ENOENT)按首次使用 ----------
    {
      const e = await mkEnv();
      const m = await e.call('read-meta', 'x.jpg');
      const st = await e.call('get-status');
      ok('K8', 'history.jsonl 不存在时返回 null', m === null);
      ok('K9', 'history.jsonl 不存在(ENOENT)不计入 readErrors', !st.readErrors['read-meta'],
        '实际=' + JSON.stringify(st.readErrors['read-meta'] || null));
      closeAllWatchers();
    }

    // ---------- K10 失败后恢复,错误应被清除 ----------
    {
      const e = await mkEnv();
      fs.mkdirSync(path.join(e.wallDir, 'history.jsonl'));
      await e.call('read-meta', 'x.jpg');
      const stBad = await e.call('get-status');
      const hadError = !!stBad.readErrors['read-meta'];
      // 恢复成正常文件
      fs.rmdirSync(path.join(e.wallDir, 'history.jsonl'));
      fs.writeFileSync(path.join(e.wallDir, 'history.jsonl'), JSON.stringify({ file: 'x.jpg', time: 't' }) + '\n', 'utf8');
      const hit = await e.call('read-meta', 'x.jpg');
      const stGood = await e.call('get-status');
      ok('K10', '读取恢复正常后 readErrors 被清除',
        hadError && hit !== null && !stGood.readErrors['read-meta'],
        '故障时=' + hadError + ' 恢复后命中=' + (hit !== null) + ' 残留=' + JSON.stringify(stGood.readErrors['read-meta'] || null));
      closeAllWatchers();
    }

    // ---------- K11 get-status 契约未变 ----------
    {
      const e = await mkEnv();
      const st = await e.call('get-status');
      ok('K11', 'get-status 原有字段未受影响',
        typeof st.sourceLabel === 'string' && 'lastInfo' in st && 'imageModels' in st
        && 'currentPath' in st && 'scriptMeta' in st && typeof st.readErrors === 'object');
      closeAllWatchers();
    }

    // ---------- K12 get-config 返回形状与旧实现等价 ----------
    {
      const e = await mkEnv();
      const c = await e.call('get-config');
      ok('K12', 'get-config 仍返回完整配置对象',
        c && typeof c === 'object' && 'source' in c && 'lolicon' in c && 'services' in c && 'ai' in c && 'plugins' in c,
        '顶层键数=' + (c ? Object.keys(c).length : 0));
      closeAllWatchers();
    }

    for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }

  const s = summarize();
  console.log('');
  console.log('---- 第十七部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败' + (s.skipped ? ', ' + s.skipped + ' 跳过' : '') + ' ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); process.exit(2); });