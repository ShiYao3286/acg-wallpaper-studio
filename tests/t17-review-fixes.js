// 第十七部分:阶段 2 审核修复批次
//   G. Provider ID 冲突(提交 1)
//   H. 插件符号链接安全(提交 2)
//   K. 只读通道错误记录(提交 3)
//
// 说明:本文件按提交顺序增量补充,三个提交各自只新增对应组。
const path = require('node:path');
const fs = require('node:fs');
const { group, ok, summarize } = require('./common');

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

  const s = summarize();
  console.log('');
  console.log('---- 第十七部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败' + (s.skipped ? ', ' + s.skipped + ' 跳过' : '') + ' ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); process.exit(2); });