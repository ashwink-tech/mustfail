'use strict';
// Replaces the user's reporters during a mustfail run. Records one row per test result
// and prints a single progress line, so the terminal is not flooded by expected failures.
const fs = require('fs');
const path = require('path');
// Windows paths can differ in drive-letter case between Playwright's locations and __dirname.
const norm = p => process.platform === 'win32' ? String(p).toLowerCase() : String(p);
const sameStart = (p, dir) => norm(p).startsWith(norm(dir));
const samePath = (a, b) => norm(a) === norm(b);
const { testKey } = require('./shared');
// Paths in results use forward slashes on every OS, so reports and saved grades compare across machines.
const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

const VISIBILITY_ONLY = new Set(['toBeVisible', 'toBeAttached', 'toBeInViewport', 'toBeEnabled', 'toBeHidden']);

class MustfailReporter {
  constructor() {
    this.rows = [];
    this.steps = new Map();
    this.done = 0;
    this.total = 0;
    this.rootDir = '';
  }
  printsToStdio() { return true; }

  onBegin(config, suite) {
    this.rootDir = config.rootDir;
    this.total = suite.allTests().length;
    this.setupProjects = [...new Set(config.projects.flatMap(p => [...(p.dependencies || []), ...(p.teardown ? [p.teardown] : [])]))];
  }

  onStepEnd(test, result, step) {
    const id = `${test.id}#${result.retry}#${result.workerIndex}#${result.startTime?.getTime?.()}`;
    const list = this.steps.get(id) || [];
    if (step.category === 'expect') {
      // Playwright titles a negated matcher 'Expect "not toBeChecked"'.
      const m = /^Expect "(?:not )?(\w+)"/.exec(step.title) || /^expect\.(?:soft\.)?(?:not\.)?(\w+)/.exec(step.title);
      const negated = /^Expect "not |^expect\.(?:soft\.)?not\./.test(step.title);
      // Where expect() was called: in the spec itself, or in a helper (a page object, a shared util).
      // A helper that checks its own setup (the row it just created is visible) is not the test's check.
      // In baseline runs our own expect wrapper is the caller Playwright sees; that location means nothing.
      const loc = step.location && !sameStart(step.location.file, __dirname + path.sep) ? step.location : undefined;
      list.push({ kind: 'expect', matcher: m ? m[1] : step.title.slice(0, 60), ...(negated ? { negated: true } : {}), ms: step.duration, failed: !!step.error,
        at: loc ? `${rel(this.rootDir, loc.file)}:${loc.line}` : undefined,
        inSpec: loc ? samePath(loc.file, test.location.file) : undefined });
    } else if (step.category === 'pw:api' && /wait for timeout|waitForTimeout/i.test(step.title)) {
      list.push({ kind: 'sleep', ms: step.duration });
    }
    this.steps.set(id, list);
  }

  onTestEnd(test, result) {
    const id = `${test.id}#${result.retry}#${result.workerIndex}#${result.startTime?.getTime?.()}`;
    const att = name => {
      const a = result.attachments.find(x => x.name === name);
      if (!a) return undefined;
      const buf = a.body || (a.path && fs.existsSync(a.path) ? fs.readFileSync(a.path) : null);
      try { return buf ? JSON.parse(buf.toString('utf8')) : undefined; } catch { return undefined; }
    };
    const project = test.parent.project()?.name || '';
    const steps = this.steps.get(id) || [];
    this.steps.delete(id);
    // In a serial group, a failure skips the rest of the group in that run (Playwright internal field,
    // read defensively).
    let serial = false, serialGroup = null;
    for (let p = test.parent; p; p = p.parent) if (p._parallelMode === 'serial') {
      serial = true; serialGroup = `${project}|${test.location?.file || ''}|${p.titlePath().join(' > ')}`;
    }
    this.rows.push({
      serial, serialGroup,
      key: testKey(project, test.titlePath().slice(2)),
      project,
      title: test.title,
      file: rel(this.rootDir, test.location.file),
      line: test.location.line,
      repeat: test.repeatEachIndex,
      status: result.status,
      // test.fail(): the test is expected to fail (a known open bug), so a failure is its normal result.
      expectedFail: test.expectedStatus === 'failed',
      ms: result.duration,
      // Start order: lets mustfail find the runs that came just before a stretch of broken setups.
      started: result.startTime?.getTime?.(),
      worker: result.workerIndex,
      error: (result.error?.message || '').replace(/\u001b\[[\d;]*m/g, '').split('\n').find(l => l.trim()) || '',
      // Did an assertion fail, or did an action (click, fill, waitFor) time out first?
      errorKind: !result.error ? undefined
        : (result.error.matcherResult || /expect\(/.test(result.error.message || '')) ? 'assertion' : 'action',
      expects: steps.filter(s => s.kind === 'expect'),
      sleeps: steps.filter(s => s.kind === 'sleep').length,
      visibilityOnly: steps.some(s => s.kind === 'expect') && steps.filter(s => s.kind === 'expect').every(s => VISIBILITY_ONLY.has(s.matcher)),
      traffic: att('mustfail-traffic'),
      fault: att('mustfail-fault'),
    });
    if (result.status !== 'skipped') this.done++;
    if (result.status === 'skipped') return;
    const label = process.env.MUSTFAIL_PHASE || 'run';
    // One line rewritten in place on a terminal; in a CI log, a line every 25 runs instead of one per run.
    if (process.stdout.isTTY) process.stdout.write(`\r  ${label}: ${this.done} runs finished`);
    else if (this.done % 25 === 0) process.stdout.write(`  ${label}: ${this.done} runs finished\n`);
  }

  // Errors outside any test (a failing globalSetup, a web server that will not start, a crashed worker).
  // mustfail replaces the project's reporters, so nothing else would show them.
  onError(error) {
    const text = String((error && (error.stack || error.message || error.value)) || error || '').replace(/\u001b\[[\d;]*m/g, '');
    process.stderr.write(`\n  Playwright error: ${text.split('\n').slice(0, 8).join('\n  ')}\n`);
  }

  onEnd() {
    process.stdout.write(process.stdout.isTTY ? '\n' : `  ${process.env.MUSTFAIL_PHASE || 'run'}: ${this.done} runs finished\n`);
    const out = process.env.MUSTFAIL_RESULTS;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ rootDir: this.rootDir, setupProjects: this.setupProjects, rows: this.rows }, null, 1));
  }
}

module.exports = MustfailReporter;
