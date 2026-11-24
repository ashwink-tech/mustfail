'use strict';
// Fault runs that broke for a reason that has nothing to do with their fault.
//
// A fault run makes a test fail on purpose. A test whose cleanup sits at the end of its body (turn a
// setting back off, delete what it made) skips that cleanup when it fails, and what it leaves behind
// can break the setup of the tests after it. Strapi's rate-limit test turns rate limiting on, then
// off at the end; when a fault made it fail, every later login hit HTTP 429 and 96 of 230 fault runs
// broke in setup. Counting those runs would grade tests on an outage of the suite's own making.
//
// A run is lost when it failed before the test body started and its fault never touched a request:
// the fault cannot be what broke it.

const isLost = r => !!r.fault && r.fault.op !== 'alone' && r.fault.op !== 'clean' &&
  (r.status === 'failed' || r.status === 'timedOut') && !r.expectedFail &&
  r.fault.bodyStarted === false && !r.fault.applied && !r.fault.handlerErrors;

const order = rows => rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.started ?? a.i) - (b.r.started ?? b.i) || a.i - b.i);

// Tests that failed in the runs just before each stretch of lost runs began: the likely source of
// whatever was left behind. Their clean (no fault) runs usually undo it, the same way their passing
// runs did in the baseline.
function suspects(rows, { lookBack = 15, max = 25 } = {}) {
  const seq = order(rows).map(x => x.r).filter(r => r.fault && r.status !== 'skipped');
  // Order: tests that failed before more stretches first, then the closest. A shortlist, not a diagnosis:
  // tests in the same file run back to back, so the culprit and its neighbours look the same here.
  const score = new Map();
  for (let i = 0; i < seq.length; i++) {
    if (!isLost(seq[i]) || (i > 0 && isLost(seq[i - 1]))) continue;
    const seen = new Set();
    for (let j = i - 1; j >= Math.max(0, i - lookBack); j--) {
      const p = seq[j];
      if (isLost(p) || p.status === 'passed' || p.fault.bodyStarted === false || seen.has(p.key)) continue;
      seen.add(p.key);
      const s = score.get(p.key) || { stretches: 0, near: 0, first: score.size };
      s.stretches++; s.near += 1 / (i - j);
      score.set(p.key, s);
    }
  }
  return [...score.entries()].sort((a, b) => b[1].stretches - a[1].stretches || b[1].near - a[1].near || a[1].first - b[1].first)
    .map(([k]) => k).slice(0, max);
}

// A plan that first runs each suspect once with no fault (repeat 0), then repeats every lost run
// (repeats 1..n). Playwright runs repeat 0 of every test before repeat 1, so the clean runs go first.
function retryPlan(plan, faultRows) {
  const lost = faultRows.map((r, i) => ({ r, i })).filter(x => isLost(x.r));
  if (!lost.length) return null;
  const clean = suspects(faultRows);
  const tests = {};
  for (const key of clean) tests[key] = { faults: [{ op: 'clean' }] };
  for (const { r, i } of lost) {
    const { applied, handlerErrors, bodyStarted, ...fault } = r.fault;
    const t = tests[r.key] || (tests[r.key] = { faults: [null] });
    t.faults.push({ ...fault, retryOf: i });
  }
  const maxFaults = Math.max(...Object.values(tests).map(t => t.faults.length));
  return { plan: { ...plan, tests, maxFaults }, lost: lost.length, clean };
}

// Replaces each lost run with its retry. Retries that are lost again stay lost.
function mergeRetry(faultRows, retryRows, clean = []) {
  const rows = faultRows.slice();
  let recovered = 0;
  for (const r of retryRows) {
    if (!r.fault || r.fault.retryOf === undefined) continue;
    const i = r.fault.retryOf;
    if (!isLost(r)) recovered++;
    rows[i] = { ...r, retried: true };
  }
  const lostRows = faultRows.filter(isLost);
  const stillLost = rows.filter(isLost);
  return { rows, info: summary(lostRows, stillLost, recovered, clean) };
}

function summary(lostRows, stillLost, recovered, clean) {
  if (!lostRows.length) return null;
  const errors = new Map();
  for (const r of lostRows) {
    const e = (r.error || '(no error message)').slice(0, 200);
    errors.set(e, (errors.get(e) || 0) + 1);
  }
  const [error, n] = [...errors.entries()].sort((a, b) => b[1] - a[1])[0];
  return { lost: lostRows.length, recovered, stillLost: stillLost.length, error, errorCount: n,
    tests: new Set(lostRows.map(r => r.key)).size, cleaned: clean };
}

module.exports = { isLost, suspects, retryPlan, mergeRetry, summary };
