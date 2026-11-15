// 第一部分:共享模块与 IPC 校验 —— 全部【直接测试生产代码】
const path = require('node:path');
const fs = require('node:fs');
const { group, ok, mkTmp, cleanupTmp, fakeJpeg, listFiles, summarize } = require('./common');

const REPO = path.resolve(__dirname, '..');
const { stripBom } = require(path.join(REPO, 'src/shared/text.js'));
const contracts = require(path.join(REPO, 'src/shared/contracts.js'));
const V = require(path.join(REPO, 'src/main/validate.js'));

function throwsArg(fn) {
  try { fn(); return null; } catch (e) { return { name: e.name, message: e.message, isArgError: !!e.isArgError }; }
}

// ---------- A. stripBom(直接测试生产模块) ----------
group('A stripBom 生产模块');
{
  const bom = '\uFEFF';
  ok('A1', '带 BOM 的 JSON 文本剥后首字符非 BOM', stripBom(bom + '{"a":1}') === '{"a":1}', JSON.stringify(stripBom(bom + '{"a":1}')));
  ok('A2', '剥 BOM 后 JSON.parse 成功', (() => { try { return JSON.parse(stripBom(bom + '{"a":1,"b":"中文"}')).b === '中文'; } catch { return false; } })());
  ok('A3', '裸 JSON.parse 带 BOM 抛 SyntaxError(证明修复必要性)', (() => { try { JSON.parse(bom + '{}'); return false; } catch (e) { return e.name === 'SyntaxError'; } })());
  ok('A4', '无 BOM 字符串恒等', stripBom('{"a":1}') === '{"a":1}');
  ok('A5', 'null 原样返回', stripBom(null) === null);
  ok('A6', 'undefined 原样返回', stripBom(undefined) === undefined);
  ok('A7', '空串原样返回', stripBom('') === '');
  ok('A8', '数字原样返回(不抛错)', stripBom(123) === 123);
  ok('A9', '仅剥离首个 BOM,双 BOM 只剥一层', stripBom(bom + bom + 'x') === bom + 'x');
  ok('A10', 'BOM 在中间不剥离', stripBom('a' + bom + 'b') === 'a' + bom + 'b');
  ok('A11', 'U+FEFF 属于 JS WhiteSpace:trim() 可剥, trimEnd() 不能(船长结论复核)',
    ('\uFEFF{}').trim()[0] !== '\uFEFF' && ('\uFEFF{}').trimEnd()[0] === '\uFEFF',
    'trim 首字符=' + ('\uFEFF{}').trim().charCodeAt(0) + '; trimEnd 首字符=' + ('\uFEFF{}').trimEnd().charCodeAt(0));
}

// ---------- B. contracts(直接测试生产模块) ----------
group('B contracts 生产模块');
{
  ok('B1', 'ok({a:1}) 展开为 {ok:true,a:1}', JSON.stringify(contracts.ok({ a: 1 })) === '{"ok":true,"a":1}', JSON.stringify(contracts.ok({ a: 1 })));
  ok('B2', 'ok() 无参得到 {ok:true,data:undefined}', contracts.ok().ok === true);
  ok('B3', 'ok([1,2]) 数组包进 data', JSON.stringify(contracts.ok([1, 2])) === '{"ok":true,"data":[1,2]}');
  ok('B4', 'fail(msg,code) 结构正确', (() => { const r = contracts.fail('出错了', contracts.ERROR_CODES.E_IO); return r.ok === false && r.error === '出错了' && r.code === 'E_IO'; })());
  ok('B5', 'fail() 无参 error 为兜底文案', contracts.fail().error === '未知错误');
  ok('B6', 'failFrom(Error) 取 message', contracts.failFrom(new Error('boom'), 'E_NET').error === 'boom');
  ok('B7', 'failFrom(null) 不抛且给兜底', contracts.failFrom(null).error === '未知错误');
  ok('B8', 'ERROR_CODES 六个码齐备', ['E_INVALID_ARG', 'E_NOT_FOUND', 'E_IO', 'E_NET', 'E_STATE', 'E_ROLLBACK'].every(k => contracts.ERROR_CODES[k] === k));
  ok('B9', 'fail 的 extra 合并到顶层且不改 ok', (() => { const r = contracts.fail('x', 'E_IO', { detail: 'd' }); return r.ok === false && r.detail === 'd'; })());
}

// ---------- C. validate(直接测试生产模块) ----------
group('C validate 生产模块');
{
  const goodSvc = { id: 'svc-1', kind: 'image', name: '本地', apiBase: 'http://127.0.0.1:8326/v1', apiKey: 'sk-test', model: 'anime' };
  ok('C1', '合法服务通过并保留字段', (() => { const s = V.assertService(goodSvc); return s.id === 'svc-1' && s.apiBase === 'http://127.0.0.1:8326/v1'; })());
  ok('C2', 'https 通过', (() => { const s = V.assertService({ ...goodSvc, apiBase: 'https://api.example.com/v1' }); return s.apiBase === 'https://api.example.com/v1'; })());
  ok('C3', 'file: 协议被拒', (() => { const e = throwsArg(() => V.assertService({ ...goodSvc, apiBase: 'file:///C:/x' })); return e && e.isArgError && /http\/https/.test(e.message); })(), throwsArg(() => V.assertService({ ...goodSvc, apiBase: 'file:///C:/x' }))?.message);
  ok('C4', 'javascript: 协议被拒', (() => { const e = throwsArg(() => V.assertService({ ...goodSvc, apiBase: 'javascript:alert(1)' })); return e && e.isArgError; })());
  ok('C5', '非 URL 字符串被拒', (() => { const e = throwsArg(() => V.assertService({ ...goodSvc, apiBase: 'not-a-url' })); return e && e.isArgError; })());
  ok('C6', '坏 kind 被拒', (() => { const e = throwsArg(() => V.assertService({ ...goodSvc, kind: 'video' })); return e && e.isArgError && /image|text/.test(e.message); })());
  ok('C7', '空 id 被拒', (() => { const e = throwsArg(() => V.assertService({ ...goodSvc, id: '   ' })); return e && e.isArgError; })());
  ok('C8', '超长 id 被拒(>128)', (() => { const e = throwsArg(() => V.assertService({ ...goodSvc, id: 'x'.repeat(129) })); return e && e.isArgError && /超长/.test(e.message); })());
  ok('C9', '非字符串 name 被拒', (() => { const e = throwsArg(() => V.assertService({ ...goodSvc, name: 123 })); return e && e.isArgError; })());
  ok('C10', '__proto__ 污染键被剔除', (() => {
    const raw = JSON.parse('{"id":"svc-1","kind":"image","name":"n","apiBase":"http://127.0.0.1:8326/v1","apiKey":"k","model":"m","__proto__":{"polluted":1}}');
    const s = V.assertService(raw);
    return !Object.prototype.hasOwnProperty.call(s, 'polluted') && ({}).polluted === undefined && !Object.keys(s).includes('__proto__');
  })());
  ok('C11', 'constructor 键被剔除', (() => { const s = V.assertService({ ...goodSvc, constructor: 'x' }); return !Object.keys(s).includes('constructor'); })());
  ok('C12', 'apiKey 超长被拒(>512)', (() => { const e = throwsArg(() => V.assertService({ ...goodSvc, apiKey: 'k'.repeat(513) })); return e && e.isArgError; })());
  ok('C13', '错误文案不含 apiKey 明文', (() => { const e = throwsArg(() => V.assertService({ ...goodSvc, apiKey: 'k'.repeat(513) })); return e && !e.message.includes('kkkk'); })());
  ok('C14', 'null 服务被拒', (() => { const e = throwsArg(() => V.assertService(null)); return e && e.isArgError; })());
  ok('C15', '数组服务被拒', (() => { const e = throwsArg(() => V.assertService([1])); return e && e.isArgError; })());
  const goodPreset = { id: 'p1', name: '风景', prompt: 'anime scenery' };
  ok('C16', '合法预设通过', V.assertPreset(goodPreset).id === 'p1');
  ok('C17', '空 prompt 被拒', (() => { const e = throwsArg(() => V.assertPreset({ ...goodPreset, prompt: '' })); return e && e.isArgError; })());
  ok('C18', '超长 prompt 被拒(>8000)', (() => { const e = throwsArg(() => V.assertPreset({ ...goodPreset, prompt: 'x'.repeat(8001) })); return e && e.isArgError; })());
  ok('C19', 'assertId 空串默认被拒', (() => { const e = throwsArg(() => V.assertId('')); return e && e.isArgError; })());
  ok('C20', 'assertId allowEmpty 放行空串', V.assertId('', 'id', { allowEmpty: true }) === '');
  ok('C21', 'assertKind 只接受 image/text', (() => { try { V.assertKind('image'); V.assertKind('text'); return throwsArg(() => V.assertKind('other')) !== null; } catch { return false; } })());
  ok('C22', 'assertReason 白名单 4 值', (() => { try { ['manual', 'ai', 'ai-explicit', 'schedule'].forEach(V.assertReason); return throwsArg(() => V.assertReason('hack')) !== null; } catch { return false; } })());
  ok('C23', 'argFail 输出 {ok:false, code:E_INVALID_ARG}', (() => { const r = V.argFail(new V.ArgError('x')); return r.ok === false && r.code === 'E_INVALID_ARG' && r.error.startsWith('参数无效: '); })());
  ok('C24', 'ArgError.isArgError 标记可识别', new V.ArgError('x').isArgError === true && V.isArgError(new V.ArgError('x')) === true);
}

const s = summarize();
console.log('\n---- 第一部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败 ----');
process.exitCode = s.failed ? 1 : 0;
