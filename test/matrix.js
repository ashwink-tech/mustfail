#!/usr/bin/env node
'use strict';
// Runs the tasks example against several @playwright/test versions, each installed into a scratch copy,
// and compares every grade with test/expected/tasks.json.
//   node test/matrix.js 1.50.1 1.56.1 1.65.1
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'examples', 'tasks');
const want = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected', 'tasks.json'), 'utf8'));
const versions = process.argv.slice(2);
if (!versions.length) { console.error('usage: node test/matrix.js <playwright version>...'); process.exit(2); }

const grades = report => Object.fromEntries(report.results.map(r => [`${r.file} › ${r.title}`,
  r.grade + (r.via ? ' (via a helper)' : '') + (r.checksRequest && r.grade !== 'request check' ? ' (+request)' : '')]));

let failed = 0;
const summary = [];
for (const v of versions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mf-pw${v}-`));
  for (const f of ['tests', 'pages', 'server.js', 'playwright.config.ts']) fs.cpSync(path.join(SRC, f), path.join(dir, f), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mf-matrix', private: true }));
  const inst = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--silent', `@playwright/test@${v}`], { cwd: dir, encoding: 'utf8', timeout: 10 * 60 * 1000, shell: process.platform === 'win32' });
  if (inst.status !== 0) { failed++; summary.push(`${v}: npm install failed\n${(inst.stderr || '').slice(-800)}`); continue; }
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'mustfail.js'), 'run', '--yes'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 15 * 60 * 1000 });
  const secs = Math.round((Date.now() - t0) / 1000);
  const file = path.join(dir, '.mustfail', 'report.json');
  if (res.status !== 0 || !fs.existsSync(file)) {
    failed++; summary.push(`${v}: mustfail exited ${res.status}\n${(res.stdout || '').slice(-1200)}${(res.stderr || '').slice(-800)}`); continue;
  }
  const got = grades(JSON.parse(fs.readFileSync(file, 'utf8')));
  const diffs = [...new Set([...Object.keys(want), ...Object.keys(got)])].filter(k => want[k] !== got[k])
    .map(k => `  ${k}\n    expected: ${want[k] || '(missing)'}\n    got:      ${got[k] || '(missing)'}`);
  if (diffs.length) { failed++; summary.push(`${v}: ${diffs.length} grade(s) differ (${secs}s)\n${diffs.join('\n')}`); }
  else summary.push(`${v}: all ${Object.keys(want).length} grades match (${secs}s)`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(summary.join('\n'));
process.exit(failed ? 1 : 0);
