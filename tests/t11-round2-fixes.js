// 第十一部分:第二轮审核修复的回归测试
//   【直接测试生产代码】:通过 harness 加载真实 main.js / 直接 require 真实模块
//   覆盖:1) config-service 配置覆盖防护  2) save-config 复合字段校验
//         3) renderer 失败反馈(静态核验) 4) assertTheme 严格校验
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { group, ok, sleep, summarize } = require('./common');
const { loadMain, waitBoot, closeAllWatchers } = require('./harness');

const REPO = path.resolve(__dirname, '..');
const CFG_SVC = path.join(REPO, 'src/main/services/config-service.js');

// 独立加载一份 config-service(不经过 electron),验证读/写双语义
function freshCfgSvc(userDataDir) {
  delete require.cache[require.resolve(CFG_SVC)];
  const cs = require(CFG_SVC);
  cs.init({ userDataDir });
  return cs;
}

async function mkEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-r2-'));
  const userData = path.join(root, 'userData');
  const pictures = path.join(root, 'Pictures');
  const wallDir = path.join(pictures, 'ACG_Wallpaper');
  const confDir = path.join(userData, 'config');
  fs.mkdirSync(confDir, { recursive: true });
  fs.mkdirSync(wallDir, { recursive: true });
  const loaded = loadMain({ userDataDir: userData, picturesDir: pictures });
  await waitBoot(loaded.state, 5000);
  const call = async (channel, ...args) => {
    const fn = loaded.state.ipcHandlers.get(channel);
    if (!fn) throw new Error('通道未注册: ' + channel);
    return await fn({}, ...args);
  };
  return { root, userData, pictures, wallDir, confDir, confFile: path.join(confDir, 'config.json'), ...loaded, call };
}

(async () => {
  // ============ 1. config-service 配置覆盖防护 ============
  group('R1 配置覆盖防护(config-service 读/写双语义)');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    const userData = path.join(root, 'userData');
    const cd = path.join(userData, 'config');
    fs.mkdirSync(cd, { recursive: true });
    const cf = path.join(cd, 'config.json');
    const cs = freshCfgSvc(userData);

    // 1a 首次运行(文件不存在)允许默认配置
    const cfg0 = await cs.loadConfig();
    ok('R1-1', '文件不存在时 loadConfig 返回默认配置', cfg0.source === 'lolicon' && Array.isArray(cfg0.services));
    const saved0 = await cs.saveConfig({ schedule: { intervalMinutes: 45 } });
    ok('R1-2', '文件不存在时 saveConfig 正常创建', saved0.schedule.intervalMinutes === 45 && fs.existsSync(cf));

    // 1b JSON 损坏:读降级、写中止、原文件不动
    const broken = '{ "source":"ai", "services":[{"id":"s1","apiKey":"sk-MUST-KEEP"}], "broken": ';
    fs.writeFileSync(cf, broken, 'utf8');
    const cfgBroken = await cs.loadConfig();
    ok('R1-3', 'JSON 损坏时 loadConfig 仍降级返回默认(UI 可用)', cfgBroken.source === 'lolicon' && Array.isArray(cfgBroken.services));

    let threw = false, emsg = '';
    try { await cs.saveConfig({ schedule: { intervalMinutes: 99 } }); } catch (e) { threw = true; emsg = e.message; }
    ok('R1-4', 'JSON 损坏时 saveConfig 抛错中止', threw, emsg.slice(0, 70));
    ok('R1-5', '中止原因指明解析失败', /损坏|解析/.test(emsg), emsg.slice(0, 70));
    ok('R1-6', '原配置文件逐字节未被覆盖', fs.readFileSync(cf, 'utf8') === broken);
    ok('R1-7', '用户 API Key 仍在文件中', /sk-MUST-KEEP/.test(fs.readFileSync(cf, 'utf8')));

    // 1c 读取异常(用目录占住文件路径模拟)必须上报
    fs.rmSync(cf);
    fs.mkdirSync(cf, { recursive: true });
    let threw2 = false, e2 = '';
    try { await cs.saveConfig({ schedule: { intervalMinutes: 1 } }); } catch (e) { threw2 = true; e2 = e.message; }
    ok('R1-8', '读取异常时 saveConfig 中止', threw2, e2.slice(0, 70));
    ok('R1-9', '中止原因指明读取失败', /读取配置失败/.test(e2), e2.slice(0, 70));
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ============ 2. save-config 复合字段校验 ============
  group('R2 save-config 复合字段校验');
  {
    const env = await mkEnv();
    const readCfg = () => JSON.parse(fs.readFileSync(env.confFile, 'utf8'));

    // 2a 整数组必须使用断言返回值(__proto__ 被剔除)
    const polluted = JSON.parse('[{"id":"s1","kind":"image","name":"n","apiBase":"http://x.com","apiKey":"k","model":"m","__proto__":{"hacked":true}}]');
    const r1 = await env.call('save-config', 'services', polluted);
    ok('R2-1', '整数组保存成功', r1 && r1.ok !== false, JSON.stringify(r1).slice(0, 80));
    ok('R2-2', '断言返回值生效:__proto__ 未落盘', !('hacked' in (readCfg().services[0] || {})), JSON.stringify(Object.keys(readCfg().services[0] || {})));
    ok('R2-3', 'Object.prototype 未被污染', !({}).hacked);

    // 2b 点路径逐字段校验
    await env.call('save-config', 'services', [{ id: 's3', kind: 'image', name: 'n', apiBase: 'http://x.com', apiKey: 'k', model: 'm' }]);
    const badField = await env.call('save-config', 'services.0.kind', 'evil');
    ok('R2-4', 'services.0.kind 非法值被拒', badField && badField.code === 'E_INVALID_ARG', JSON.stringify(badField).slice(0, 90));
    const badProto = await env.call('save-config', 'services.0.__proto__', 'x');
    ok('R2-5', 'services.0.__proto__ 被拒', badProto && badProto.ok === false, JSON.stringify(badProto).slice(0, 90));
    const unknown = await env.call('save-config', 'services.0.unknownField', 'x');
    ok('R2-6', '未列入白名单的服务字段被拒', unknown && unknown.ok === false && /不允许单独修改/.test(unknown.error || ''), JSON.stringify(unknown).slice(0, 100));
    const badKeyLen = await env.call('save-config', 'services.0.apiKey', 'y'.repeat(600));
    ok('R2-7', 'services.0.apiKey 超长被拒', badKeyLen && badKeyLen.ok === false, JSON.stringify(badKeyLen).slice(0, 90));

    // 2c 预设通道
    const badPreset = await env.call('save-config', 'promptPresets', [{ id: 'p1', name: 'n' }]);
    ok('R2-8', '预设数组缺 prompt 被拒', badPreset && badPreset.code === 'E_INVALID_ARG', JSON.stringify(badPreset).slice(0, 90));
    const badPresetLong = await env.call('save-config', 'promptPresets.0.prompt', 'x'.repeat(9000));
    ok('R2-9', '预设点路径超长 prompt 被拒', badPresetLong && badPresetLong.ok === false, JSON.stringify(badPresetLong).slice(0, 90));
    const badPresetField = await env.call('save-config', 'promptPresets.0.unknown', 'x');
    ok('R2-10', '预设未知字段被拒', badPresetField && badPresetField.ok === false, JSON.stringify(badPresetField).slice(0, 90));

    // 2d 正常调用不被破坏
    const okScalar = await env.call('save-config', 'history.keepCount', 42);
    ok('R2-11', '普通标量保存正常', okScalar && okScalar.history && okScalar.history.keepCount === 42);
    const okArr = await env.call('save-config', 'gameCheck.processes', ['a.exe', 'b.exe']);
    ok('R2-12', '普通数组保存正常', okArr && Array.isArray(okArr.gameCheck.processes) && okArr.gameCheck.processes.length === 2);
    const okNested = await env.call('save-config', 'ai.prompt', '测试提示词');
    ok('R2-13', '嵌套点路径正常', okNested && okNested.ai && okNested.ai.prompt === '测试提示词');
    const okField = await env.call('save-config', 'services.0.apiBase', 'https://api.deepseek.com/v1');
    ok('R2-14', '合法服务点路径修改通过', okField && okField.ok !== false);
    ok('R2-15', '合法值已落盘', readCfg().services[0].apiBase === 'https://api.deepseek.com/v1');
    fs.rmSync(env.root, { recursive: true, force: true });
  }

  // ============ 3. save-config 异常不穿透 IPC ============
  group('R3 save-config 异常转契约结构');
  {
    const env = await mkEnv();
    const broken = '{ "source": "ai", "broken": ';
    fs.writeFileSync(env.confFile, broken, 'utf8');
    let leaked = false, res = null;
    try { res = await env.call('save-config', 'source', 'lolicon'); } catch { leaked = true; }
    ok('R3-1', '异常不穿透 IPC(不 reject)', !leaked, 'leaked=' + leaked);
    ok('R3-2', '返回契约结构 ok:false', res && res.ok === false, JSON.stringify(res).slice(0, 120));
    ok('R3-3', '带错误码 E_STATE(配置损坏属状态冲突)', res && res.code === 'E_STATE', JSON.stringify(res && res.code));
    ok('R3-4', '带 configAborted 标记便于上层区分', res && res.configAborted === true, JSON.stringify(res && res.configAborted));
    ok('R3-5', '原配置仍未被覆盖', fs.readFileSync(env.confFile, 'utf8') === broken);
    fs.rmSync(env.root, { recursive: true, force: true });
  }

  // ============ 4. assertTheme 严格校验 ============
  group('R4 assertTheme 严格字符串校验');
  {
    const env = await mkEnv();
    const r1 = await env.call('ai-assist-prompt', '');
    ok('R4-1', '空字符串通过(无主题应由调用方传 "")', r1 && r1.ok === true, JSON.stringify(r1).slice(0, 80));
    const r2 = await env.call('ai-assist-prompt', '正常主题');
    ok('R4-2', '正常主题通过', r2 && r2.ok === true, JSON.stringify(r2).slice(0, 80));
    const r3 = await env.call('ai-assist-prompt', null);
    ok('R4-3', 'null 被拒(不再隐式转空串)', r3 && r3.code === 'E_INVALID_ARG', JSON.stringify(r3).slice(0, 90));
    const r4 = await env.call('ai-assist-prompt', undefined);
    ok('R4-4', 'undefined 被拒', r4 && r4.code === 'E_INVALID_ARG', JSON.stringify(r4).slice(0, 90));
    const r5 = await env.call('ai-assist-prompt', 123);
    ok('R4-5', '数字被拒', r5 && r5.ok === false, JSON.stringify(r5).slice(0, 90));
    const r6 = await env.call('ai-assist-prompt', 'x'.repeat(2001));
    ok('R4-6', '超 2000 被拒', r6 && r6.ok === false && /超长/.test(r6.error), JSON.stringify(r6).slice(0, 90));
    const r7 = await env.call('ai-assist-prompt', 'x'.repeat(2000));
    ok('R4-7', '恰好 2000 通过', r7 && r7.ok === true, JSON.stringify(r7).slice(0, 80));
    fs.rmSync(env.root, { recursive: true, force: true });
  }

  // ============ 5. Renderer 失败反馈(静态核验) ============
  group('R5 Renderer 失败反馈(静态核验)');
  {
    const renderer = fs.readFileSync(path.join(REPO, 'src/renderer/renderer.js'), 'utf8');
    // saveGameProcs 必须检查返回值
    const m1 = renderer.match(/async function saveGameProcs[\s\S]{0,400}?\n\}/);
    ok('R5-1', 'saveGameProcs 检查 saveConfig 返回值', !!m1 && /r\.ok\s*===?\s*false/.test(m1[0]), m1 ? '已检查' : '未找到函数');
    ok('R5-2', 'saveGameProcs 失败时提示失败而非"已保存"', !!m1 && /保存失败/.test(m1[0]));
    // toggleAutoRun 必须回滚 UI
    const m2 = renderer.match(/async function toggleAutoRun[\s\S]{0,700}?\n\}/);
    ok('R5-3', 'toggleAutoRun 检查 setAutoRun 返回值', !!m2 && /r\.ok\s*===?\s*false/.test(m2[0]), m2 ? '已检查' : '未找到函数');
    ok('R5-4', 'toggleAutoRun 失败时恢复开关原状', !!m2 && /classList\.toggle\('on',\s*!want\)/.test(m2[0]));
    ok('R5-5', 'toggleAutoRun 以系统返回的布尔值为准纠正界面', !!m2 && /typeof applied === 'boolean'/.test(m2[0]));
  }

  closeAllWatchers();
  const s = summarize();
  console.log('\n---- 第十一部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败 ----');
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('ERR', e && e.stack); process.exit(1); });
