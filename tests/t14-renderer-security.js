// 第十四部分:Renderer 安全基线与事件委托(阶段 2 第 3 步:去掉内联事件 + 启用 CSP)
//   静态核验:HTML/JS 源码结构检查。CSP 与委托的最终正确性由实机 CDP 验证。
const path = require('node:path');
const fs = require('node:fs');
const { group, ok, summarize } = require('./common');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
// 阶段4 UI 重构:renderer.js 拆分为 js/ 多文件,断言改为拼接全文(与运行时等价)
// (文件名 → 实际路径:页面级四件在 js/pages/)
const JS_ORDER = [
  ['core.js', 'js'], ['ui.js', 'js'], ['doubao.js', 'js'], ['tags.js', 'js'],
  ['settings-shared.js', 'js'], ['services.js', 'js/pages'], ['library.js', 'js/pages'],
  ['creation.js', 'js/pages'], ['workbench.js', 'js/pages'], ['config.js', 'js'],
  ['status.js', 'js'], ['boot.js', 'js'],
];
const html = fs.readFileSync(HTML, 'utf8');
const RENDERER_FILES = JS_ORDER.map(([f, dir]) => path.join(ROOT, 'src', 'renderer', dir, f));
const js = RENDERER_FILES.map(f => fs.readFileSync(f, 'utf8')).join('\n');
const rendererFilesExist = RENDERER_FILES.every(f => fs.existsSync(f));

(async () => {
  group('A CSP 配置');
  {
    ok('A1', 'index.html 含 Content-Security-Policy meta', html.indexOf('Content-Security-Policy') >= 0);
    const m = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
    const csp = m ? m[1] : '';
    const hasScriptSelf = csp.indexOf("script-src 'self'") >= 0;
    const noScriptInline = !/script-src[^;]*unsafe-inline/.test(csp);
    const noScriptEval = !/script-src[^;]*unsafe-eval/.test(csp);
    ok('A2', 'script-src 为 self,禁内联脚本与 eval', hasScriptSelf && noScriptInline && noScriptEval);
    ok('A3', 'default-src 为 none 默认拒绝', csp.indexOf("default-src 'none'") >= 0);
    ok('A4', 'img-src 允许 file 协议,本地壁纸预览必需', /img-src[^;]*file:/.test(csp));
    ok('A5', 'connect-src 为 none,渲染层不出网', csp.indexOf("connect-src 'none'") >= 0);
    ok('A6', 'object-src frame-src base-uri form-action 均为 none',
      csp.indexOf("object-src 'none'") >= 0 && csp.indexOf("frame-src 'none'") >= 0 &&
      csp.indexOf("base-uri 'none'") >= 0 && csp.indexOf("form-action 'none'") >= 0);
    // 阶段4 UI 重构:<style> 已拆分为 styles/*.css 外链;style-src 需同时允许 self(外链)与 unsafe-inline(动态样式)
    ok('A7', 'style-src 保留 unsafe-inline 且样式为 styles/ 外链',
      /style-src[^;]*'unsafe-inline'/.test(csp) && /style-src[^;]*'self'/.test(csp)
      && (html.match(/rel="stylesheet" href="styles\//g) || []).length === 4);
  }

  group('B 内联事件清除');
  {
    const inline = html.match(/\son(?:click|change|input|submit|load|error)\s*=/g) || [];
    ok('B1', 'index.html 已无任何内联事件处理器', inline.length === 0, '残留 ' + inline.length + ' 处');
    const acts = html.match(/data-act="/g) || [];
    const sets = html.match(/data-set="/g) || [];
    // 不写死数量:阶段3 新增豆包卡片后交互元素会增长。
    // 真正要保障的是"没有残留内联事件"(B1)与"每个 data-act 都有实现"(C5)。
    ok('B2', 'data-act 元素数量不小于去内联事件时的基线 29', acts.length >= 29, '实际 ' + acts.length);
    // 阶段3 把 ai-model 改成自定义处理(需要区分 doubao/svc: 两种值),移除了它的 data-set。
    // 保障的是"没有残留内联事件"(B1)与"每个 data-set 都有实现"(C6)。
    ok('B3', 'data-set 元素仍在使用(阶段3 后有增减属正常)', sets.length >= 8, '实际 ' + sets.length);
    ok('B4', 'HTML 中不再出现内联函数调用文本', html.indexOf('onclick="api.') < 0 && !/onclick="[a-zA-Z_]+\(/.test(html));
  }

  group('C 事件委托');
  {
    ok('C1', 'renderer.js 定义 CLICK_ACTIONS 映射表', /const CLICK_ACTIONS\s*=/.test(js));
    ok('C2', 'renderer.js 定义 CHANGE_SETTERS 映射表', /const CHANGE_SETTERS\s*=/.test(js));
    ok('C3', '使用 addEventListener 委托而非 eval 或 new Function',
      js.indexOf("addEventListener('click'") >= 0 && js.indexOf("addEventListener('change'") >= 0 &&
      !/\beval\s*\(/.test(js) && !/new Function\s*\(/.test(js));
    ok('C4', '未知 action 有明确提示而非静默失败', js.indexOf('未注册的 data-act') >= 0 && js.indexOf('未注册的 data-set') >= 0);
    const htmlActs = [...new Set([...html.matchAll(/data-act="([^"]+)"/g)].map(x => x[1]))];
    const mapKeys = [...js.matchAll(/^\s{2}'([a-z-]+)':/gm)].map(x => x[1]);
    const missing = htmlActs.filter(a => mapKeys.indexOf(a) < 0);
    ok('C5', 'HTML 用到的每个 data-act 都有对应实现', missing.length === 0,
      missing.length ? '缺失 ' + missing.join(',') : htmlActs.length + ' 个动作全部有实现');
    const htmlSets = [...new Set([...html.matchAll(/data-set="([^"]+)"/g)].map(x => x[1]))];
    const badSets = htmlSets.filter(v => v !== 'game-procs' && !new RegExp("^\\s{2}" + v + ":", 'm').test(js));
    ok('C6', 'HTML 用到的每个 data-set 都被处理', badSets.length === 0,
      badSets.length ? '未处理 ' + badSets.join(',') : htmlSets.length + ' 个 setter 全部有实现: ' + htmlSets.join(','));
  }

  group('D 安全回归');
  {
    const assigns = [...js.matchAll(/innerHTML\s*=\s*([^;\n]+)/g)].map(x => x[1].trim());
    const dangerous = assigns.filter(v => v !== "''" && v !== '""');
    ok('D0', 'js/ 拆分文件全部存在(12 个)', rendererFilesExist, JS_ORDER.join(','));
    ok('D1', 'renderer.js 无 innerHTML 注入,仅允许清空赋值', dangerous.length === 0,
      dangerous.length ? '可疑: ' + dangerous.join(' | ') : assigns.length + ' 处赋值全部为清空语义');
    ok('D2', 'renderer.js 不使用 fetch XHR WebSocket,与 connect-src none 相符',
      !/\bfetch\s*\(/.test(js) && js.indexOf('XMLHttpRequest') < 0 && js.indexOf('new WebSocket') < 0);
    ok('D3', '渲染层不直接 require Node 模块', !/require\(['"](?:node:)?(?:fs|path|child_process|electron)['"]\)/.test(js));
  }

  const s = summarize();
  console.log('');
  console.log('---- 第十四部分小结: ' + s.passed + '/' + s.total + ' 通过, ' + s.failed + ' 失败' + (s.skipped ? ', ' + s.skipped + ' 跳过' : '') + ' ----');
  if (s.failed) console.log('失败项: ' + s.failures.map(f => f.id + ' ' + f.title + ' :: ' + f.evidence).join(' | '));
  process.exit(s.failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); process.exit(2); });