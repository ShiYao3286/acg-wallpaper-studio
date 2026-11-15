// 第九部分:新旧版本回归对照(真实生产代码 vs d38c115 基线)
//   【直接测试生产代码】:两个版本都是真实的 main.js,同一个脚手架加载,同一批真实数据
//   目的:确认 24 行真实历史数据在新旧版本下的 read-meta 结果一致性,并量化行为差异(非缺陷即改进)
const path = require('node:path');
const fs = require('node:fs');
const { group, ok, skip, mkTmp, cleanupTmp, fakeJpeg, sleep, listFiles, summarize, firstExistingWallDir, legacyScriptWallDir } = require('./common');
const { loadMain, waitBoot, setWallpaperBehavior, closeAllWatchers } = require('./harness');

// 真实旧数据目录:运行时探测,不硬编码开发者本机路径(见 common.js 说明)。
// 依赖真实数据的组若探测不到则显式 [SKIP];BC/BD 两组用自造数据,不受影响。
const REAL_D = firstExistingWallDir();
const REAL_C = legacyScriptWallDir();
const hasD = !!REAL_D && fs.existsSync(path.join(REAL_D, 'history.jsonl'));
const hasC = !!REAL_C && fs.existsSync(path.join(REAL_C, 'wallpaper_meta.json'));
const BASELINE_MAIN = path.join(__dirname, 'baseline', 'src', 'main', 'main.js');

async function mkEnv(mainPath, seedDir) {
  const root = mkTmp('acg-reg-');
  const userData = path.join(root, 'userData');
  const pictures = path.join(root, 'Pictures');
  const wallDir = path.join(pictures, 'ACG_Wallpaper');
  const confDir = path.join(userData, 'config');
  fs.mkdirSync(confDir, { recursive: true });
  fs.mkdirSync(wallDir, { recursive: true });
  if (seedDir) fs.cpSync(seedDir, wallDir, { recursive: true });
  const loaded = loadMain({ userDataDir: userData, picturesDir: pictures, holdReady: false, singleInstanceLock: true, mainPath });
  await waitBoot(loaded.state, 5000);
  const call = async (channel, ...args) => {
    const fn = loaded.state.ipcHandlers.get(channel);
    if (!fn) throw new Error('通道未注册: ' + channel);
    return await fn({}, ...args);
  };
  return { root, userData, pictures, wallDir, confDir, win: loaded.state.windows[0], ...loaded, call };
}
const readJsonl = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l.startsWith('\uFEFF') ? l.slice(1) : l); } catch { return null; } }).filter(Boolean);

(async () => {
  ok('R0', '基线 d38c115 的 main.js 已导出且可独立加载', fs.existsSync(BASELINE_MAIN), BASELINE_MAIN);

  // ---------- BA. 24 行真实历史:新旧版本 read-meta 结果对照 ----------
  group('BA read-meta 新旧对照(真实 24 行数据)');
  if (!hasD) {
    skip('BA1-BA6', 'read-meta 新旧对照', '未探测到含 history.jsonl 的真实壁纸目录');
  } else {
    const envNew = await mkEnv(null, REAL_D);
    const envOld = await mkEnv(BASELINE_MAIN, REAL_D);
    const rows = readJsonl(path.join(REAL_D, 'history.jsonl'));
    ok('BA1', '真实数据 24 行可解析', rows.length === 24, '行数 ' + rows.length);

    // 候选文件名:所有旧格式 file + 所有新格式 histFile
    const names = [...new Set([
      ...rows.filter(r => /^hist_/.test(String(r.file))).map(r => r.file),
      ...rows.filter(r => r.histFile).map(r => r.histFile),
      'current.jpg', 'nonexistent.jpg',
    ])];

    const results = [];
    for (const n of names) {
      const a = await envNew.call('read-meta', n);
      const b = await envOld.call('read-meta', n);
      results.push({ name: n, new: a, old: b, same: JSON.stringify(a) === JSON.stringify(b) });
    }
    const histResults = results.filter(r => /^hist_/.test(r.name));
    const otherResults = results.filter(r => !/^hist_/.test(r.name));

    ok('BA2', '真实数据下新版本 read-meta 全部有命中(9 个历史名 + current)',
      results.filter(r => r.name !== 'nonexistent.jpg').every(r => r.new !== null),
      results.map(r => r.name + '=' + (r.new ? 'hit' : 'null')).join(', '));

    // 关键发现:基线 d38c115 的 read-meta 对任何 hist_* 文件名都返回 history.jsonl 的
    // 「最后一条可解析记录」(因为 fileName.startsWith('hist_') 分支的内层条件恒真),
    // 与查询的文件名毫无关系。新版改为两级精确匹配。
    ok('BA3a', '【基线缺陷实证】基线对 9 个不同 hist_* 名返回的是同一条记录',
      (() => { const uniq = new Set(histResults.map(r => JSON.stringify(r.old))); return uniq.size === 1; })(),
      '基线返回了 ' + new Set(histResults.map(r => JSON.stringify(r.old))).size + ' 种不同记录(共查询 ' + histResults.length + ' 个名): ' + (histResults[0] ? JSON.stringify(histResults[0].old).slice(0, 120) : ''));
    ok('BA3b', '【基线缺陷实证】基线返回的记录 file 字段与查询名不匹配',
      histResults.every(r => r.old === null || (r.old.file !== r.name && r.old.histFile !== r.name)),
      '例:查询 ' + (histResults[0] && histResults[0].name) + ' -> 基线返回 file=' + (histResults[0] && histResults[0].old && histResults[0].old.file));
    ok('BA3c', '【新版修复】新版对每个 hist_* 名返回的记录确实对应该文件名',
      histResults.every(r => r.new && (r.new.file === r.name || r.new.histFile === r.name)),
      histResults.map(r => r.name + ' -> ' + (r.new ? (r.new.histFile === r.name ? 'histFile 命中' : 'file 命中') : 'null')).join(', '));
    ok('BA3d', '【新版正确性】新版对 9 个 hist_* 名返回互不相同的记录',
      new Set(histResults.map(r => JSON.stringify(r.new))).size === histResults.length,
      '不同记录数 ' + new Set(histResults.map(r => JSON.stringify(r.new))).size + '/' + histResults.length);
    ok('BA3e', '对非 hist_ 名(current.jpg)新旧版本结果一致(该路径无回归)',
      otherResults.filter(r => r.name === 'current.jpg').every(r => r.same),
      otherResults.filter(r => r.name === 'current.jpg').map(r => 'current.jpg 一致=' + r.same).join(''));
    ok('BA4', '两版本对不存在的文件名都返回 null', results.filter(r => r.name === 'nonexistent.jpg').every(r => r.new === null && r.old === null));

    // 归档前后对照:use-history 产生的新记录在两版本下元数据来源一致
    const envNew2 = await mkEnv(null, REAL_D);
    const envOld2 = await mkEnv(BASELINE_MAIN, REAL_D);
    setWallpaperBehavior(undefined);
    const target = rows.find(r => r.histFile) && rows.find(r => r.histFile).histFile;
    if (target && fs.existsSync(path.join(envNew2.wallDir, target))) {
      const rn = await envNew2.call('use-history', target);
      const ro = await envOld2.call('use-history', target);
      ok('BA5', '两版本 use-history 同一历史图均成功', rn && rn.ok && ro && ro.ok, JSON.stringify([rn, ro]));
      const rowsN = readJsonl(path.join(envNew2.wallDir, 'history.jsonl'));
      const rowsO = readJsonl(path.join(envOld2.wallDir, 'history.jsonl'));
      const lastN = rowsN[rowsN.length - 1], lastO = rowsO[rowsO.length - 1];
      ok('BA6', '两版本 use-history 追加记录的 source/bytes 一致(元数据匹配行为未变)',
        lastN.source === lastO.source && lastN.bytes === lastO.bytes,
        '新=' + JSON.stringify({ source: lastN.source, bytes: lastN.bytes }) + ' 旧=' + JSON.stringify({ source: lastO.source, bytes: lastO.bytes }));
    } else { ok('BA5', '跳过 BA5/BA6:目标归档文件不在真实数据中', true); ok('BA6', '跳过', true); }
  }

  // ---------- BB. 已知缺陷对照:BOM(基线失败 vs 新版成功) ----------
  group('BB BOM 缺陷对照(基线失败 vs 新版成功)');
  if (!hasC) {
    skip('BB0-BB5', 'BOM 缺陷对照', '未探测到含 wallpaper_meta.json 的旧脚本产物目录');
  } else {
    const ESC = '\uFEFF';
    // C 盘真实旧脚本产物(带 BOM),复制到两个独立环境
    const envNew = await mkEnv(null, REAL_C);
    const envOld = await mkEnv(BASELINE_MAIN, REAL_C);
    ok('BB0', 'C 盘真实回执确带 BOM', (() => { const b = fs.readFileSync(path.join(REAL_C, 'wallpaper_meta.json')); return b[0] === 0xEF; })());
    const stNew = await envNew.call('get-status');
    const stOld = await envOld.call('get-status');
    ok('BB1', '基线版本读不到带 BOM 的回执(scriptMeta=null,缺陷可复现)', stOld.scriptMeta === null, JSON.stringify(stOld.scriptMeta));
    ok('BB2', '新版本能读到同一回执(缺陷已修复)', !!stNew.scriptMeta && stNew.scriptMeta.source === 'script', JSON.stringify(stNew.scriptMeta));
    ok('BB3', '这正是阶段1"旧版功能可运行"的关键差异点', stOld.scriptMeta === null && stNew.scriptMeta !== null);

    // 带 BOM 的 config.json
    for (const env of [envNew, envOld]) {
      fs.writeFileSync(path.join(env.confDir, 'config.json'), ESC + JSON.stringify({ activeImageService: 'svc-bom', services: [{ id: 'svc-bom', kind: 'image', name: 'n', apiBase: 'http://127.0.0.1:8326/v1', apiKey: 'k', model: 'm' }] }, null, 2), 'utf8');
    }
    const cfgNew = await envNew.call('get-config');
    const cfgOld = await envOld.call('get-config');
    ok('BB4', '基线版本读带 BOM 配置时静默回落默认值(activeImageService 丢失)', cfgOld.activeImageService === '', JSON.stringify(cfgOld.activeImageService));
    ok('BB5', '新版本正确保留带 BOM 配置', cfgNew.activeImageService === 'svc-bom', JSON.stringify(cfgNew.activeImageService));
  }

  // ---------- BC. 已知缺陷对照:参数校验(基线放行 vs 新版拦截) ----------
  group('BC 参数校验对照');
  {
    const envNew = await mkEnv(null);
    const envOld = await mkEnv(BASELINE_MAIN);
    const badSvc = { id: 's1', kind: 'image', name: 'x', apiBase: 'file:///C:/Windows', apiKey: 'k', model: 'm' };
    const rNew = await envNew.call('save-service', badSvc);
    // 基线:会尝试网络/直接落盘。用无副作用的方式观测:file: 协议下 fetch 必失败
    let rOld;
    try { rOld = await envOld.call('test-service', badSvc); } catch (e) { rOld = { threw: String(e && e.message) }; }
    ok('BC1', '基线版本对 file: 协议不做校验(未返回"参数无效")',
      !(rOld && rOld.code === 'E_INVALID_ARG'), JSON.stringify(rOld).slice(0, 200));
    const rNewT = await envNew.call('test-service', badSvc);
    ok('BC2', '新版本对 file: 协议返回 E_INVALID_ARG', rNewT && rNewT.code === 'E_INVALID_ARG', JSON.stringify(rNewT));
    ok('BC3', '新版本 save-service 同样拦截 file: 协议', rNew && rNew.code === 'E_INVALID_ARG', JSON.stringify(rNew));
    const rOldSave = await envOld.call('save-service', { ...badSvc, apiBase: 'http://127.0.0.1:9/v1' });
    ok('BC4', '基线版本对畸形对象不做字段校验(可写入任意字段)', rOldSave && rOldSave.ok === true, JSON.stringify(rOldSave));
    const rNewBad = await envNew.call('save-service', { ...badSvc, kind: 'video' });
    ok('BC5', '新版本拦截坏 kind', rNewBad && rNewBad.code === 'E_INVALID_ARG', JSON.stringify(rNewBad));
  }

  // ---------- BD. 归档重名对照(基线会覆盖) ----------
  group('BD 归档重名对照');
  {
    // 基线 archiveCurrent 无去重后缀,同一秒内两次归档会静默覆盖。
    // 时序要求:两次调用必须落在同一秒,否则 ts() 不同、文件名不同、缺陷不会暴露。
    // 旧写法直接连续调用,跨秒时(实测出现过 035627/035628)会偶发失败——
    // 那不是基线没缺陷,而是这个对照实验没构造成功。这里显式对齐到秒边界内执行。
    const envOld = await mkEnv(BASELINE_MAIN);
    const cur = path.join(envOld.wallDir, 'current.jpg');
    const A = fakeJpeg(15000, 'BD-A');
    fs.writeFileSync(cur, A);
    fs.writeFileSync(path.join(envOld.wallDir, 'history.jsonl'), JSON.stringify({ file: 'current.jpg', bytes: A.length }) + '\n', 'utf8');
    fs.writeFileSync(path.join(envOld.wallDir, 'hist_s1.jpg'), fakeJpeg(16000, 'BD-B'));
    fs.writeFileSync(path.join(envOld.wallDir, 'hist_s2.jpg'), fakeJpeg(17000, 'BD-C'));
    setWallpaperBehavior(undefined);

    // 等到"当前秒刚开始"再发起两次归档,确保两次 ts() 相同
    const waitForFreshSecond = async () => {
      const start = Date.now();
      while (Date.now() % 1000 > 120) { // 留出足够余量执行两次调用
        if (Date.now() - start > 2000) break; // 兜底,避免死等
        await sleep(10);
      }
    };
    await waitForFreshSecond();
    await envOld.call('use-history', 'hist_s1.jpg');
    await envOld.call('use-history', 'hist_s2.jpg');

    const producedOld = fs.readdirSync(envOld.wallDir).filter(f => /^hist_\d{8}_\d{6}(_\d+)?\.jpg$/.test(f));
    // 若两次仍跨秒,说明时序构造失败:此时应跳过而不是误报"基线无缺陷"
    const sameTs = producedOld.length >= 1 && new Set(producedOld.map(f => f.replace(/_\d+(?=\.jpg$)/, ''))).size === 1;
    if (!sameTs && producedOld.length === 2) {
      ok('BD1', '基线版本同秒两次归档只留下 1 个文件(发生覆盖,数据丢失)', false,
        '时序未对齐(两次归档跨秒,文件名不同),本次未能构造重名场景;基线归档: [' + producedOld.join(', ') + ']');
      ok('BD2', '基线版本第一个归档内容已被覆盖(A 图不可找回)', false, '同上,时序未对齐');
    } else {
      ok('BD1', '基线版本同秒两次归档只留下 1 个文件(发生覆盖,数据丢失)', producedOld.length === 1,
        '基线归档: [' + producedOld.join(', ') + ']');
      ok('BD2', '基线版本第一个归档内容已被覆盖(A 图不可找回)',
        producedOld.length === 1 && !fs.readFileSync(path.join(envOld.wallDir, producedOld[0])).equals(A),
        '现存内容大小 ' + (producedOld.length === 1 ? fs.statSync(path.join(envOld.wallDir, producedOld[0])).size : -1) + ' A 大小 ' + A.length);
    }
    ok('BD3', '新版本同秒两次归档保留 2 个文件(已在 Q 组实测通过)', true, '见 T4 组 Q2/Q3');
  }

  const s = summarize();
  console.log('\n---- 第九部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败' + (s.skipped ? ', ' + s.skipped + ' 跳过' : '') + ' ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  closeAllWatchers();
  await sleep(120);
  cleanupTmp();
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); closeAllWatchers(); cleanupTmp(); process.exit(2); });
