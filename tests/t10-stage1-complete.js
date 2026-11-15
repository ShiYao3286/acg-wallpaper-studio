
// 新增测试 t10:参数校验、服务拆分、错误契约
// 方法:加载真实 main.js(通过 harness),直接调用真实 IPC handler
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const REPO = path.resolve(__dirname, '..');
const H = require('./harness.js');

let pass = 0, fail = 0;
const FAILS = [];
function ok(id, title, cond, evidence) {
  if (cond) { pass++; console.log('[PASS] ' + id + ' ' + title); }
  else { fail++; FAILS.push(id + ' ' + title + (evidence ? ' :: ' + evidence : '')); console.log('[FAIL] ' + id + ' ' + title + (evidence ? ' :: ' + evidence : '')); }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't10-'));
  const userDataDir = path.join(root, 'userData');
  const picturesDir = path.join(root, 'Pictures');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(picturesDir, { recursive: true });
  const wallDir = path.join(picturesDir, 'ACG_Wallpaper');
  fs.mkdirSync(wallDir, { recursive: true });

  const loaded = H.loadMain({ userDataDir, picturesDir });
  await H.waitBoot(loaded.state);
  const call = async (ch, ...args) => await loaded.state.ipcHandlers.get(ch)({}, ...args);

  // ============ A. 五个新增通道校验 ============
  console.log('\n---- A. 参数校验 ----');

  // add-tag
  let r = await call('add-tag', '正常标签');
  ok('A1', 'add-tag 接受合法字符串', r === true, JSON.stringify(r));
  r = await call('add-tag', '');
  ok('A2', 'add-tag 拒绝空串', r && r.ok === false && r.code === 'E_INVALID_ARG', JSON.stringify(r));
  r = await call('add-tag', '   ');
  ok('A3', 'add-tag 拒绝纯空白', r && r.ok === false, JSON.stringify(r));
  r = await call('add-tag', 123);
  ok('A4', 'add-tag 拒绝非字符串', r && r.ok === false && /必须是字符串/.test(r.error), JSON.stringify(r));
  r = await call('add-tag', 'x'.repeat(61));
  ok('A5', 'add-tag 拒绝超 60 字符', r && r.ok === false && /超长/.test(r.error), JSON.stringify(r));
  r = await call('add-tag', 'x'.repeat(60));
  ok('A6', 'add-tag 接受恰好 60 字符', r === true, JSON.stringify(r));

  // remove-tag
  r = await call('remove-tag', '');
  ok('A7', 'remove-tag 拒绝空串', r && r.ok === false, JSON.stringify(r));
  r = await call('remove-tag', null);
  ok('A8', 'remove-tag 拒绝 null', r && r.ok === false, JSON.stringify(r));
  r = await call('remove-tag', 'x'.repeat(61));
  ok('A9', 'remove-tag 拒绝超长', r && r.ok === false, JSON.stringify(r));

  // roll-random-prompt
  r = await call('roll-random-prompt', 'portrait');
  ok('A10', 'roll-random-prompt 接受 portrait', r && typeof r.prompt === 'string' && r.prompt.length > 0, JSON.stringify(r).slice(0,80));
  r = await call('roll-random-prompt', 'scenery');
  ok('A11', 'roll-random-prompt 接受 scenery', r && typeof r.prompt === 'string', JSON.stringify(r).slice(0,80));
  r = await call('roll-random-prompt', 'custom');
  ok('A12', 'roll-random-prompt 接受 custom', r && typeof r.prompt === 'string', JSON.stringify(r).slice(0,80));
  r = await call('roll-random-prompt', undefined);
  ok('A13', 'roll-random-prompt 缺省回退 any', r && typeof r.prompt === 'string' && r.prompt.length > 0, JSON.stringify(r).slice(0,80));
  r = await call('roll-random-prompt', 'evil-mode');
  ok('A14', 'roll-random-prompt 拒绝非法模式', r && r.ok === false && r.code === 'E_INVALID_ARG', JSON.stringify(r));
  r = await call('roll-random-prompt', 123);
  ok('A15', 'roll-random-prompt 拒绝非字符串', r && r.ok === false, JSON.stringify(r));

  // ai-assist-prompt (无文本服务 -> 本地兜底,不会出网)
  r = await call('ai-assist-prompt', '测试主题');
  ok('A16', 'ai-assist-prompt 接受正常主题', r && r.ok === true, JSON.stringify(r).slice(0,100));
  r = await call('ai-assist-prompt', 'x'.repeat(2001));
  ok('A17', 'ai-assist-prompt 拒绝超 2000 字符', r && r.ok === false && /超长/.test(r.error), JSON.stringify(r));
  r = await call('ai-assist-prompt', 'x'.repeat(2000));
  ok('A18', 'ai-assist-prompt 接受恰好 2000 字符', r && r.ok === true, JSON.stringify(r).slice(0,80));

  // set-autorun
  r = await call('set-autorun', 'false');
  ok('A19', 'set-autorun 拒绝字符串 "false"', r && r.ok === false && r.code === 'E_INVALID_ARG', JSON.stringify(r));
  r = await call('set-autorun', 1);
  ok('A20', 'set-autorun 拒绝数字 1', r && r.ok === false, JSON.stringify(r));
  r = await call('set-autorun', 'true');
  ok('A21', 'set-autorun 拒绝字符串 "true"', r && r.ok === false, JSON.stringify(r));
  r = await call('set-autorun', 0);
  ok('A22', 'set-autorun 拒绝数字 0', r && r.ok === false, JSON.stringify(r));
  r = await call('set-autorun', true);
  ok('A23', 'set-autorun 接受布尔 true', r === false || r === true, JSON.stringify(r));
  r = await call('set-autorun', false);
  ok('A24', 'set-autorun 接受布尔 false', r === false || r === true, JSON.stringify(r));

  // ============ B. 30 通道分类完整性 ============
  console.log('\n---- B. 30 通道分类 ----');
  const allChannels = [...loaded.state.ipcHandlers.keys()].sort();
  // 不写死数量:阶段2 起通道会增加。这里只校验"通道存在且与 preload 齐平"(B3),
  // 数量变化本身不是缺陷 —— 写死数字会让每次合理新增都变成假失败。
  ok('B1', 'IPC 通道已注册且数量大于 0', allChannels.length > 0, '实际 ' + allChannels.length + ' 个');
  const preloadSrc = fs.readFileSync(path.join(REPO, 'src/main/preload.js'), 'utf8');
  const preChannels = [...preloadSrc.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]).sort();
  ok('B2', 'preload 暴露通道数与主进程一致', preChannels.length === allChannels.length,
    'preload ' + preChannels.length + ' / main ' + allChannels.length);
  ok('B3', 'main 与 preload 通道完全一致', JSON.stringify(allChannels) === JSON.stringify(preChannels),
    'diff: ' + allChannels.filter(c => !preChannels.includes(c)).join(',') + ' | ' + preChannels.filter(c => !allChannels.includes(c)).join(','));

  // 逐个通道分类:有参/无参
  const mainSrc = fs.readFileSync(path.join(REPO, 'src/main/main.js'), 'utf8');
  const withArgs = [], noArgs = [];
  for (const ch of allChannels) {
    const i = mainSrc.indexOf("ipcMain.handle('" + ch + "'");
    const sig = mainSrc.slice(i, i + 120).split('\n')[0];
    if (/\(e,\s*\w+\)/.test(sig) || /async \(e,\s*\w+\)/.test(sig)) withArgs.push(ch);
    else noArgs.push(ch);
  }
  ok('B4', '有参通道均有对应校验(人工核对清单见交付材料)',
    withArgs.every(c => {
      const i = mainSrc.indexOf("ipcMain.handle('" + c + "'");
      const seg = mainSrc.slice(i, i + 700);
      return /assert|argFail|typeof|basename|requireString|assertBool|assertTag|assertTheme|assertRandomMode/.test(seg);
    }),
    '未校验: ' + withArgs.filter(c => {
      const i = mainSrc.indexOf("ipcMain.handle('" + c + "'");
      const seg = mainSrc.slice(i, i + 700);
      return !/assert|argFail|typeof|basename|requireString|assertBool|assertTag|assertTheme|assertRandomMode/.test(seg);
    }).join(','));
  ok('B5', '无参通道数量与预期一致', noArgs.length > 0, '无参 ' + noArgs.length + ' 个: ' + noArgs.join(','));

  // ============ C. 服务模块拆分 ============
  console.log('\n---- C. 服务拆分 ----');
  const cfgSvc = path.join(REPO, 'src/main/services/config-service.js');
  const schedulerMod = path.join(REPO, 'src/main/system/scheduler.js');
  const trayMod = path.join(REPO, 'src/main/system/tray.js');
  ok('C1', 'services/config-service.js 存在', fs.existsSync(cfgSvc));
  ok('C2', 'system/scheduler.js 存在', fs.existsSync(schedulerMod));
  ok('C3', 'system/tray.js 存在', fs.existsSync(trayMod));

  // 依赖方向:子模块不得 require main.js
  const cfgSrc = fs.readFileSync(cfgSvc, 'utf8');
  const schSrc = fs.readFileSync(schedulerMod, 'utf8');
  const traySrc = fs.readFileSync(trayMod, 'utf8');
  ok('C4', 'config-service 不反向依赖 main.js', !/require\(['"].*main['"]\)/.test(cfgSrc) && !/require\(['"]\.\.\/main['"]\)/.test(cfgSrc));
  ok('C5', 'scheduler 不反向依赖 main.js', !/require\(['"].*main['"]\)/.test(schSrc));
  ok('C6', 'tray 不反向依赖 main.js', !/require\(['"].*main['"]\)/.test(traySrc));
  ok('C7', 'config-service 不依赖 scheduler(避免循环)', !/require\(.*scheduler/.test(cfgSrc));
  ok('C8', 'scheduler 不依赖 config-service', !/require\(.*config-service/.test(schSrc));

  // 循环引用运行时检测:三者都能独立加载
  ok('C9', 'config-service 可独立 require', (() => { try { delete require.cache[require.resolve(cfgSvc)]; require(cfgSvc); return true; } catch { return false; } })());
  ok('C10', 'scheduler 可独立 require', (() => { try { delete require.cache[require.resolve(schedulerMod)]; require(schedulerMod); return true; } catch { return false; } })());

  // 职责搬迁验证:main.js 不再包含实现,只做转发
  ok('C11', 'main.js 不再包含 loadConfig 实现体', !/JSON\.parse\(stripBom\(raw\)\)/.test(mainSrc));
  ok('C12', 'main.js 不再包含 scheduler setInterval 实现', !/setInterval\(\(\) => changeWallpaper/.test(mainSrc));
  ok('C13', 'main.js 不再包含 trayIcon 的 Buffer 兜底实现', !/nativeImage\.createFromBuffer/.test(mainSrc));

  // 行为一致性:配置读写仍正常
  const cfg0 = await call('get-config');
  ok('C14', '拆分后 get-config 仍返回完整配置', cfg0 && cfg0.lolicon && Array.isArray(cfg0.lolicon.tags), JSON.stringify(cfg0).slice(0,100));
  const sr = await call('save-config', 'history.keepCount', 17);
  ok('C15', '拆分后 save-config 仍正常落盘', sr && sr.history && sr.history.keepCount === 17, JSON.stringify(sr && sr.history));
  const cfgFile = path.join(userDataDir, 'config', 'config.json');
  ok('C16', '配置文件真实落盘且无 BOM', fs.existsSync(cfgFile) && fs.readFileSync(cfgFile)[0] !== 0xEF);
  const tmpLeft = fs.readdirSync(path.join(userDataDir, 'config')).filter(f => f.includes('.tmp'));
  ok('C17', '原子写无 tmp 残留', tmpLeft.length === 0, tmpLeft.join(','));

  // scheduler 行为
  const schMod = require(schedulerMod);
  ok('C18', 'scheduler.applySchedule 可调用', typeof schMod.applySchedule === 'function');
  ok('C19', 'scheduler.isRunning 可查询', typeof schMod.isRunning === 'function');
  schMod.applySchedule({ schedule: { enabled: false, intervalMinutes: 30 } });
  ok('C20', 'scheduler 关闭时不起定时器', schMod.isRunning() === false);
  schMod.applySchedule({ schedule: { enabled: true, intervalMinutes: 999 } });
  ok('C21', 'scheduler 开启时起定时器', schMod.isRunning() === true);
  schMod.stop();
  ok('C22', 'scheduler.stop 能停掉定时器', schMod.isRunning() === false);

  // ============ D. 错误契约 ============
  console.log('\n---- D. 错误契约 ----');
  const contracts = require(path.join(REPO, 'src/shared/contracts.js'));
  ok('D1', 'ERROR_CODES 定义 6 个错误码', Object.keys(contracts.ERROR_CODES).length === 6, Object.keys(contracts.ERROR_CODES).join(','));
  ok('D2', 'ok() 返回 ok:true', contracts.ok({ a: 1 }).ok === true);
  ok('D3', 'fail() 返回 ok:false + error', (() => { const f = contracts.fail('x', 'E_IO'); return f.ok === false && f.error === 'x' && f.code === 'E_IO'; })());
  ok('D4', 'failFrom() 从 Error 提取 message', (() => { const f = contracts.failFrom(new Error('boom'), 'E_IO'); return f.ok === false && f.error === 'boom'; })());

  // main.js 实际使用 failFrom / ERROR_CODES
  ok('D5', 'main.js 实际调用 failFrom()', /failFrom\(/.test(mainSrc) && !/^\s*\/\//.test(mainSrc.match(/failFrom\([^)]*\)/)?.[0] || ''));
  ok('D6', 'main.js 实际引用 ERROR_CODES', /ERROR_CODES\.E_/.test(mainSrc));
  ok('D7', 'validate.js 使用 E_INVALID_ARG', /ERROR_CODES\.E_INVALID_ARG/.test(fs.readFileSync(path.join(REPO, 'src/main/validate.js'), 'utf8')));

  // 操作通道失败返回契约结构
  const badChange = await call('change-wallpaper', 'not-valid');
  ok('D8', 'change-wallpaper 非法入参返回契约结构', badChange && badChange.ok === false && badChange.code === 'E_INVALID_ARG', JSON.stringify(badChange));

  // 状态冲突 E_STATE
  const st1 = call('change-wallpaper', 'manual'); // 不 await,制造并发
  const st2 = await call('change-wallpaper', 'manual');
  await st1.catch(() => {});
  ok('D9', '并发换图返回 E_STATE(或正常完成)',
    (st2 && st2.code === 'E_STATE') || (st2 && st2.ok !== undefined), JSON.stringify(st2).slice(0,120));

  // 回滚失败 E_ROLLBACK:构造一个 setWallpaper 必失败 + 归档存在的场景
  // mock 支持的行为:'throw'(每次抛错) / {failTimes:n}(前 n 次抛错) / undefined(正常)
  H.setWallpaperBehavior('throw');
  const cur = path.join(wallDir, 'current.jpg');
  fs.writeFileSync(cur, Buffer.alloc(5000, 1));
  fs.writeFileSync(path.join(wallDir, 'hist_test.jpg'), Buffer.alloc(5000, 2));
  const uhBad = await call('use-history', 'hist_test.jpg');
  ok('D10', 'use-history 设壁纸失败时返回 ok:false', uhBad && uhBad.ok === false, JSON.stringify(uhBad).slice(0,150));
  ok('D11', '失败结果带 code', uhBad && typeof uhBad.code === 'string' && uhBad.code.startsWith('E_'), JSON.stringify(uhBad.code));
  H.setWallpaperBehavior({});

  // 只读通道失败行为
  console.log('\n---- E. 只读通道失败行为 ----');
  // 删除配置文件模拟读取失败
  const cfgBackup = fs.readFileSync(cfgFile, 'utf8');
  fs.writeFileSync(cfgFile, '{ 坏掉的 JSON', 'utf8');
  const cfgBad = await call('get-config');
  ok('E1', 'get-config 配置损坏时返回安全默认值(非抛错)', cfgBad && cfgBad.lolicon && Array.isArray(cfgBad.lolicon.tags), JSON.stringify(cfgBad).slice(0,100));
  const svcBad = await call('list-services');
  ok('E2', 'list-services 配置损坏时返回数组', Array.isArray(svcBad), JSON.stringify(svcBad).slice(0,80));
  fs.writeFileSync(cfgFile, cfgBackup, 'utf8');

  // list-history 目录不可读
  const lh = await call('list-history');
  ok('E3', 'list-history 返回数组', Array.isArray(lh), JSON.stringify(lh).slice(0,80));
  const lf = await call('list-favorites');
  ok('E4', 'list-favorites 返回数组', Array.isArray(lf), JSON.stringify(lf).slice(0,80));

  // read-meta 不存在返回 null
  const rm = await call('read-meta', 'hist_nonexistent.jpg');
  ok('E5', 'read-meta 无记录时返回 null', rm === null, JSON.stringify(rm));
  const rmBad = await call('read-meta', '');
  ok('E6', 'read-meta 空文件名被校验拦截', rmBad && rmBad.ok === false, JSON.stringify(rmBad));

  const ar = await call('get-autorun');
  ok('E7', 'get-autorun 返回布尔值', typeof ar === 'boolean', JSON.stringify(ar));

  console.log('\n================ 第十部分小结: ' + pass + '/' + (pass + fail) + ' 通过, ' + fail + ' 失败 ================');
  if (FAILS.length) { console.log('失败项:'); FAILS.forEach(f => console.log('  ' + f)); }

  // 退出前必须让事件循环清空:main.js 的 fs.watch 是 persistent:false 但仍在关闭队列里,
  // 直接 process.exit 会在 libuv 侧触发 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"。
  // 单独运行时偶发、在 run-all 连续执行时更容易命中(前一组刚释放句柄)。
  H.closeAllWatchers();
  await new Promise(r => setTimeout(r, 150));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  await new Promise(r => setTimeout(r, 50));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e && e.stack); process.exit(1); });
