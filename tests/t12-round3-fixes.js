// 第十二部分:第三轮审核修复的回归测试
//   【直接测试生产代码】:通过 harness 加载真实 main.js,直接调用真实 IPC handler
//   覆盖:1) save-config 数组下标校验  2) delete-favorite 参数校验
//         3) renderer 失败反馈(静态核验)  4) run-all 注释与实际一致
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { group, ok, sleep, summarize } = require('./common');
const { loadMain, waitBoot, closeAllWatchers } = require('./harness');

const REPO = path.resolve(__dirname, '..');

async function mkEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-r3-'));
  const userData = path.join(root, 'userData');
  const pictures = path.join(root, 'Pictures');
  const wallDir = path.join(pictures, 'ACG_Wallpaper');
  const favDir = path.join(wallDir, 'favorites');
  fs.mkdirSync(path.join(userData, 'config'), { recursive: true });
  fs.mkdirSync(favDir, { recursive: true });
  const loaded = loadMain({ userDataDir: userData, picturesDir: pictures });
  await waitBoot(loaded.state, 5000);
  const call = async (channel, ...args) => {
    const fn = loaded.state.ipcHandlers.get(channel);
    if (!fn) throw new Error('通道未注册: ' + channel);
    return await fn({}, ...args);
  };
  return { root, userData, pictures, wallDir, favDir, confFile: path.join(userData, 'config', 'config.json'), ...loaded, call };
}

(async () => {
  // ============ 1. save-config 数组下标校验 ============
  group('S1 save-config 数组下标校验');
  {
    const env = await mkEnv();
    const readCfg = () => JSON.parse(fs.readFileSync(env.confFile, 'utf8'));

    // 准备两个服务、两个预设
    await env.call('save-config', 'services', [
      { id: 's0', kind: 'image', name: '零', apiBase: 'http://a.com', apiKey: 'k0', model: 'm0' },
      { id: 's1', kind: 'text', name: '一', apiBase: 'http://b.com', apiKey: 'k1', model: 'm1' },
    ]);
    await env.call('save-config', 'promptPresets', [
      { id: 'p0', name: '预设零', prompt: 'p0 prompt' },
      { id: 'p1', name: '预设一', prompt: 'p1 prompt' },
    ]);

    // 1a 合法下标
    const r1 = await env.call('save-config', 'services.0.apiBase', 'https://ok.com/v1');
    ok('S1-1', 'services.0.apiBase 合法修改成功', r1 && r1.ok !== false, JSON.stringify(r1).slice(0, 80));
    ok('S1-2', '落盘仍为真数组(非对象)', Array.isArray(readCfg().services), JSON.stringify(readCfg().services).slice(0, 60));
    ok('S1-3', '值已正确写入', readCfg().services[0].apiBase === 'https://ok.com/v1');
    ok('S1-4', '数组长度未变', readCfg().services.length === 2, String(readCfg().services.length));
    ok('S1-5', '同数组其它元素未受影响', readCfg().services[1].id === 's1');

    const r2 = await env.call('save-config', 'promptPresets.1.prompt', '新提示词');
    ok('S1-6', 'promptPresets.1.prompt 合法修改成功', r2 && r2.ok !== false);
    ok('S1-7', '预设值已正确写入', readCfg().promptPresets[1].prompt === '新提示词');

    // 1b 非法下标全部拒绝,且不改文件
    const before = fs.readFileSync(env.confFile, 'utf8');
    const bad = [
      ['services.foo.name', '非数字下标'],
      ['services.-1.name', '负数下标'],
      ['services.1.5.name', '小数下标'],
      ['services.01.name', '前导零下标'],
      ['services. 1.name', '含空格下标'],
      ['services.1e3.name', '科学计数下标'],
      ['services.+1.name', '带正号下标'],
      ['services.99.name', '越界下标'],
      ['services.99999.name', '极大下标'],
      ['promptPresets.bar.prompt', '预设非数字下标'],
      ['promptPresets.-1.prompt', '预设负数下标'],
      ['promptPresets.00.prompt', '预设前导零下标'],
      ['promptPresets.99.prompt', '预设越界下标'],
    ];
    let badIdx = 0;
    for (const [k, label] of bad) {
      badIdx++;
      const rr = await env.call('save-config', k, 'x');
      ok('S1-bad' + badIdx, label + ' 被拒', rr && rr.ok === false && rr.code === 'E_INVALID_ARG', JSON.stringify(rr).slice(0, 90));
    }
    ok('S1-8', '全部拒绝操作后原配置文件逐字节未变', fs.readFileSync(env.confFile, 'utf8') === before);

    // 1c 元素整体替换也校验下标
    const r3 = await env.call('save-config', 'services.0', { id: 's0b', kind: 'image', name: '新零', apiBase: 'http://c.com', apiKey: 'k0b', model: 'm0b' });
    ok('S1-9', 'services.0 元素整体替换成功', r3 && r3.ok !== false, JSON.stringify(r3).slice(0, 90));
    ok('S1-10', '替换后仍为数组', Array.isArray(readCfg().services));
    const r4 = await env.call('save-config', 'services.99', { id: 'x', kind: 'image', name: 'x', apiBase: 'http://x.com', apiKey: 'k', model: 'm' });
    ok('S1-11', 'services.99 越界整体替换被拒', r4 && r4.ok === false, JSON.stringify(r4).slice(0, 90));
    const r5 = await env.call('save-config', 'promptPresets.99', { id: 'p', name: 'n', prompt: 'x' });
    ok('S1-12', 'promptPresets.99 越界整体替换被拒', r5 && r5.ok === false, JSON.stringify(r5).slice(0, 90));

    fs.rmSync(env.root, { recursive: true, force: true });
  }

  // ============ 2. delete-favorite 参数校验 ============
  group('S2 delete-favorite 参数校验');
  {
    const env = await mkEnv();
    const good1 = 'fav_20261115_120000.jpg';
    const good2 = 'fav_20261115_120001.jpg';
    fs.writeFileSync(path.join(env.favDir, good1), Buffer.alloc(1000, 1));
    fs.writeFileSync(path.join(env.favDir, good2), Buffer.alloc(1000, 2));
    fs.writeFileSync(path.join(env.favDir, 'notes.txt'), 'keep me');
    fs.writeFileSync(path.join(env.favDir, 'other.jpg'), Buffer.alloc(500, 3));
    fs.writeFileSync(path.join(env.wallDir, 'current.jpg'), Buffer.alloc(2000, 4));

    // 2a 正常删除
    const r1 = await env.call('delete-favorite', good1);
    ok('S2-1', '合法收藏文件删除成功', r1 && r1.ok === true, JSON.stringify(r1));
    ok('S2-2', '目标文件已删除', !fs.existsSync(path.join(env.favDir, good1)));
    ok('S2-3', '其它收藏未受影响', fs.existsSync(path.join(env.favDir, good2)));

    // 2b 类型与长度
    ok('S2-4', 'null 被拒', (await env.call('delete-favorite', null)).ok === false);
    ok('S2-5', 'undefined 被拒', (await env.call('delete-favorite', undefined)).ok === false);
    ok('S2-6', '数字被拒', (await env.call('delete-favorite', 123)).ok === false);
    ok('S2-7', '空字符串被拒', (await env.call('delete-favorite', '')).ok === false);
    ok('S2-8', '纯空白被拒', (await env.call('delete-favorite', '   ')).ok === false);
    ok('S2-9', '超长被拒', (await env.call('delete-favorite', 'x'.repeat(200))).ok === false);

    // 2c 路径穿越
    ok('S2-10', '正斜杠穿越被拒', (await env.call('delete-favorite', '../../current.jpg')).ok === false);
    ok('S2-11', '反斜杠穿越被拒', (await env.call('delete-favorite', '..\\..\\current.jpg')).ok === false);
    ok('S2-12', '子路径被拒', (await env.call('delete-favorite', 'sub/fav_20261115_120000.jpg')).ok === false);
    ok('S2-13', 'current.jpg 仍在', fs.existsSync(path.join(env.wallDir, 'current.jpg')));

    // 2d 非收藏文件名
    ok('S2-14', '非 jpg 被拒', (await env.call('delete-favorite', 'notes.txt')).ok === false);
    ok('S2-15', 'notes.txt 未被删', fs.existsSync(path.join(env.favDir, 'notes.txt')));
    ok('S2-16', '非 fav_ 前缀被拒', (await env.call('delete-favorite', 'other.jpg')).ok === false);
    ok('S2-17', 'other.jpg 未被删', fs.existsSync(path.join(env.favDir, 'other.jpg')));
    ok('S2-18', '格式不符被拒', (await env.call('delete-favorite', 'fav_abc.jpg')).ok === false);
    ok('S2-19', '缺时分秒被拒', (await env.call('delete-favorite', 'fav_20261115.jpg')).ok === false);
    ok('S2-20', '扩展名不符被拒', (await env.call('delete-favorite', 'fav_20261115_120000.png')).ok === false);

    // 2e 格式合法但不存在
    const rMissing = await env.call('delete-favorite', 'fav_20991231_235959.jpg');
    ok('S2-21', '不存在的收藏返回 E_NOT_FOUND', rMissing && rMissing.ok === false && rMissing.code === 'E_NOT_FOUND', JSON.stringify(rMissing).slice(0, 100));

    // 2f 目录其它内容完好
    const remain = fs.readdirSync(env.favDir).sort();
    ok('S2-22', 'favorites 目录内容符合预期',
      JSON.stringify(remain) === JSON.stringify([good2, 'notes.txt', 'other.jpg'].sort()), remain.join(','));

    fs.rmSync(env.root, { recursive: true, force: true });
  }

  // ============ 3. renderer 失败反馈(静态核验) ============
  group('S3 renderer 失败反馈(静态核验)');
  {
    // 阶段4 UI 重构:renderer.js 拆分为 js/ 多文件,这里拼接全文(顺序与运行时一致)
const RJS_ORDER = [['core.js','js'],['ui.js','js'],['doubao.js','js'],['tags.js','js'],
  ['settings-shared.js','js'],['services.js','js/pages'],['library.js','js/pages'],
  ['creation.js','js/pages'],['workbench.js','js/pages'],['config.js','js'],
  ['status.js','js'],['boot.js','js']];
const src = RJS_ORDER.map(([f, d]) => fs.readFileSync(path.join(REPO, 'src', 'renderer', d, f), 'utf8')).join('\n');
    const grab = (name) => {
      const m = src.match(new RegExp('async function ' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}'));
      return m ? m[0] : null;
    };

    const checks = [
      ['addTag', 'S3-1', 'addTag 检查 ok:false', /r\.ok\s*===?\s*false/],
      ['addTag', 'S3-2', 'addTag 捕获 Promise rejection', /catch\s*\(/],
      ['addTag', 'S3-3', 'addTag 失败时不提前清空输入(清空在成功分支之后)', /if\s*\(r\s*&&\s*r\.ok\s*===\s*false\)[\s\S]*?return[\s\S]*?tag-input[\s\S]*?=\s*''/],
      ['delTag', 'S3-4', 'delTag 检查 ok:false', /r\.ok\s*===?\s*false/],
      ['delTag', 'S3-5', 'delTag 捕获 rejection', /catch\s*\(/],
      ['applyPreset', 'S3-6', 'applyPreset 检查 saveConfig 返回值', /saveConfig[\s\S]{0,200}r\.ok\s*===?\s*false/],
      ['applyPreset', 'S3-7', 'applyPreset 捕获 rejection', /catch\s*\(/],
      ['applyPreset', 'S3-8', 'applyPreset 成功提示在保存成功之后', /r\.ok\s*===\s*false\)[\s\S]*?return[\s\S]*?已套用预设/],
      ['saveAsPreset', 'S3-9', 'saveAsPreset 捕获 rejection', /catch\s*\(/],
      ['saveService', 'S3-10', 'saveService 捕获 rejection', /catch\s*\(/],
      ['saveService', 'S3-11', 'saveService 失败时不关闭编辑器', /r\.ok\s*===\s*false\)[\s\S]*?return[\s\S]*?closeEditor/],
      ['deleteService', 'S3-12', 'deleteService 捕获 rejection', /catch\s*\(/],
      ['setActive', 'S3-13', 'setActive 捕获 rejection', /catch\s*\(/],
    ];
    for (const [fn, id, title, re] of checks) {
      const body = grab(fn);
      ok(id, title, !!body && re.test(body), body ? '函数已找到' : '未找到函数 ' + fn);
    }
  }

  // ============ 4. run-all 注释与实际一致 ============
  group('S4 run-all 数量一致性');
  {
    const src = fs.readFileSync(path.join(REPO, 'tests/run-all.js'), 'utf8');
    const m = src.match(/const files = \[([^\]]+)\]/);
    const count = m ? m[1].split(',').filter(s => s.trim()).length : 0;
    ok('S4-1', 'files 数组数量与注释无硬编码冲突',
      !/\d+\s*个测试文件/.test(src), '注释中若写死数字则易失配');
    ok('S4-2', '运行时输出实际文件数量', /files\.length/.test(src));
    ok('S4-3', 'files 数组非空', count > 0, '实际 ' + count + ' 个');
  }

  closeAllWatchers();
  await new Promise(r => setTimeout(r, 150));
  const s = summarize();
  console.log('\n---- 第十二部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败 ----');
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('ERR', e && e.stack); process.exit(1); });
