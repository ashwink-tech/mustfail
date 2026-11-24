#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { buildPlan } = require('../lib/plan');
const { grade } = require('../lib/grade');
const { printConsole, writeHtml } = require('../lib/report');
const { retryPlan, mergeRetry } = require('../lib/lost');
const { GRADES } = require('../lib/report');
const { confirmPlan, mergeConfirm } = require('../lib/confirm');
const { compare, compareLines } = require('../lib/compare');

const LIB = path.join(__dirname, '..', 'lib');
const HELP = `mustfail: find Playwright tests that stay green when the app is broken.

Usage:
  npx mustfail run [options] [-- <extra playwright test args>]

Options:
  -c, --config <file>        Playwright config (default: playwright.config.{ts,js,mts,mjs,cjs,cts})
  -o, --out <dir>            Output folder (default: .mustfail)
      --max-targeted <n>     Targeted faults per test after the blackout (default: 3)
      --expect-timeout <ms>  Assertion timeout during fault runs (default: derived from baseline)
      --action-timeout <ms>  Action timeout during fault runs (default: your config's)
      --allow-remote         Allow a baseURL that is not localhost (fault runs repeat real writes)
      --fail-on <grades>     Exit with code 1 if any test gets one of these grades
                             (comma-separated, e.g. decorative,weak) — for CI
      --no-confirm           Do not repeat the run each strong or write-gated grade rests on
      --yes                  Skip the confirmation prompt
  -h, --help                 Show this help
  -v, --version              Show mustfail's version

Run it against a local or disposable environment: fault runs repeat each test's
requests, including writes the fault does not target.

Examples:
  npx mustfail run
  npx mustfail run -- --project=chromium tests/checkout`;

function parseArgs(argv) {
  if (argv[0] === '-h' || argv[0] === '--help') argv = ['help', ...argv.slice(1)];
  if (argv[0] === '-v' || argv[0] === '--version') argv = ['version', ...argv.slice(1)];
  const value = (i, name) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('-')) fail(`${name} needs a value.\n\n${HELP}`);
    return v;
  };
  const number = (i, name) => {
    const n = Number(value(i, name));
    if (!Number.isFinite(n) || n < 0) fail(`${name} needs a number, got: ${argv[i]}`);
    return n;
  };
  const opts = { cmd: argv[0], config: null, out: '.mustfail', maxTargeted: 3, expectTimeout: null, actionTimeout: null, allowRemote: false, yes: false, confirm: true, extra: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { opts.extra = argv.slice(i + 1); break; }
    else if (a === '-c' || a === '--config') opts.config = value(++i, a);
    else if (a === '-o' || a === '--out') opts.out = value(++i, a);
    else if (a === '--max-targeted') opts.maxTargeted = number(++i, a);
    else if (a === '--expect-timeout') opts.expectTimeout = number(++i, a);
    else if (a === '--action-timeout') opts.actionTimeout = number(++i, a);
    else if (a === '--allow-remote') opts.allowRemote = true;
    else if (a === '--no-confirm') opts.confirm = false;
    else if (a === '--fail-on') {
      opts.failOn = value(++i, a).split(',').map(g => g.trim().toLowerCase()).filter(Boolean);
      const bad = opts.failOn.filter(g => !GRADES.includes(g));
      if (bad.length) fail(`--fail-on: unknown grade ${bad.join(', ')}. Grades: ${GRADES.join(', ')}.`);
    }
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '-h' || a === '--help') opts.cmd = 'help';
    else fail(`Unknown option: ${a}\n\n${HELP}`);
  }
  // Playwright flags that would undo what mustfail sets in its config or cut fault runs short.
  const clash = { '--retries': 'mustfail runs with retries off', '--repeat-each': 'mustfail sets the repeat count itself',
    '--reporter': 'mustfail needs its own reporter', '--max-failures': 'fault runs are meant to fail; it would stop the run early',
    '-x': 'fault runs are meant to fail; it would stop the run early', '--ui': 'mustfail runs headless from the command line',
    '--debug': 'mustfail runs headless from the command line', '--list': 'mustfail lists tests itself',
    '-u': 'fault runs must not rewrite your snapshots', '--update-snapshots': 'fault runs must not rewrite your snapshots',
    '--last-failed': 'fault runs change which tests failed last, so the phases would run different tests',
    '--global-timeout': 'mustfail runs each test several times; it scales your config\'s globalTimeout itself' };
  for (const a of opts.extra) {
    const flag = a.split('=')[0];
    if (clash[flag]) fail(`${flag} cannot be passed to Playwright through mustfail: ${clash[flag]}.`);
  }
  return opts;
}
class Stop extends Error {}
function fail(msg) { throw new Stop(msg); }

function findConfig(explicit) {
  if (explicit) {
    const p = path.resolve(explicit);
    if (!fs.existsSync(p)) fail(`Config not found: ${explicit}`);
    return p;
  }
  for (const ext of ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs']) {
    const p = path.resolve(`playwright.config.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  fail('No playwright.config found in this folder. Run from your project root or pass --config.');
}

// The hook that redirects @playwright/test: --require for CommonJS, plus an ESM loader for "type": "module".
let IS_MODULE = false;
function nodeOptions() {
  const parts = [process.env.NODE_OPTIONS || '', `--require ${JSON.stringify(path.join(LIB, 'register.js'))}`];
  if (IS_MODULE) parts.push(`--import ${JSON.stringify(require('url').pathToFileURL(path.join(LIB, 'register-esm.mjs')).href)}`);
  return parts.join(' ').trim();
}

function nearestPackageJson(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const p = path.join(d, 'package.json');
    if (fs.existsSync(p)) return p;
    if (path.dirname(d) === d) return null;
  }
}

function checkProject(configPath) {
  const ext = path.extname(configPath);
  const pkg = nearestPackageJson(path.dirname(configPath));
  let pkgType = null;
  if (pkg) { try { pkgType = JSON.parse(fs.readFileSync(pkg, 'utf8')).type; } catch (e) { fail(`Cannot read ${pkg}: ${e.message}`); } }
  const isModule = ext === '.mjs' || ext === '.mts' || (pkgType === 'module' && !['.cjs', '.cts'].includes(ext));
  if (isModule) {
    // ES modules: imports are redirected by a loader hook registered with module.register (Node 20.6+).
    const [maj, min] = process.versions.node.split('.').map(Number);
    if (maj < 20 || (maj === 20 && min < 6)) {
      fail('This project loads its tests as ES modules. mustfail needs Node 20.6 or newer for that (you have ' + process.versions.node + ').');
    }
  }
  let playwrightVersion = 'unknown';
  try {
    const pj = require.resolve('@playwright/test/package.json', { paths: [path.dirname(configPath)] });
    playwrightVersion = JSON.parse(fs.readFileSync(pj, 'utf8')).version;
  } catch {
    fail('Could not find @playwright/test in this project. Install your dependencies first.');
  }
  const [pmaj, pmin] = playwrightVersion.split('.').map(Number);
  if (pmaj === 1 && pmin < 50) console.warn(`mustfail: Playwright ${playwrightVersion} is older than 1.50, the oldest version mustfail is tested on. It may still work.`);
  return { playwrightVersion, isModule };
}

// Wrapper configs left by a run that was killed (its process is gone) are ours to remove.
function removeStaleWrappers(dir) {
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^playwright\.mustfail-(\d+)\.config\.(ts|js|mjs|cjs)$/);
    if (!m || Number(m[1]) === process.pid) continue;
    let alive = true;
    try { process.kill(Number(m[1]), 0); } catch (e) { alive = e.code === 'EPERM'; }
    if (!alive) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch {} }
  }
}
function writeWrapper(configPath, outDir) {
  const dir = path.dirname(configPath);
  // The wrapper is plain JavaScript whatever the user's config is written in (Playwright compiles the
  // config it loads). .mjs/.cjs fix its module type by name, so it does not depend on which package.json
  // happens to sit above the output folder.
  const wrapExt = IS_MODULE ? '.mjs' : '.cjs';
  // The wrapper lives in mustfail's output folder, not next to the user's config: test suites that reset
  // their folder between tests (git clean) would delete it while Playwright still reloads it in new
  // workers. Paths the user's config gives relative to its own folder are made absolute below.
  const wrapper = path.join(outDir, `playwright.mustfail-${process.pid}.config${wrapExt}`);
  const reporter = JSON.stringify(path.join(LIB, 'reporter.js'));
  const userFile = JSON.stringify(IS_MODULE ? require('url').pathToFileURL(configPath).href : configPath);
  const head = IS_MODULE
    ? `// Generated by mustfail. Safe to delete.
import * as loadedNs from ${userFile};
import * as FS from 'node:fs';
import * as PATH from 'node:path';
const loaded = loadedNs.default ?? loadedNs;
const raw = loaded.default || loaded;`
    : `// Generated by mustfail. Safe to delete.
const FS = require('fs');
const PATH = require('path');
const loaded = require(${userFile});
const raw = loaded.default || loaded;`;
  const body = `${head}
// Relative paths in the user's config are relative to its folder; this file sits elsewhere.
const USER_DIR = ${JSON.stringify(dir)};
const abs = p => (typeof p === 'string' && p && !PATH.isAbsolute(p)) ? PATH.resolve(USER_DIR, p) : p;
// Module paths ('./setup.ts', 'setup.ts') are resolved when the file exists there, as Playwright does;
// package names ('my-pkg/setup') are left for Node to find.
const absModule = p => {
  if (typeof p !== 'string' || !p || PATH.isAbsolute(p)) return p;
  const local = PATH.resolve(USER_DIR, p);
  return p.startsWith('.') || FS.existsSync(local) ? local : p;
};
// A snapshot path template is relative to the config's folder unless it starts with an absolute token.
const absTemplate = t => (typeof t === 'string' && t && !PATH.isAbsolute(t) && !/^\{(testDir|snapshotDir)\}/.test(t)) ? PATH.join(USER_DIR, t) : t;
const tmpl = (e, k) => (e[k] && typeof e[k].pathTemplate === 'string') ? { ...e, [k]: { ...e[k], pathTemplate: absTemplate(e[k].pathTemplate) } } : e;
const dirFields = o => ({
  ...(o.testDir !== undefined ? { testDir: abs(o.testDir) } : {}),
  ...(o.outputDir !== undefined ? { outputDir: abs(o.outputDir) } : {}),
  ...(o.snapshotDir !== undefined ? { snapshotDir: abs(o.snapshotDir) } : {}),
  ...(typeof o.snapshotPathTemplate === 'string' ? { snapshotPathTemplate: absTemplate(o.snapshotPathTemplate) } : {}),
  ...(o.expect ? { expect: tmpl(tmpl(o.expect, 'toHaveScreenshot'), 'toMatchAriaSnapshot') } : {}),
});
const servers = ws => (Array.isArray(ws) ? ws : [ws]).map(w => ({ ...w, cwd: abs(w.cwd !== undefined ? w.cwd : '.') }));
const user = {
  ...raw,
  ...dirFields(raw),
  testDir: abs(raw.testDir !== undefined ? raw.testDir : '.'),
  ...(raw.outputDir === undefined ? { outputDir: abs('test-results') } : {}),
  ...(raw.globalSetup ? { globalSetup: Array.isArray(raw.globalSetup) ? raw.globalSetup.map(absModule) : absModule(raw.globalSetup) } : {}),
  ...(raw.globalTeardown ? { globalTeardown: Array.isArray(raw.globalTeardown) ? raw.globalTeardown.map(absModule) : absModule(raw.globalTeardown) } : {}),
  ...(typeof raw.tsconfig === 'string' ? { tsconfig: abs(raw.tsconfig) } : {}),
  ...(raw.projects ? { projects: raw.projects.map(p => ({ ...p, ...dirFields(p) })) } : {}),
  ...(raw.webServer ? { webServer: Array.isArray(raw.webServer) ? servers(raw.webServer) : servers(raw.webServer)[0] } : {}),
};
const expectMs = Number(process.env.MUSTFAIL_EXPECT_MS || 0);
const userExpect = (user.expect && user.expect.timeout) || 5000;
if (process.env.MUSTFAIL_PREFLIGHT) {
  const pick = u => (u && u.baseURL) || null;
  FS.writeFileSync(process.env.MUSTFAIL_PREFLIGHT, JSON.stringify({
    baseURL: pick(user.use),
    projects: (user.projects || []).map(p => ({ name: p.name || '', baseURL: pick(p.use), dependencies: p.dependencies || [], teardown: p.teardown || null })),
  }));
}
const actionMs = Number(process.env.MUSTFAIL_ACTION_MS || 0);
// Projects other projects depend on (login, seeding, teardown) run once, not once per repeat: their
// repeats would all run up front, before the first real test, as so many extra logins.
const support = new Set((user.projects || []).flatMap(p => [...(p.dependencies || []), ...(p.teardown ? [p.teardown] : [])]));
const projects = user.projects && user.projects.map(p => ({
  ...p,
  ...(support.has(p.name) ? { repeatEach: 1 } : {}),
  ...(actionMs ? { use: { ...(p.use || {}), actionTimeout: actionMs } } : {}),
}));
${IS_MODULE ? 'export default' : 'module.exports ='} {
  ...user,
  retries: 0,
  forbidOnly: false,
  // Fault runs fail on purpose: a failure limit from the config (often set for CI) would stop them early.
  maxFailures: 0,
  // Every test runs several times, so a whole-run time limit scales with the repeat count.
  ...(user.globalTimeout ? { globalTimeout: user.globalTimeout * Math.max(1, Number(process.env.MUSTFAIL_REPEAT || 1)) } : {}),
  // A fault run must never write or rewrite a snapshot from a page showing wrong data.
  ...(process.env.MUSTFAIL_MODE === 'fault' ? { updateSnapshots: 'none' } : {}),
  reporter: [[${reporter}]],
  repeatEach: Number(process.env.MUSTFAIL_REPEAT || 1),
  expect: { ...(user.expect || {}), ...(expectMs ? { timeout: Math.min(userExpect, expectMs) } : {}) },
  ...(actionMs ? { use: { ...(user.use || {}), actionTimeout: actionMs, navigationTimeout: Math.max(actionMs, 30000) } } : {}),
  ...(projects ? { projects } : {}),
};
`;
  fs.writeFileSync(wrapper, body);
  return wrapper;
}

// Always run the project's own Playwright, never a copy next to mustfail.
function playwrightCli(configPath) {
  return require.resolve('@playwright/test/cli', { paths: [path.dirname(configPath)] });
}

// The running Playwright child, so a signal sent to mustfail (Ctrl-C, CI timeout, closed terminal)
// reaches it too. spawnSync would block signal handling until the whole phase finished.
let child = null;
function runPlaywright({ configPath, wrapper, env, extra, phase }) {
  // Playwright runs in the directory mustfail was started from, as `npx playwright test -c <config>` would:
  // configs often hold paths relative to it (storage state, test data), and so do file filters in `extra`.
  return new Promise(resolve => {
    child = spawn(process.execPath, [playwrightCli(configPath), 'test', '-c', wrapper, ...extra], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        ...env,
        MUSTFAIL_PHASE: phase,
        MUSTFAIL_ROOT: path.dirname(configPath),
        NODE_OPTIONS: nodeOptions(),
        PW_TEST_HTML_REPORT_OPEN: 'never',
      },
    });
    child.on('error', e => { child = null; resolve({ status: null, error: e }); });
    child.on('exit', (status, signal) => { child = null; resolve({ status, signal }); });
  });
}

function preflight({ configPath, wrapper, extra, out }) {
  const infoFile = path.join(out, 'preflight.json');
  fs.rmSync(infoFile, { force: true });
  const res = spawnSync(process.execPath, [playwrightCli(configPath), 'test', '-c', wrapper, '--list', '--reporter=list', ...extra], {
    cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MUSTFAIL_PREFLIGHT: infoFile, MUSTFAIL_ROOT: path.dirname(configPath),
      NODE_OPTIONS: nodeOptions() },
  });
  const info = readJson(infoFile) || { baseURL: null, projects: [] };
  const perProject = {};
  for (const line of (res.stdout || '').split('\n')) {
    // "  [project] › dir/file.spec.ts:3:5 › title" (the file path may hold spaces)
    const m = /^\s+(?:\[(.+?)\] › )?[^›]+:\d+:\d+ › /.exec(line);
    if (m) { const name = m[1] || ''; perProject[name] = (perProject[name] || 0) + 1; }
  }
  const total = Object.values(perProject).reduce((a, b) => a + b, 0);
  if (!total) fail(`Playwright listed no tests${extra.length ? ` for: ${extra.join(' ')}` : ''}. Check that \`npx playwright test --list\` works with the same arguments.\n${(res.stderr || res.stdout || '').trim().slice(-2000)}`);
  return { ...info, perProject, total };
}

function isLocalUrl(u) {
  try { return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(new URL(u).hostname); } catch { return true; }
}

function confirm(question) {
  process.stdout.write(question);
  const buf = Buffer.alloc(64);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let answer = '';
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const n = fs.readSync(0, buf, 0, buf.length, null);
      if (n === 0) break;
      answer += buf.toString('utf8', 0, n);
      if (answer.includes('\n')) break;
    } catch (e) {
      if (e.code === 'EAGAIN') { Atomics.wait(pause, 0, 0, 50); continue; }
      break;
    }
  }
  return /^y/i.test(answer.trim());
}

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.cmd || opts.cmd === 'help') { console.log(HELP); return; }
  if (opts.cmd === 'version') { console.log(require('../package.json').version); return; }
  if (opts.cmd !== 'run') fail(`Unknown command: ${opts.cmd}\n\n${HELP}`);

  const configPath = findConfig(opts.config);
  const { playwrightVersion, isModule } = checkProject(configPath);
  IS_MODULE = !!isModule;
  const out = path.resolve(opts.out);
  try {
    if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });
    fs.accessSync(out, fs.constants.W_OK);
    // baseline.json and plan.json hold samples of what the API returned (names, emails, whatever the app
    // shows). Keep the folder out of git unless the user decides otherwise.
    const ignore = path.join(out, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# Created by mustfail: this folder holds samples of API responses.\n*\n');
  } catch (e) {
    fail(`Cannot write to the output folder ${out} (${e.code || e.message}). Pick another with --out.`);
  }
  const files = {
    baseline: path.join(out, 'baseline.json'),
    plan: path.join(out, 'plan.json'),
    faults: path.join(out, 'faults.json'),
    report: path.join(out, 'report.json'),
    html: path.join(out, 'report.html'),
  };

  removeStaleWrappers(path.dirname(configPath)); // left next to the config by mustfail before alpha.36
  removeStaleWrappers(out);
  const wrapper = writeWrapper(configPath, out);
  // Ctrl-C, a closed terminal or a sleeping laptop that kills the run must not leave our config behind.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      // Stop Playwright first (it shuts down its workers and web server), then remove our config.
      const done = () => { try { fs.rmSync(wrapper, { force: true }); } catch {} process.exit(sig === 'SIGINT' ? 130 : 143); };
      if (!child) return done();
      child.once('exit', done);
      // Ctrl-C in a terminal already reached Playwright (same process group); a second SIGINT would make it
      // skip its own cleanup, so give it a moment to stop by itself first.
      const send = () => { try { child && child.kill(sig === 'SIGHUP' ? 'SIGTERM' : sig); } catch {} };
      if (sig === 'SIGINT') setTimeout(send, 3000).unref(); else send();
      setTimeout(() => { try { child && child.kill('SIGKILL'); } catch {} done(); }, 15000).unref();
    });
  }
  const started = Date.now();
  try {
    console.log(`mustfail: Playwright ${playwrightVersion}, config ${path.relative(process.cwd(), configPath) || configPath}`);
    const pre = preflight({ configPath, wrapper, extra: opts.extra, out });
    const support = new Set(pre.projects.flatMap(p => [...p.dependencies, ...(p.teardown ? [p.teardown] : [])]));
    const selected = Object.keys(pre.perProject);
    const topLevel = selected.filter(p => !support.has(p));
    const projectArg = opts.extra.some(a => a === '--project' || a.startsWith('--project='));
    if (topLevel.length > 1 && !projectArg) {
      fail(`This selection runs ${topLevel.length} projects: ${topLevel.join(', ')}.\n` +
        'Running every project at once can include cleanup or destructive projects, and runs shared tests more than once.\n' +
        'Pick one with: npx mustfail run -- --project=<name> [files or folders]');
    }
    const urls = [...new Set([pre.baseURL, ...pre.projects.filter(p => selected.includes(p.name)).map(p => p.baseURL)].filter(Boolean))];
    const remote = urls.filter(u => !isLocalUrl(u));
    const testRuns = pre.total;
    console.log(`Selected ${testRuns} tests${selected.some(Boolean) ? ` in ${selected.length} project(s): ${selected.map(p => `${p} (${pre.perProject[p]})`).join(', ')}` : ''}`);
    console.log(`Target: ${urls.join(', ') || 'no baseURL set'}`);
    console.log(`This will run each test up to ${2 + 1 + opts.maxTargeted + 4} times (2 baseline, 1 blackout, up to ${opts.maxTargeted} targeted faults, up to 2 probes of the page's main list, 1 failed write, 1 flip of true/false fields).`);
    if (remote.length && !opts.allowRemote) {
      fail(`\nThe target is not local (${remote.join(', ')}).\n` +
        'Fault runs repeat every request your tests make, including creates, updates and deletes that the fault does not target.\n' +
        'On a shared environment that means extra test data and load. If you accept that, rerun with --allow-remote.');
    }
    if (!opts.yes && process.stdin.isTTY && !confirm('Continue? [y/N] ')) { console.log('Stopped.'); return; }
    let previous = null;
    try { previous = readJson(files.report); } catch {}
    for (const f of Object.values(files)) fs.rmSync(f, { force: true });
    console.log('1/3 Baseline: running the suite twice with no faults');
    await runPlaywright({ configPath, wrapper, extra: opts.extra, phase: 'baseline',
      env: { MUSTFAIL_MODE: 'baseline', MUSTFAIL_REPEAT: '2', MUSTFAIL_RESULTS: files.baseline } });
    const baseline = readJson(files.baseline);
    if (!baseline || baseline.rows.length === 0) fail('The baseline run produced no results. Check that `npx playwright test` works in this project.');

    const ran = baseline.rows.filter(r => r.status !== 'skipped' && !(baseline.setupProjects || []).includes(r.project));
    if (ran.length && !ran.some(r => r.traffic)) {
      console.log('Note: mustfail saw no test using its `test` object, so it could record nothing. It hooks `@playwright/test` imports in your own files; ' +
        'tests whose `test` comes from a package in node_modules, that create their own browser context, or that never open a page are out of its reach.');
    } else if (ran.some(r => r.traffic && r.traffic.noBodyTracking)) {
      console.log(`Note: this Playwright version (${playwrightVersion}) changed an internal mustfail uses to tell a test's body from its setup and teardown. ` +
        'Faults will also apply during setup and teardown, and setup writes count as the test\'s own. Please report this.');
    }
    const plan = buildPlan(baseline, { maxTargeted: opts.maxTargeted });
    const expectMs = opts.expectTimeout || Math.max(1500, Math.ceil(plan.slowestExpectMs * 3));
    fs.writeFileSync(files.plan, JSON.stringify(plan, null, 1));
    const planned = Object.keys(plan.tests).length;
    const faultRuns = Object.values(plan.tests).reduce((n, t) => n + t.faults.length, 0);
    console.log(`2/3 Planned ${faultRuns} fault runs for ${planned} tests (${Object.keys(plan.excluded).length} not measurable); assertion timeout ${expectMs} ms`);

    if (planned > 0) {
      console.log('3/3 Fault runs (failures here are expected: a failure means the test noticed)');
      await runPlaywright({ configPath, wrapper, extra: opts.extra, phase: 'faults',
        env: { MUSTFAIL_MODE: 'fault', MUSTFAIL_PLAN: files.plan, MUSTFAIL_REPEAT: String(plan.maxFaults),
          MUSTFAIL_RESULTS: files.faults, MUSTFAIL_EXPECT_MS: String(expectMs),
          ...(opts.actionTimeout ? { MUSTFAIL_ACTION_MS: String(opts.actionTimeout) } : {}) } });
    }
    const faults = readJson(files.faults);
    if (planned > 0 && (!faults || !faults.rows.some(r => r.fault))) {
      fail('The fault runs produced no results: Playwright stopped before any of them finished (see its output above). Nothing was graded.');
    }
    // Runs that broke in setup for a reason the fault cannot explain: re-run the likely culprits clean,
    // then retry those runs once (lost.js).
    const retry = planned > 0 ? retryPlan(plan, faults.rows) : null;
    if (retry) {
      const retryFiles = { plan: path.join(out, 'retry-plan.json'), faults: path.join(out, 'retry.json') };
      fs.writeFileSync(retryFiles.plan, JSON.stringify(retry.plan, null, 1));
      console.log(`   ${retry.lost} fault runs broke in setup before their fault touched anything. Re-running ${retry.clean.length} tests that failed just before them with no fault, then retrying those runs.`);
      fs.rmSync(retryFiles.faults, { force: true });
      await runPlaywright({ configPath, wrapper, extra: opts.extra, phase: 'retry',
        env: { MUSTFAIL_MODE: 'fault', MUSTFAIL_PLAN: retryFiles.plan, MUSTFAIL_REPEAT: String(retry.plan.maxFaults),
          MUSTFAIL_RESULTS: retryFiles.faults, MUSTFAIL_EXPECT_MS: String(expectMs),
          ...(opts.actionTimeout ? { MUSTFAIL_ACTION_MS: String(opts.actionTimeout) } : {}) } });
      const again = readJson(retryFiles.faults) || { rows: [] };
      const merged = mergeRetry(faults.rows, again.rows, retry.clean);
      faults.rows = merged.rows;
      const name = k => { const m = plan.info[k]; return m ? `${m.file}:${m.line} ${m.title}` : k; };
      faults.lost = merged.info && { ...merged.info, suspects: retry.clean.map(name) };
      fs.writeFileSync(files.faults, JSON.stringify(faults, null, 1));
    }
    const faultEnv = { MUSTFAIL_MODE: 'fault', MUSTFAIL_EXPECT_MS: String(expectMs),
      ...(opts.actionTimeout ? { MUSTFAIL_ACTION_MS: String(opts.actionTimeout) } : {}) };
    let graded = grade(plan, faults || { rows: [] });
    // Each strong or write-gated grade rests on one run. Repeat that run once; where the two disagree the
    // weaker result counts (confirm.js).
    const confirm = planned > 0 && opts.confirm ? confirmPlan(plan, faults.rows, graded) : null;
    if (confirm) {
      const confirmFiles = { plan: path.join(out, 'confirm-plan.json'), faults: path.join(out, 'confirm.json') };
      fs.writeFileSync(confirmFiles.plan, JSON.stringify(confirm.plan, null, 1));
      fs.rmSync(confirmFiles.faults, { force: true });
      console.log(`   Repeating the ${confirm.count} ${confirm.count === 1 ? 'run a strong or write-gated grade rests' : 'runs that strong and write-gated grades rest'} on`);
      await runPlaywright({ configPath, wrapper, extra: opts.extra, phase: 'confirm',
        env: { ...faultEnv, MUSTFAIL_PLAN: confirmFiles.plan, MUSTFAIL_REPEAT: String(confirm.plan.maxFaults), MUSTFAIL_RESULTS: confirmFiles.faults } });
      const again = readJson(confirmFiles.faults) || { rows: [] };
      const merged = mergeConfirm(faults.rows, again.rows);
      faults.rows = merged.rows;
      faults.confirm = { repeated: confirm.count, same: merged.same, differed: merged.differed };
      fs.writeFileSync(files.faults, JSON.stringify(faults, null, 1));
      graded = grade(plan, faults);
      if (merged.differed) console.log(`   ${merged.differed} of them came out differently the second time; the weaker result is counted (see the notes).`);
    }
    for (const r of graded.results) delete r.decidedBy;
    const since = compare(previous, graded);
    if (since) graded.since = since;
    const meta = { when: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC', playwright: playwrightVersion,
      seconds: Math.round((Date.now() - started) / 1000) };
    fs.writeFileSync(files.report, JSON.stringify({ meta, ...graded }, null, 1));
    writeHtml(files.html, graded, meta);
    printConsole(graded);
    for (const line of compareLines(since)) console.log(line);
    if (since) console.log('');
    const broken = graded.results.filter(r => /^Fails without any fault/.test(r.reason || '')).length;
    if (broken * 2 > graded.results.length) {
      console.log(`Note: ${broken} of ${graded.results.length} tests fail with no fault at all. Check the app is up and the suite passes on its own (npx playwright test) before reading these grades.`);
    }
    console.log(`Report: ${path.relative(process.cwd(), files.html)}  (${meta.seconds} s total)`);
    if (opts.failOn?.length) {
      const hit = graded.results.filter(r => opts.failOn.includes(r.grade));
      if (hit.length) { console.log(`--fail-on: ${hit.length} tests graded ${[...new Set(hit.map(r => r.grade))].join(', ')}.`); process.exitCode = 1; }
    }
  } finally {
    fs.rmSync(wrapper, { force: true });
  }
}

main().catch(e => {
  if (e instanceof Stop) { console.error(e.message); process.exitCode = 2; }
  else { console.error(e && e.stack || e); process.exitCode = 1; }
});
