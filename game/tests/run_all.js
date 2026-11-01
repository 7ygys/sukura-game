/* ============================================================
 * tests/run_all.js —— 一次把所有测试跑完
 *
 *   node game/tests/run_all.js
 *
 * 每个 spec 都是独立进程（它们失败时会 process.exit(1)），
 * 这里逐个跑、汇总，任何一个挂了整体就挂。
 * ============================================================ */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const dir = __dirname;
const files = ['run.js']
  .concat(fs.readdirSync(dir).filter(f => /^spec_.*\.js$/.test(f)).sort());

let failed = 0;
const summary = [];

for (const f of files) {
  const p = path.join(dir, f);
  process.stdout.write('\n=== ' + f + ' ' + '='.repeat(Math.max(0, 50 - f.length)) + '\n');
  const r = spawnSync(process.execPath, [p], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  // 只回显失败行和最后一行统计，避免刷屏
  out.split('\n').forEach(line => {
    if (line.indexOf('✗') >= 0 || line.indexOf('失败') >= 0) console.log(line);
  });
  const last = out.trim().split('\n').pop() || '';
  const ok = r.status === 0;
  if (!ok) failed++;
  summary.push({ file: f, ok: ok, last: last });
}

console.log('\n' + '='.repeat(60));
summary.forEach(s => console.log((s.ok ? '  ✓ ' : '  ✗ ') + s.file.padEnd(28) + s.last));
console.log('='.repeat(60));
console.log(failed === 0 ? '全部 ' + files.length + ' 个测试文件通过' : failed + ' 个文件有失败');
process.exit(failed === 0 ? 0 : 1);
