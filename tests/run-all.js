// 全量测试运行器:依次执行 files 数组中的测试文件,汇总结果
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const files = ['t1-units.js','t2-ipc.js','t3-rollback.js','t4-history.js','t5-compat.js','t6-errors.js','t7-json.js','t8-legacy.js','t9-regression.js','t10-stage1-complete.js','t11-round2-fixes.js','t12-round3-fixes.js','t13-provider.js','t14-renderer-security.js','t15-plugin-loader.js','t16-readonly-errors.js'];
const dir = __dirname;
const all = [];
let failedGroups = [];
const started = Date.now();
// 数量从数组推导,避免以后增删测试文件时注释再次与实际不符
console.log('即将执行 ' + files.length + ' 个测试文件: ' + files.join(', ') + '\n');
for (const f of files) {
  const t0 = Date.now();
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8', timeout: 600000 });
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status === undefined ? 1 : e.status; }
  const lines = out.split('\n');
  for (const l of lines) {
    const m = l.match(/^\[(PASS|FAIL)\]\s+(\S+)\s+(.*?)(?:\s+::\s+(.*))?$/);
    if (m) all.push({ file: f, id: m[2], pass: m[1] === 'PASS', title: m[3], evidence: m[4] || '' });
  }
  const summary = lines.find(l => /---- .*小结/.test(l)) || '';
  // 崩溃兜底:组进程非 0 退出却没产出任何 [FAIL] 行,说明是异常终止而非断言失败。
  // 不补这条的话,汇总会报"失败 0"——看起来全过,实际整组没跑完。
  const groupFails = all.filter(x => x.file === f && !x.pass).length;
  if (code !== 0 && groupFails === 0) {
    all.push({ file: f, id: 'CRASH', pass: false, title: '测试组异常退出,code=' + code, evidence: lines.slice(-6).join(' | ').slice(0, 300) });
  }
  console.log(f.padEnd(18) + ' exit=' + code + ' ' + ((Date.now()-t0)/1000).toFixed(1) + 's  ' + summary.trim());
  if (code !== 0) failedGroups.push(f);
}
const fails = all.filter(x => !x.pass);
console.log('\n================ 总计 ================');
console.log('用例总数: ' + all.length + '  通过: ' + (all.length - fails.length) + '  失败: ' + fails.length);
console.log('总耗时: ' + ((Date.now()-started)/1000).toFixed(1) + 's');
if (fails.length) { console.log('\n失败用例:'); fails.forEach(f => console.log('  ' + f.file + ' ' + f.id + ' ' + f.title + ' :: ' + f.evidence)); }
fs.writeFileSync(path.join(dir, 'last-run.json'), JSON.stringify({ all, fails, failedGroups, at: new Date().toISOString() }, null, 2));
process.exit(fails.length ? 1 : 0);
