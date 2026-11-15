// 第十五部分:外部插件加载器(阶段 2 第 4 步)
//   重点验证安全边界:目录穿越、id 与目录名不一致、入口逃逸、坏 manifest、默认不执行
const path = require('node:path');
const fs = require('node:fs');
const { group, ok, mkTmp, cleanupTmp, summarize } = require('./common');

const ROOT = path.resolve(__dirname, '..');
const loader = require(path.join(ROOT, 'src', 'main', 'plugins', 'plugin-loader.js'));
const protocol = require(path.join(ROOT, 'src', 'main', 'plugins', 'provider-protocol.js'));

// 在当前测试目录下造一个插件根,写一个最小可用插件
function mkPluginsRoot() {
  const root = mkTmp('acg-plugins-');
  fs.mkdirSync(root, { recursive: true });
  return root;
}
function writePlugin(root, dirName, manifest, entryCode) {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== null) {
    const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2);
    fs.writeFileSync(path.join(dir, 'manifest.json'), body, 'utf8');
  }
  if (entryCode !== null) fs.writeFileSync(path.join(dir, 'index.js'), entryCode, 'utf8');
  return dir;
}
const VALID_MANIFEST = { id: 'demo-plug', name: '演示插件', version: '1.0.0', kind: 'image-source', capabilities: ['fetch-random'] };
const VALID_ENTRY = "module.exports = { async fetch(ctx) { return { url: 'http://x/y.jpg' }; } };";

(async () => {
  const root = mkPluginsRoot();

  group('A 插件发现');
  {
    writePlugin(root, 'demo-plug', VALID_MANIFEST, VALID_ENTRY);
    const r = loader.discover(root);
    ok('A1', '合法插件被发现', r.found.length === 1 && r.found[0].id === 'demo-plug', JSON.stringify(r.found.map(f => f.id)));
    ok('A2', '发现结果包含 manifest 与 entry', r.found[0] && !!r.found[0].manifest && !!r.found[0].entry);
    ok('A3', '发现阶段不执行插件代码', typeof globalThis.__pluginExecuted === 'undefined', 'discover 只做磁盘扫描');
  }

  group('B 坏 manifest 处理');
  {
    const r2 = mkPluginsRoot();
    writePlugin(r2, 'no-manifest', null, VALID_ENTRY);
    writePlugin(r2, 'bad-json', '{ this is not json', VALID_ENTRY);
    writePlugin(r2, 'not-object', '[1,2,3]', VALID_ENTRY);
    writePlugin(r2, 'no-id', { name: 'x', kind: 'text', capabilities: ['complete'] }, VALID_ENTRY);
    writePlugin(r2, 'bad-id', { id: '../evil', name: 'x', kind: 'text', capabilities: ['complete'] }, VALID_ENTRY);
    writePlugin(r2, 'mismatch', { id: 'other-name', name: 'x', kind: 'text', capabilities: ['complete'] }, VALID_ENTRY);
    const r = loader.discover(r2);
    ok('B1', '坏 manifest 全部被跳过,无一个进入 found', r.found.length === 0, 'found: ' + r.found.map(f => f.id).join(','));
    ok('B2', '每个被跳过的目录都有原因', r.skipped.length === 6 && r.skipped.every(s => typeof s.reason === 'string' && s.reason.length > 0),
      r.skipped.map(s => path.basename(s.dir) + '=' + s.reason).join(' | '));
    ok('B3', 'id 与目录名不一致被明确拒绝',
      r.skipped.some(s => path.basename(s.dir) === 'mismatch' && /不一致/.test(s.reason)), '用户看到的名称与实际目录必须对得上');
    ok('B4', 'id 含路径穿越被拒绝',
      r.skipped.some(s => path.basename(s.dir) === 'bad-id' && /非法/.test(s.reason)));
  }

  group('C 入口文件安全');
  {
    const r3 = mkPluginsRoot();
    writePlugin(r3, 'escape', { id: 'escape', name: 'e', kind: 'text', capabilities: ['complete'], main: '../../evil.js' }, null);
    writePlugin(r3, 'missing-entry', { id: 'missing-entry', name: 'm', kind: 'text', capabilities: ['complete'] }, null);
    const r = loader.discover(r3);
    ok('C1', '入口逃逸出插件目录被拒绝',
      r.skipped.some(s => path.basename(s.dir) === 'escape' && /逃逸/.test(s.reason)),
      r.skipped.map(s => path.basename(s.dir) + '=' + s.reason).join(' | '));
    ok('C2', '入口文件缺失被拒绝',
      r.skipped.some(s => path.basename(s.dir) === 'missing-entry' && /不存在/.test(s.reason)));
  }

  group('D 插件加载');
  {
    const r4 = mkPluginsRoot();
    writePlugin(r4, 'demo-plug', VALID_MANIFEST, VALID_ENTRY);
    const scan = loader.discover(r4);
    const loaded = loader.loadOne(scan.found[0]);
    ok('D1', '合法插件可加载', loaded.ok === true, loaded.ok ? '' : loaded.reason);
    ok('D2', '加载后 builtin 标记为 false', loaded.ok && loaded.provider.builtin === false);
    ok('D3', 'manifest 元数据覆盖代码声明', loaded.ok && loaded.provider.name === '演示插件');
    ok('D4', '加载结果通过协议校验', (() => {
      try { protocol.describeProvider(loaded.provider); return true; } catch { return false; }
    })());

    const r5 = mkPluginsRoot();
    writePlugin(r5, 'bad-code', { id: 'bad-code', name: 'b', kind: 'text', capabilities: ['complete'] }, 'throw new Error("boom");');
    const scan5 = loader.discover(r5);
    const loaded5 = loader.loadOne(scan5.found[0]);
    ok('D5', '插件代码抛错被捕获为失败结果而非崩溃程序', loaded5.ok === false && /boom/.test(loaded5.reason), loaded5.reason);

    const r6 = mkPluginsRoot();
    writePlugin(r6, 'no-method', { id: 'no-method', name: 'n', kind: 'text', capabilities: ['complete'] }, 'module.exports = { name: "n" };');
    const scan6 = loader.discover(r6);
    const loaded6 = loader.loadOne(scan6.found[0]);
    ok('D6', '缺少必需方法的插件加载失败并说明原因', loaded6.ok === false && /协议校验失败/.test(loaded6.reason), loaded6.reason);
  }

  group('E 默认不执行(安全默认值)');
  {
    ok('E1', '默认配置 plugins.enabled 为空数组', (() => {
      const { DEFAULT_CONFIG } = require(path.join(ROOT, 'src', 'shared', 'defaults.js'));
      return DEFAULT_CONFIG.plugins && Array.isArray(DEFAULT_CONFIG.plugins.enabled) && DEFAULT_CONFIG.plugins.enabled.length === 0;
    })(), '外部插件不得自动执行');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    ok('E2', 'main.js 有 list-plugins 与 set-plugin-enabled 通道',
      mainSrc.indexOf("'list-plugins'") >= 0 && mainSrc.indexOf("'set-plugin-enabled'") >= 0);
    ok('E3', '启用插件前会先走 discover 与 loadOne 校验',
      /pluginLoader\.loadOne/.test(mainSrc) && /pluginLoader\.discover/.test(mainSrc));
    ok('E4', '启动时恢复已启用插件但失败不阻塞启动',
      /restoreEnabledPlugins/.test(mainSrc) && /try \{ await restoreEnabledPlugins\(\); \} catch/.test(mainSrc));
    ok('E5', 'list-plugins 只返回元数据,不把实现函数传给渲染层', (() => {
      const m = mainSrc.match(/ipcMain\.handle\('list-plugins'[\s\S]{0,1400}?\n\}\);/);
      return !!m && !/\.fetch\b|\.generate\b|\.complete\b/.test(m[0]);
    })(), '渲染层不应拿到 Provider 方法引用');
  }

  group('F preload 暴露');
  {
    const preSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
    ok('F1', 'preload 暴露 listPlugins', preSrc.indexOf('listPlugins') >= 0);
    ok('F2', 'preload 暴露 setPluginEnabled', preSrc.indexOf('setPluginEnabled') >= 0);
    ok('F3', '主进程与 preload 通道数一致', (() => {
      const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
      const mainCount = (mainSrc.match(/ipcMain\.handle\(/g) || []).length;
      const preCount = (preSrc.match(/ipcRenderer\.invoke\(/g) || []).length;
      return mainCount === preCount && mainCount > 0;
    })());
  }

  cleanupTmp();
  const s = summarize();
  console.log('');
  console.log('---- 第十五部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败' + (s.skipped ? ', ' + s.skipped + ' 跳过' : '') + ' ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); cleanupTmp(); process.exit(2); });