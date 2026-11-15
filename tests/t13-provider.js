// 第十三部分:Provider 插件系统(阶段 2)
//   协议校验 / 注册表行为 / 三个内置 Provider 的契约
//   【直接测试生产代码】:require 真实模块,不是复刻
const path = require('node:path');
const { group, ok, summarize } = require('./common');

const SRC = path.resolve(__dirname, '..', 'src', 'main', 'plugins');
const protocol = require(path.join(SRC, 'provider-protocol.js'));
const registry = require(path.join(SRC, 'provider-registry.js'));
const lolicon = require(path.join(SRC, 'builtin', 'lolicon-provider.js'));
const imgGen = require(path.join(SRC, 'builtin', 'openai-image-provider.js'));
const txtGen = require(path.join(SRC, 'builtin', 'openai-text-provider.js'));

const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

(async () => {
  // ---------- A. 协议校验 ----------
  group('A Provider 协议校验');
  {
    ok('A1', 'describeProvider 接受合法 Provider', (() => {
      const d = protocol.describeProvider(lolicon);
      return d.id === 'lolicon' && d.kind === 'image-source';
    })(), 'lolicon 描述成功');

    ok('A2', '坏 kind 被拒绝', (() => {
      const e = throws(() => protocol.describeProvider({ id: 'x', kind: 'bad', capabilities: ['fetch-random'] }));
      return e && e.isProtocolError;
    })());

    ok('A3', 'id 含路径穿越被拒绝', (() => {
      const e = throws(() => protocol.describeProvider({ id: '../evil', kind: 'text', capabilities: ['complete'], complete() {} }));
      return e && e.isProtocolError && /只能包含小写字母/.test(e.message);
    })(), '../evil 被拒');

    ok('A4', 'id 含大写被拒绝(目录名大小写敏感)', (() => {
      const e = throws(() => protocol.describeProvider({ id: 'MyProvider', kind: 'text', capabilities: ['complete'], complete() {} }));
      return e && e.isProtocolError;
    })());

    ok('A5', 'id 为空被拒绝', (() => {
      const e = throws(() => protocol.describeProvider({ id: '  ', kind: 'text', capabilities: ['complete'], complete() {} }));
      return e && e.isProtocolError;
    })());

    ok('A6', '缺少必需方法被拒绝(text 缺 complete)', (() => {
      const e = throws(() => protocol.describeProvider({ id: 'y', kind: 'text', capabilities: ['complete'] }));
      return e && e.isProtocolError && /必须实现 complete/.test(e.message);
    })(), '错误信息指明缺哪个方法');

    ok('A7', '缺少必需方法被拒绝(image-gen 缺 generate)', (() => {
      const e = throws(() => protocol.describeProvider({ id: 'z', kind: 'image-gen', capabilities: ['generate'] }));
      return e && e.isProtocolError && /必须实现 generate/.test(e.message);
    })());

    ok('A8', 'capability 不在白名单被拒绝', (() => {
      const e = throws(() => protocol.describeProvider({ id: 'w', kind: 'text', capabilities: ['complete', 'hack-the-planet'], complete() {} }));
      return e && e.isProtocolError && /能力未定义/.test(e.message);
    })());

    ok('A9', 'kind 缺少必需 capability 被拒绝', (() => {
      const e = throws(() => protocol.describeProvider({ id: 'v', kind: 'text', capabilities: [], complete() {} }));
      return e && e.isProtocolError && /必须具备能力/.test(e.message);
    })());

    ok('A10', 'capabilities 非数组被拒绝', (() => {
      const e = throws(() => protocol.describeProvider({ id: 'u', kind: 'text', capabilities: 'complete', complete() {} }));
      return e && e.isProtocolError;
    })());

    ok('A11', 'configSchema 字段类型非法被拒绝', (() => {
      const e = throws(() => protocol.describeProvider({
        id: 't', kind: 'text', capabilities: ['complete'], complete() {},
        configSchema: { foo: { type: 'object' } },
      }));
      return e && e.isProtocolError && /必须是 string\/number\/boolean/.test(e.message);
    })());

    ok('A12', 'null / 数组 / 字符串作为 Provider 均被拒绝',
      ['null', 'array', 'string'].every((kind) => {
        const v = kind === 'null' ? null : kind === 'array' ? [] : 'x';
        const e = throws(() => protocol.describeProvider(v));
        return e && e.isProtocolError;
      }));

    ok('A13', 'describeProvider 返回值不含实现函数(可安全外传)', (() => {
      const d = protocol.describeProvider(lolicon);
      return !Object.values(d).some(v => typeof v === 'function');
    })(), '元数据全为可序列化值');
  }

  // ---------- B. 注册表 ----------
  group('B Provider 注册表');
  {
    registry.reset();
    ok('B1', '初始为空', registry.size() === 0);

    const described = registry.registerAll([lolicon, imgGen, txtGen]);
    ok('B2', 'registerAll 注册 3 个', registry.size() === 3 && described.length === 3);

    ok('B3', 'listByKind 按类型过滤正确',
      registry.listByKind('image-source').length === 1 &&
      registry.listByKind('image-gen').length === 1 &&
      registry.listByKind('text').length === 1);

    ok('B4', 'get 返回含实现方法的对象', (() => {
      const p = registry.get('lolicon');
      return p && typeof p.fetch === 'function';
    })());

    ok('B5', 'getMeta 不含实现方法', (() => {
      const m = registry.getMeta('lolicon');
      return m && !Object.values(m).some(v => typeof v === 'function') && m.id === 'lolicon';
    })());

    ok('B6', 'get 未知 id 返回 null', registry.get('nonexistent') === null);
    ok('B7', 'getMeta 未知 id 返回 null', registry.getMeta('nonexistent') === null);

    ok('B8', '重复 register 同 id 幂等(不抛错,覆盖实现)', (() => {
      const before = registry.size();
      registry.register(lolicon);
      return registry.size() === before;
    })(), '同 id 再注册不增加数量——测试脚手架会多次加载 main.js');

    ok('B9', 'registerAll 同批内重复 id 被拒绝', (() => {
      const e = throws(() => registry.registerAll([lolicon, lolicon]));
      return e && e.isProtocolError && /重复 id/.test(e.message);
    })());

    ok('B10', 'registerAll 非数组被拒绝', (() => {
      const e = throws(() => registry.registerAll('x'));
      return e && e.isProtocolError;
    })());

    ok('B11', '停用后 listByKind 不返回、get 返回 null', (() => {
      registry.setEnabled('lolicon', false);
      const gone = registry.listByKind('image-source').length === 0 && registry.get('lolicon') === null;
      registry.setEnabled('lolicon', true);
      const back = registry.listByKind('image-source').length === 1 && !!registry.get('lolicon');
      return gone && back;
    })(), '停用/启用双向验证');

    ok('B12', 'list 含 enabled 状态', (() => {
      registry.setEnabled('openai-text', false);
      const row = registry.list().find(p => p.id === 'openai-text');
      const good = row && row.enabled === false;
      registry.setEnabled('openai-text', true);
      return good;
    })());

    ok('B13', 'setEnabled 未知 id 返回 false', registry.setEnabled('nope', true) === false);
    ok('B14', 'isEnabled 语义正确',
      registry.isEnabled('lolicon') === true && registry.isEnabled('nope') === false);

    ok('B15', '坏 Provider 注册不进来(注册表保持干净)', (() => {
      const before = registry.size();
      const e = throws(() => registry.register({ id: 'bad', kind: 'bad', capabilities: [] }));
      return e && registry.size() === before;
    })());
  }

  // ---------- C. 内置 Provider 契约 ----------
  group('C 内置 Provider 契约');
  {
    ok('C1', 'lolicon 元数据完整', (() => {
      const d = protocol.describeProvider(lolicon);
      return d.id === 'lolicon' && d.kind === 'image-source'
        && d.capabilities.includes('fetch-random') && d.builtin === true;
    })());

    ok('C2', 'openai-image 元数据完整', (() => {
      const d = protocol.describeProvider(imgGen);
      return d.id === 'openai-image' && d.kind === 'image-gen'
        && d.capabilities.includes('generate') && d.builtin === true;
    })());

    ok('C3', 'openai-text 元数据完整', (() => {
      const d = protocol.describeProvider(txtGen);
      return d.id === 'openai-text' && d.kind === 'text'
        && d.capabilities.includes('complete') && d.builtin === true;
    })());

    ok('C4', 'lolicon.fetch 是函数且需要 ctx', typeof lolicon.fetch === 'function' && lolicon.fetch.length >= 1);

    ok('C5', 'openai-image.generate 缺服务时抛明确错误', await (async () => {
      try {
        await imgGen.generate({
          config: { services: [], activeImageService: '', ai: { prompt: 'p', size: '1x1' } },
          netFetch: async () => { throw new Error('不该出网'); },
          findService: () => null,
        });
        return false;
      } catch (e) { return /未找到画图 API 服务/.test(e.message); }
    })(), '不出网即失败,错误文案与原实现一致');

    ok('C6', 'openai-text.complete 缺服务时返回 ok:false 而非抛错', await (async () => {
      const r = await txtGen.complete({
        config: { services: [], activeTextService: '' },
        netFetch: async () => { throw new Error('不该出网'); },
        findService: () => null,
      });
      return r && r.ok === false && /未找到文本 API 服务/.test(r.error);
    })(), '契约:complete 失败返回结果对象,与 generate 抛错不同(保持原行为)');

    ok('C7', 'apiBase 规范化与 main.js 一致(去尾斜杠与 /v1)', (() => {
      const f = imgGen.apiBase;
      return f('http://a.com/v1') === 'http://a.com'
        && f('http://a.com/v1/') === 'http://a.com'
        && f('http://a.com/') === 'http://a.com'
        && f('http://a.com') === 'http://a.com';
    })(), '两处实现若漂移会导致请求路径不同');

    ok('C8', '三个 Provider 均通过协议校验', (() => {
      return [lolicon, imgGen, txtGen].every(p => {
        try { protocol.describeProvider(p); return true; } catch { return false; }
      });
    })());
  }

  // ---------- D. main.js 实际注册情况 ----------
  group('D main.js 注册与调用点');
  {
    const fs = require('node:fs');
    const mainSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

    ok('D1', 'main.js 引入了 provider-registry', /require\('\.\/plugins\/provider-registry'\)/.test(mainSrc));
    ok('D2', 'main.js 引入三个内置 Provider',
      /builtin\/lolicon-provider/.test(mainSrc) && /builtin\/openai-image-provider/.test(mainSrc) && /builtin\/openai-text-provider/.test(mainSrc));
    ok('D3', 'main.js 调用 registerAll', /providerRegistry\.registerAll\(/.test(mainSrc));
    ok('D4', 'fetchLolicon 已委托 Provider(不再内联拼 URL)',
      /async function fetchLolicon[\s\S]{0,300}providerRegistry\.get\('lolicon'\)/.test(mainSrc) &&
      !/api\.lolicon\.app/.test(mainSrc));
    // 阶段3 起 fetchAI 有两条路由(豆包 / OpenAI 兼容服务),不能再只匹配单一写法。
    // 真正要保障的是"它从 registry 取 Provider,而不是内联实现"。
    ok('D5', 'fetchAI 通过 registry 取 Provider(支持多引擎路由)',
      /async function fetchAI[\s\S]{0,1600}providerRegistry\.get\('openai-image'\)/.test(mainSrc)
      && /async function fetchAI[\s\S]{0,1600}providerRegistry\.get\('doubao-image'\)/.test(mainSrc),
      '阶段3:AI 生图可在"OpenAI 兼容服务"与"豆包 Seedream"之间路由');
    ok('D6', 'ai-assist-prompt 已委托 Provider',
      /providerRegistry\.get\('openai-text'\)/.test(mainSrc));
    const genHits = (mainSrc.match(/images\/generations/g) || []).length;
    ok('D7', 'main.js 不再出现 images/generations(该端点已完全移入 Provider)', genHits === 0,
      '当前出现次数: ' + genHits + '(test-service 探活用的是 /v1/models 与 /v1/chat/completions,不走生图端点)');
  }

  const s = summarize();
  console.log('\n---- 第十三部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败' + (s.skipped ? ', ' + s.skipped + ' 跳过' : '') + ' ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); process.exit(2); });
