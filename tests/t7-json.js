// 第七部分:JSON 损坏行容错归档路径 + 语法核验
//   运行时部分:【直接测试生产代码】(真实 main.js)
//   语法部分:node --check(子进程)
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { group, ok, mkTmp, cleanupTmp, fakeJpeg, sleep, listFiles, summarize } = require('./common');
const { loadMain, waitBoot, setWallpaperBehavior, closeAllWatchers } = require('./harness');

const REPO = path.resolve(__dirname, '..');
const ESC = '\uFEFF';

async function mkEnv() {
  const root = mkTmp('acg-json-');
  const userData = path.join(root, 'userData');
  const pictures = path.join(root, 'Pictures');
  const wallDir = path.join(pictures, 'ACG_Wallpaper');
  const confDir = path.join(userData, 'config');
  fs.mkdirSync(confDir, { recursive: true });
  fs.mkdirSync(wallDir, { recursive: true });
  const loaded = loadMain({ userDataDir: userData, picturesDir: pictures, holdReady: false, singleInstanceLock: true });
  await waitBoot(loaded.state, 5000);
  const call = async (channel, ...args) => {
    const fn = loaded.state.ipcHandlers.get(channel);
    if (!fn) throw new Error('通道未注册: ' + channel);
    return await fn({}, ...args);
  };
  return { root, userData, pictures, wallDir, confDir, confFile: path.join(confDir, 'config.json'), ...loaded, call };
}
const readLines = (p) => fs.readFileSync(p, 'utf8').split('\n');

(async () => {
  // ---------- AA. archiveCurrent 对损坏行的容错 ----------
  group('AA 归档时损坏行容错');
  {
    const env = await mkEnv();
    const cur = path.join(env.wallDir, 'current.jpg');
    const histFile = path.join(env.wallDir, 'history.jsonl');
    const A = fakeJpeg(14000, 'AA-A');
    fs.writeFileSync(cur, A);
    const oldRecords = [
      // 带 BOM 首行(旧脚本产物)
      ESC + JSON.stringify({ file: 'current.jpg', time: 'bom-first', bytes: A.length }),
      // 损坏半行
      '{"file":"current.jpg","time":"torn',
      // 正常行(应被回写 histFile)
      JSON.stringify({ file: 'current.jpg', time: 'target', bytes: A.length }),
      // 尾部损坏
      '}{',
    ];
    fs.writeFileSync(histFile, oldRecords.join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(env.wallDir, 'hist_src_aa.jpg'), fakeJpeg(15000, 'AA-B'));
    setWallpaperBehavior(undefined);
    const r = await env.call('use-history', 'hist_src_aa.jpg');
    ok('AA1', 'history.jsonl 含 BOM+损坏行时 use-history 仍成功', r && r.ok === true, JSON.stringify(r));
    const lines = readLines(histFile).filter(Boolean);
    ok('AA2', '归档后损坏行原样保留(不被丢弃也不被"修复")', lines.some(l => l.includes('torn')) && lines.some(l => l === '}{'),
      '行数 ' + lines.length);
    const target = lines.map(l => { try { return JSON.parse(l.startsWith('\uFEFF') ? l.slice(1) : l); } catch { return null; } }).find(x => x && x.time === 'target');
    ok('AA3', '可解析的最新一条 current 记录被回写 histFile', !!target && /^hist_\d{8}_\d{6}/.test(String(target.histFile)), JSON.stringify(target));
    ok('AA4', '回写的 histFile 指向真实存在的归档文件', !!target && fs.existsSync(path.join(env.wallDir, target.histFile)), target && target.histFile);
    ok('AA5', '归档动作本身成功(current 已是新图)', fs.readFileSync(cur).equals(fakeJpeg(15000, 'AA-B')));
    // 回写时 stripBom 已剥离首部 BOM,整文件以无 BOM 重写 —— 这是预期行为(BOM 只是编码前缀,
    // 剥离后内容完全等价),真正要保证的是"首行记录本身不丢、字段不损坏"。
    const first = (() => { try { return JSON.parse(lines[0].startsWith('\uFEFF') ? lines[0].slice(1) : lines[0]); } catch { return null; } })();
    ok('AA6', '首行带 BOM 的记录在回写后内容完整不丢', !!first && first.time === 'bom-first' && first.bytes === A.length, JSON.stringify(first));
    ok('AA7', '观察项记录:回写会剥离首部 BOM 并整文件重排(内容等价,但属读-改-写)',
      lines[0].charCodeAt(0) !== 0xFEFF,
      '回写后首字符码 ' + lines[0].charCodeAt(0) + '(123=普通 "{" )');
  }

  // ---------- AB. healInterruptedTransaction 对损坏行的容错 ----------
  group('AB 自愈时损坏行容错');
  {
    const root = mkTmp('acg-heal3-');
    const userData = path.join(root, 'userData');
    const pictures = path.join(root, 'Pictures');
    const wallDir = path.join(pictures, 'ACG_Wallpaper');
    fs.mkdirSync(path.join(userData, 'config'), { recursive: true });
    fs.mkdirSync(wallDir, { recursive: true });
    const lost = fakeJpeg(23000, 'AB');
    fs.writeFileSync(path.join(wallDir, 'hist_20260101_070000.jpg'), lost);
    // history.jsonl:带 BOM 首行 + 损坏行 + 末尾带 histFile 的合法记录
    fs.writeFileSync(path.join(wallDir, 'history.jsonl'), [
      ESC + JSON.stringify({ file: 'current.jpg', time: 'bom', bytes: 1 }),
      '{"broken": ',
      JSON.stringify({ file: 'current.jpg', time: 'heal-target', bytes: lost.length, histFile: 'hist_20260101_070000.jpg' }),
    ].join('\n') + '\n', 'utf8');
    setWallpaperBehavior(undefined);
    const loaded = loadMain({ userDataDir: userData, picturesDir: pictures, holdReady: false, singleInstanceLock: true });
    await waitBoot(loaded.state, 5000);
    await sleep(300);
    ok('AB1', '含 BOM 与损坏行时自愈仍能从末条合法记录恢复', fs.existsSync(path.join(wallDir, 'current.jpg')));
    ok('AB2', '恢复内容与归档一致', fs.existsSync(path.join(wallDir, 'current.jpg')) && fs.readFileSync(path.join(wallDir, 'current.jpg')).equals(lost));
    ok('AB3', '自愈不改动 history.jsonl(含损坏行)', readLines(path.join(wallDir, 'history.jsonl')).filter(Boolean).length === 3,
      '行数 ' + readLines(path.join(wallDir, 'history.jsonl')).filter(Boolean).length);
    closeAllWatchers();
    await sleep(80);
  }

  // ---------- AC. use-history 元数据解析的损坏行容错 ----------
  group('AC 元数据解析损坏行容错');
  {
    const env = await mkEnv();
    const histFile = path.join(env.wallDir, 'history.jsonl');
    const src = fakeJpeg(34000, 'AC');
    fs.writeFileSync(path.join(env.wallDir, 'hist_20260101_080000.jpg'), src);
    fs.writeFileSync(histFile, [
      ESC + JSON.stringify({ file: 'current.jpg', source: 'script', title: 'BOM行', bytes: 1 }),
      '{oops',
      JSON.stringify({ file: 'current.jpg', source: 'ai', title: '精确命中', bytes: 34000, histFile: 'hist_20260101_080000.jpg' }),
      '}}}',
    ].join('\n') + '\n', 'utf8');
    setWallpaperBehavior(undefined);
    const r = await env.call('use-history', 'hist_20260101_080000.jpg');
    const rows = readLines(histFile).filter(Boolean);
    const last = (() => { try { return JSON.parse(rows[rows.length - 1]); } catch { return null; } })();
    ok('AC1', '损坏行不影响 use-history 成功', r && r.ok === true, JSON.stringify(r));
    ok('AC2', '新记录按 histFile 精确匹配到正确元数据', !!last && last.title === '精确命中' && last.source === 'ai', JSON.stringify(last));
    ok('AC3', '原损坏行未被删除(仅追加)', rows.some(l => l === '{oops') && rows.some(l => l === '}}}'), '行数 ' + rows.length);
  }

  // ---------- AD. 配置损坏时的读/写双语义 ----------
  // 读(get-config)必须降级以保证 UI 可用;写(save-config)必须中止以避免用默认值覆盖原文件。
  // 旧实现两者都走宽松读取,导致"改个开关就把 API Key 全冲掉",本轮修正。
  group('AD 配置损坏:读降级 / 写中止');
  {
    const env = await mkEnv();
    const broken = '{ "source": "ai", "services": [{ "id":"s1", "apiKey":"sk-MUST-KEEP" }], "broken": ';
    fs.writeFileSync(env.confFile, broken, 'utf8');

    const cfg = await env.call('get-config');
    ok('AD1', 'config.json 损坏时 get-config 回落到默认配置而非抛错',
      cfg && typeof cfg === 'object' && Array.isArray(cfg.services), JSON.stringify(Object.keys(cfg || {})));
    ok('AD2', '降级后有完整默认字段(界面不会白屏)', !!(cfg.schedule && cfg.history && cfg.lolicon && cfg.ai));

    // 关键:写入必须中止,且原文件逐字节不变
    const r2 = await env.call('save-config', 'source', 'lolicon');
    ok('AD3', '损坏时 save-config 返回失败而非静默成功', r2 && r2.ok === false, JSON.stringify(r2).slice(0, 140));
    ok('AD4', '失败信息指明配置损坏/解析失败', /损坏|解析/.test(String((r2 && r2.error) || '')), String((r2 && r2.error) || '').slice(0, 100));
    ok('AD5', '原配置文件逐字节未被覆盖', fs.readFileSync(env.confFile, 'utf8') === broken);
    ok('AD6', '用户 API Key 未丢失', /sk-MUST-KEEP/.test(fs.readFileSync(env.confFile, 'utf8')));

    // 修复方式:用户手工修好(或删除)文件后,写入应恢复
    fs.writeFileSync(env.confFile, JSON.stringify({ source: 'ai' }, null, 2), 'utf8');
    const r3 = await env.call('save-config', 'source', 'lolicon');
    ok('AD7', '文件修好后 save-config 恢复正常', r3 && r3.source === 'lolicon', JSON.stringify(r3).slice(0, 90));
  }

  // ---------- AE. 语法核验(node --check) ----------
  group('AE node --check 语法核验');
  {
    const files = [
      'src/main/main.js', 'src/main/preload.js', 'src/main/validate.js',
      'src/shared/text.js', 'src/shared/contracts.js', 'src/shared/defaults.js',
      // 阶段4 UI 重构:renderer.js 拆分为 12 个 js/ 文件,逐个做语法核验
      'src/renderer/js/core.js', 'src/renderer/js/ui.js', 'src/renderer/js/doubao.js',
      'src/renderer/js/tags.js', 'src/renderer/js/settings-shared.js',
      'src/renderer/js/pages/services.js', 'src/renderer/js/pages/library.js',
      'src/renderer/js/pages/creation.js', 'src/renderer/js/pages/workbench.js',
      'src/renderer/js/config.js', 'src/renderer/js/status.js', 'src/renderer/js/boot.js',
    ];
    for (const f of files) {
      let pass, msg;
      try { execFileSync(process.execPath, ['--check', path.join(REPO, f)], { stdio: 'pipe' }); pass = true; msg = 'ok'; }
      catch (e) { pass = false; msg = String(e.stderr || e.message).slice(0, 200); }
      ok('AE-' + path.basename(f), path.basename(f) + ' 语法检查通过', pass, msg);
    }
  }

  const s = summarize();
  console.log('\n---- 第七部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败 ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  closeAllWatchers();
  await sleep(120);
  cleanupTmp();
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); closeAllWatchers(); cleanupTmp(); process.exit(2); });
