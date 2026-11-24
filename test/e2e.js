#!/usr/bin/env node
'use strict';
// End-to-end check: runs mustfail on each example app and compares every test's grade with the saved
// snapshot in test/expected/. Exit code 1 on any difference.
//   node test/e2e.js                 run all examples
//   node test/e2e.js tasks cart      run some (tasks, tasks-esm, cart, cart-odd)
//   node test/e2e.js --update        rewrite the snapshots from this run (review the diff first)
//   MUSTFAIL_E2E_ARGS="--project=x"  extra Playwright args for every example
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'mustfail.js');
const EXPECTED = path.join(__dirname, 'expected');
const EXAMPLES = ['tasks', 'tasks-esm', 'cart', 'cart-odd'];
const os = require('os');

// tasks-esm is the tasks app as an ES-module project: same specs, page objects and server, on its own port.
function syncEsm() {
  const src = path.join(ROOT, 'examples', 'tasks'), dst = path.join(ROOT, 'examples', 'tasks-esm');
  for (const dir of ['tests', 'pages']) {
    fs.rmSync(path.join(dst, dir), { recursive: true, force: true });
    fs.cpSync(path.join(src, dir), path.join(dst, dir), { recursive: true });
  }
  const server = fs.readFileSync(path.join(src, 'server.js'), 'utf8').replace('process.env.PORT || 4124', 'process.env.PORT || 4125');
  fs.writeFileSync(path.join(dst, 'server.cjs'), server);
}

// cart-odd is the cart app set up the awkward ways real projects are: folders and spec files with spaces
// in their names, a globalSetup named without './', a failure limit and a whole-run time limit in the
// config, a spec importing from 'playwright/test', and mustfail's output folder outside the project.
// Each of those broke mustfail once. Its grades must equal cart's.
const ODD_DIR = path.join(ROOT, 'examples', 'cart odd');
const ODD_OUT = path.join(os.tmpdir(), 'mustfail e2e', 'out dir');
function syncOdd() {
  const src = path.join(ROOT, 'examples', 'cart');
  fs.rmSync(ODD_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(ODD_DIR, 'tests', 'sub dir'), { recursive: true });
  for (const f of ['package.json', 'server.js']) fs.copyFileSync(path.join(src, f), path.join(ODD_DIR, f));
  fs.copyFileSync(path.join(src, 'tests', 'cart.spec.ts'), path.join(ODD_DIR, 'tests', 'cart.spec.ts'));
  fs.writeFileSync(path.join(ODD_DIR, 'tests', 'sub dir', 'merged spec.spec.ts'),
    fs.readFileSync(path.join(src, 'tests', 'merged.spec.ts'), 'utf8').replace("from '@playwright/test'", "from 'playwright/test'"));
  fs.symlinkSync(path.join(src, 'node_modules'), path.join(ODD_DIR, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(ODD_DIR, 'global-setup.ts'), 'export default async function () {}\n');
  const config = fs.readFileSync(path.join(src, 'playwright.config.ts'), 'utf8')
    .replace("retries: 1,", "retries: 1, maxFailures: 1, globalTimeout: 60_000, globalSetup: 'global-setup.ts', updateSnapshots: 'all',");
  if (!config.includes('maxFailures')) throw new Error('cart config changed: update syncOdd in test/e2e.js');
  fs.writeFileSync(path.join(ODD_DIR, 'playwright.config.ts'), config);
  fs.rmSync(ODD_OUT, { recursive: true, force: true });
}

// The grade of every test, keyed by file:line and title (stable across runs).
function grades(report) {
  const out = {};
  for (const r of report.results) {
    out[`${r.file} › ${r.title}`] = r.grade + (r.via ? ' (via a helper)' : '') + (r.checksRequest && r.grade !== 'request check' ? ' (+request)' : '');
  }
  return out;
}

function runExample(name, extra) {
  const odd = name === 'cart-odd';
  const dir = odd ? ODD_DIR : path.join(ROOT, 'examples', name);
  const out = odd ? ODD_OUT : path.join(dir, '.mustfail');
  fs.rmSync(path.join(out, 'report.json'), { force: true });
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [BIN, 'run', '--yes', ...(odd ? ['--out', out] : []), ...(extra.length ? ['--', ...extra] : [])], {
    cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000,
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  const reportFile = path.join(out, 'report.json');
  if (res.status !== 0 || !fs.existsSync(reportFile)) {
    return { name, secs, error: `mustfail exited ${res.status}${res.error ? ' (' + res.error.message + ')' : ''}\n${(res.stdout || '').slice(-1500)}${(res.stderr || '').slice(-1500)}` };
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const reasons = {};
  for (const r of report.results) reasons[`${r.file} › ${r.title}`] = r.reason;
  return { name, secs, out, grades: grades(report), reasons };
}

// What mustfail saw and planned for one mismatched test, printed into the log: CI artifacts are not
// always reachable, and a difference on one OS or browser is explained by this. Example data only.
function explain(out, k) {
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')); } catch { return null; } };
  const lines = [`  why: ${k}`];
  // Report keys are 'file › title'; plan and run keys are 'project › file › describe… › title'.
  const sep = k.indexOf(' › '), file = k.slice(0, sep), title = k.slice(sep + 3);
  const same = x => typeof x === 'string' && x.includes(' › ' + file + ' › ') && x.endsWith(' › ' + title);
  const plan = read('plan.json'), baseline = read('baseline.json'), faults = read('faults.json');
  const pk = plan && Object.keys(plan.tests || {}).find(same);
  if (pk) for (const f of plan.tests[pk].faults) lines.push(`    planned: ${f.op}${f.endpoint ? ' ' + f.endpoint.replace(/https?:\/\/[^/]+/, '') : ''}${f.path ? ' ' + f.path.join('.') : ''}`);
  else lines.push(`    planned: (not in plan${plan && plan.excluded ? '; excluded: ' + Object.entries(plan.excluded).filter(([x]) => same(x)).map(([, v]) => v).join(' ') : ''})`);
  for (const b of (baseline && baseline.rows || []).filter(x => same(x.key))) {
    const t = b.traffic || {};
    lines.push(`    baseline ${b.repeat}: ${b.status} ${b.ms}ms${b.error ? ' error: ' + String(b.error).split('\n')[0].slice(0, 160) : ''}`);
    lines.push(`      asserted: ${JSON.stringify(t.asserted || []).slice(0, 300)}`);
    for (const e of t.endpoints || []) {
      const lists = (e.shape && e.shape.arrays || []).map(a => `${a.path.join('.')}[${a.length}]`).join(' ');
      lines.push(`      ${e.key.replace(/https?:\/\/[^/]+/, '')} n=${e.count}${e.auth ? ' auth' : ''} lists: ${lists || '-'}`);
    }
  }
  for (const f of (faults && faults.rows || []).filter(x => same(x.key) && x.fault)) {
    lines.push(`    fault ${f.fault && f.fault.op} ${f.fault && f.fault.path ? f.fault.path.join('.') : ''}: ${f.status} applied=${f.fault && f.fault.applied} bodyStarted=${f.fault && f.fault.bodyStarted}${f.error ? ' error: ' + String(f.error).split('\n')[0].slice(0, 160) : ''}`);
  }
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const names = args.filter(a => !a.startsWith('--'));
  const todo = names.length ? names : EXAMPLES;
  const extra = (process.env.MUSTFAIL_E2E_ARGS || '').split(' ').filter(Boolean);
  if (todo.includes('tasks-esm')) syncEsm();
  if (todo.includes('cart-odd')) syncOdd();
  fs.mkdirSync(EXPECTED, { recursive: true });
  let failed = 0;
  for (const name of todo) {
    const r = runExample(name, extra);
    if (r.error) { failed++; console.log(`FAIL ${name}: ${r.error}`); continue; }
    const file = path.join(EXPECTED, `${name}.json`);
    if (update || !fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(r.grades, null, 2) + '\n');
      console.log(`${update ? 'updated' : 'wrote'} ${path.relative(ROOT, file)} (${Object.keys(r.grades).length} tests, ${r.secs}s)`);
      continue;
    }
    const want = JSON.parse(fs.readFileSync(file, 'utf8'));
    const diffs = [];
    for (const k of new Set([...Object.keys(want), ...Object.keys(r.grades)])) {
      if (want[k] !== r.grades[k]) diffs.push(`  ${k}\n    expected: ${want[k] || '(missing)'}\n    got:      ${r.grades[k] || '(missing)'}\n    reason:   ${r.reasons[k] || ''}`);
    }
    if (diffs.length) {
      // Keep what the run recorded: the next run of this example overwrites it, and an intermittent
      // difference cannot be explained afterwards without it.
      const keep = path.join(__dirname, 'failed', `${name}-${Date.now()}`);
      fs.mkdirSync(keep, { recursive: true });
      for (const f of fs.readdirSync(r.out)) if (f.endsWith('.json')) fs.copyFileSync(path.join(r.out, f), path.join(keep, f));
      failed++; console.log(`FAIL ${name}: ${diffs.length} grade(s) differ (${r.secs}s); run data kept in ${path.relative(ROOT, keep)}\n${diffs.join('\n')}`);
      for (const k of Object.keys(want)) if (want[k] !== r.grades[k]) console.log(explain(r.out, k));
    }
    else console.log(`ok   ${name}: ${Object.keys(want).length} tests match (${r.secs}s)`);
  }
  process.exit(failed ? 1 : 0);
}
main();
