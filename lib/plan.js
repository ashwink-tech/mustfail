'use strict';
const { appearsIn, mergeShapes, isPersistingWrite } = require('./shared');
// Turns the baseline into a fault plan: one blackout per test, then up to `maxTargeted`
// faults aimed at the endpoints most specific to that test (called by the fewest tests).

function groupByKey(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.key)) map.set(r.key, []);
    map.get(r.key).push(r);
  }
  return map;
}

function mergeTraffic(runs) {
  const merged = new Map();
  const asserted = new Map();
  for (const run of runs) {
    const traffic = run.traffic || {};
    for (const a of traffic.asserted || []) {
      const item = typeof a === 'string' ? { t: a, m: '' } : a;
      asserted.set(item.m + '\u0000' + item.t, item);
    }
    for (const e of traffic.endpoints || []) {
      const cur = merged.get(e.key);
      if (!cur) merged.set(e.key, { ...e });
      // Both runs' data: each run created its own rows, and only that run's assertion text names them.
      else { cur.count += e.count; cur.real += e.real || 0; cur.mocked = cur.mocked || e.mocked; cur.shape = mergeShapes(cur.shape, e.shape, { keepLate: true }); }
    }
  }
  return { endpoints: [...merged.values()], asserted: [...asserted.values()] };
}

// How strongly an assertion ties a test to a response value (lower is stronger).
//   0    the asserted text is exactly the value (toHaveText('Active') and status: "Active")
//   0.2  a value assertion on short text that contains the value
//   null visibility-style assertions and long text blocks: too broad to count as a link
const VALUE_MATCHERS = /^(toHaveText|toContainText|toHaveValue|toHaveValues|toHaveCount|toHaveAttribute|toHaveAccessibleName|toHaveTitle|toHaveJSProperty)$/;
const SHORT_TEXT = 200;
//   1.2  a visibility or negated assertion whose short text is exactly the value
//   1.4  a visibility or negated assertion on short text containing the value
// Weak links pick targets but never count as "the test checks server data".
function linkStrength(value, assertion) {
  const m = assertion.m || '';
  const negated = m.startsWith('not.');
  const base = negated ? m.slice(4) : m;
  const strong = VALUE_MATCHERS.test(base) && !negated;
  const text = assertion.t.trim();
  if (!text || text.length > SHORT_TEXT) return null;
  const exact = String(value).trim() === text;
  if (assertion.k) {
    // A value the test wrote down (expected argument) or compared directly (expect(x).toBe).
    // Such checks are value checks even when the matcher is toBe/toEqual.
    const contained = typeof value === 'string' && text.length >= 8 && value.includes(text);
    let hit = exact ? 0 : (contained || appearsIn(value, text)) ? 0.2 : null;
    if (hit === null) return null;
    // A plain value may come from anywhere (often a Node-side API call the browser never sees),
    // so rank it below text read off the page.
    if (assertion.k === 'value') hit += 0.1;
    return negated ? hit + 1.2 : hit;
  }
  if (strong) return exact ? 0 : (appearsIn(value, text) ? 0.2 : null);
  return exact ? 1.2 : (appearsIn(value, text) ? 1.4 : null);
}

// A value that appears only in a later response (after the test's own actions) and carries digits (a
// generated name, a timestamp suffix) was made by the test, so matching it is no coincidence even when the
// assertion only checks visibility. Negated assertions stay weak: they hold once the row is gone.
const isCreated = l => l.late === true && typeof l.value === 'string' && l.value.length >= 8 && /\d/.test(l.value);
function leafLink(leaf, assertion) {
  const s = linkStrength(leaf.value, assertion);
  return s !== null && s >= 1 && isCreated(leaf) && !(assertion.m || '').startsWith('not.') ? 0.3 : s;
}

// Candidate faults for one test, best first:
//   0-0.3  change a value the test's assertions checked, or empty the list it came from
//   1      fail a write the test made
//   2-3    fallbacks: empty the test's most specific list, change its first field
function candidatesFor(endpoints, asserted, usage, testCount = 0, spread = new Map()) {
  const out = [];
  let linkedAny = false;
  // A short number on the page (a badge, "2 total") matches values in many unrelated responses: a page
  // size, a minimum, a count from another list. When it matches in three or more different calls it does
  // not say where it came from, so it can pick a fault but does not show the test checks server data.
  const ambiguous = new Set();
  for (const a of asserted) {
    if (!/\d/.test(a.t)) continue;
    const calls = new Set();
    for (const e of endpoints) {
      if (e.write || e.telemetry || !e.shape) continue;
      const hit = (e.shape.leaves || []).some(l => typeof l.value === 'number' && Math.abs(l.value) < 100 && (linkStrength(l.value, a) ?? 9) < 1);
      if (hit) calls.add(e.key);
    }
    if (calls.size >= 3) ambiguous.add(a);
  }
  for (const e of endpoints) {
    if (e.mocked && !e.real) continue; // the test answers this call itself; faults cannot reach it
    if (e.telemetry) continue;           // error reporting and analytics: no test depends on them
    if (e.write && e.inBody === 0) continue; // only made while setting up or cleaning up: not the test's own write
    if (e.write) {
      // A write most tests make (permission checks, heartbeats) is incidental, not what this test is about.
      // Frequency only marks helper writes as incidental (permission checks, previews everyone makes);
      // a write that persists something stays the test's own, however many tests in the folder make it.
      // The operation name for GraphQL; for REST the method and path (POST /roles/batch-delete).
      const persistingName = isPersistingWrite(e.key, e.status);
      const shared = !persistingName && (usage.get(e.key) || 0) > Math.max(2, 0.6 * testCount);
      // A write only this test (or one other) makes is usually what the test is about: try it early.
      // A write that persists something (create, update, delete) before helper calls (previews, validations).
      const persisting = persistingName;
      out.push({ score: shared ? 2.5 : (persisting ? 0.5 : 0.7), fault: { op: 'fail-write', endpoint: e.key, ...(persisting ? { persisting: true } : {}) } });
      continue;
    }
    const shape = e.shape;
    if (!shape) continue;
    const linkedLists = new Map();
    // Session-wide data nearly every test receives (profile, permissions, menus): a value the test
    // compared in code ("download", "read") matching there is a coincidence, not a dependency.
    const global = testCount >= 4 && (usage.get(e.key) || 0) > 0.6 * testCount;
    // Stamped on the fault so the grader can say "most tests read this call" when it is all that broke a test.
    const wide = global ? { sessionWide: true } : {};
    for (const leaf of shape.leaves || []) {
      let best = null;
      for (const a of asserted) {
        if (global && a.k === 'value') continue;
        let s = leafLink(leaf, a);
        if (s !== null && s < 1 && typeof leaf.value === 'number' && ambiguous.has(a)) s += 1.2;
        if (s !== null && (best === null || s < best)) best = s;
      }
      if (best === null) continue;
      // Matching text in session-wide data (menus, profile) is a weak link at best: it can still pick a
      // fault, but it does not show the test checks server data.
      // A value the test created is the exception: it cannot be a coincidence with data every test receives.
      // (A feature folder's own list is read by most of its tests, so it counts as session-wide here.)
      // So is a value only this test sees (a record its fixture created, named with digits): data every
      // test receives is the same for each of them, so a value unique to one test is not session-wide.
      const ownValue = isCreated(leaf) || (typeof leaf.value === 'string' && leaf.value.length >= 8 && /\d/.test(leaf.value)
        && (spread.get(e.key)?.get(leaf.value) || 0) <= 1);
      if (global && best < 1 && !(ownValue && best <= 0.3)) best += 1.2;
      if (best < 1) linkedAny = true;
      // Change the field in every row of its list: the row the test reads is not always row 0
      // (parallel tests create rows, lists re-sort).
      // Every index becomes '*': in nested lists (audit entries > changes) the row the test reads
      // can sit under any parent row.
      const rowPath = leaf.path.map(p => (typeof p === 'number' ? '*' : p));
      // A string (or a big number) the test checked is changed everywhere it appears in the response:
      // APIs often send it twice (value and displayValue) and the page may show either.
      // The row's copies of the same value change with it (value / displayValue): the page may show either.
      // Matched at run time, because generated names differ between runs.
      // The same value often arrives from more than one endpoint (a list and a lookup): the page may
      // show either copy, so change it in each of them.
      const also = [];
      if (typeof leaf.value === 'string' && leaf.value.trim().length >= 4) {
        for (const o of endpoints) {
          if (o === e || o.write || o.telemetry || o.auth || !o.shape) continue;
          const hit = (o.shape.leaves || []).find(l => l.value === leaf.value);
          if (hit) also.push({ endpoint: o.key, path: hit.path.map(p => (typeof p === 'number' ? '*' : p)) });
          if (also.length >= 3) break;
        }
      }
      out.push({ score: best, created: isCreated(leaf) && best <= 0.3, fault: { op: 'change-value', endpoint: e.key, path: rowPath, linked: best < 1, sameInRow: true, ...(also.length ? { also } : {}), ...wide } });
      const idx = leaf.path.findIndex(p => typeof p === 'number');
      if (idx >= 0) {
        const listPath = leaf.path.slice(0, idx);
        const k = JSON.stringify(listPath);
        const cur = linkedLists.get(k);
        linkedLists.set(k, { path: listPath, score: Math.min(cur ? cur.score : 9, best), items: (cur ? cur.items : 0) + 1 });
      }
    }
    for (const l of linkedLists.values()) {
      // Strong link: the field matters most, so change it first, then empty its list.
      // Weak link: only presence is known, so emptying the list is the better probe.
      const score = l.score < 1 ? l.score + 0.1 : l.score - 0.15;
      out.push({ score, fault: { op: 'empty-list', endpoint: e.key, path: l.path, linked: l.score < 1, ...wide } });
    }
    if (shape.arrays?.length) {
      // The biggest list in a response is usually the page's main data.
      const biggest = [...shape.arrays].sort((a, b) => b.length - a.length)[0];
      out.push({ score: 2 - Math.min(biggest.length, 50) / 1000, fault: { op: 'empty-list', endpoint: e.key, path: biggest.path, ...wide } });
    }
    if (shape.leaves?.length) out.push({ score: 3, fault: { op: 'change-value', endpoint: e.key, path: shape.leaves[0].path, ...wide } });
  }
  return { candidates: out, linkedAny };
}

// Spreads faults across the different things a test checks: one per response area
// (endpoint + top-level field) first, alternating fault types within an area.
// A test that asserts a checkbox or enabled state reads a true/false the page got from the server, which
// text matching cannot link. Offer one fault that flips the booleans in the rows of the list it reads,
// preferring a list its checked text comes from, then the list with the most booleans.
const BOOL_MATCHERS = new Set(['toBeChecked', 'toBeEnabled', 'toBeDisabled', 'toBeEditable']);
function flipCandidate(endpoints, asserted) {
  let best = null;
  for (const e of endpoints) {
    if (e.write || e.telemetry || e.auth || (e.mocked && !e.real) || !e.shape?.arrays?.length) continue;
    for (const a of e.shape.arrays) {
      const inRow = l => a.path.every((p, i) => l.path[i] === p) && l.path.length > a.path.length;
      const rowLeaves = (e.shape.leaves || []).filter(inRow);
      const bools = rowLeaves.filter(l => l.type === 'boolean');
      if (!bools.length) continue;
      // Evidence the test uses this list: its rows hold text the test checked, or a true/false in them
      // changed between responses (the test toggled it and the list was read again). Config and menu
      // lists carry many booleans and neither signal, so they are skipped.
      const touched = rowLeaves.some(l => asserted.some(x => leafLink(l, x) !== null));
      const toggled = bools.filter(l => l.late).length;
      if (!touched && !toggled) continue;
      // Rank: toggled first, then touched, then the number of booleans.
      const rank = [toggled > 0 ? 1 : 0, touched ? 1 : 0, bools.length];
      const i = best ? rank.findIndex((v, k) => v !== best.rank[k]) : -1;
      const better = !best || (i >= 0 && rank[i] > best.rank[i]);
      if (better) best = { rank, fault: { op: 'flip-booleans', endpoint: e.key, path: a.path.map(p => (typeof p === 'number' ? '*' : p)) } };
    }
  }
  return best && best.fault;
}

function pickDiverse(ranked, max) {
  const groups = new Map();
  const seen = new Set();
  for (const c of ranked) {
    const f = c.fault;
    const id = `${f.op}|${f.endpoint}|${JSON.stringify(f.path || [])}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const area = `${f.endpoint}|${f.path && f.path.length ? f.path[0] : ''}`;
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(c);
  }
  const queues = [...groups.values()].map(list => {
    const out = [];
    const rest = [...list];
    while (rest.length) {
      const usedOps = new Set(out.map(c => c.fault.op));
      const i = rest.findIndex(c => !usedOps.has(c.fault.op));
      out.push(rest.splice(i >= 0 ? i : 0, 1)[0]);
      if (i < 0) continue;
    }
    return out;
  }).sort((a, b) => a[0].score - b[0].score);
  const picked = [];
  for (let round = 0; picked.length < max && queues.some(q => q[round]); round++) {
    for (const q of queues) if (q[round] && picked.length < max) picked.push(q[round].fault);
  }
  return picked;
}

function buildPlan(baseline, { maxTargeted = 3 } = {}) {
  const setupProjects = baseline.setupProjects || [];
  const groups = groupByKey(baseline.rows.filter(r => !setupProjects.includes(r.project)));
  const info = {};
  const excluded = {};
  const endpointsOf = {};

  for (const [key, runs] of groups) {
    const first = runs[0];
    const passed = runs.filter(r => r.status === 'passed');
    info[key] = {
      title: first.title, file: first.file, line: first.line, project: first.project,
      baselineMs: Math.max(...runs.map(r => r.ms)),
      expects: (passed[0] || first).expects.map(e => e.matcher),
      maxExpectMs: Math.max(0, ...passed.flatMap(r => r.expects.map(e => e.ms))),
      visibilityOnly: (passed[0] || first).visibilityOnly,
      sleeps: (passed[0] || first).sleeps,
      serial: !!first.serial,
      serialGroup: first.serialGroup || null,
    };
    if (runs.every(r => r.status === 'skipped')) { excluded[key] = 'The test skipped itself in baseline (test.skip or a skip condition), so there was nothing to run.'; continue; }
    if (runs.some(r => r.expectedFail)) { excluded[key] = 'Marked test.fail() (a known open bug): it is expected to fail, so what it does under a fault says nothing about its checks.'; continue; }
    if (passed.length === 0) {
      const err = (runs.find(r => r.error) || {}).error;
      excluded[key] = `Fails without any fault${err ? ` (${String(err).slice(0, 200)})` : ''}, so its result says nothing about faults.`;
      continue;
    }
    if (passed.length < runs.filter(r => r.status !== 'skipped').length) { excluded[key] = 'Unstable: passed and failed across two identical baseline runs.'; continue; }
    const merged = mergeTraffic(passed);
    const endpoints = merged.endpoints.filter(e => !e.auth);
    if (endpoints.length === 0) {
      excluded[key] = 'No API calls seen in the browser (server-rendered data, fully mocked network, API-only test, or a browser context the test created itself).';
      continue;
    }
    endpointsOf[key] = { endpoints, asserted: merged.asserted };
  }

  const usage = new Map();
  for (const { endpoints: eps } of Object.values(endpointsOf)) for (const e of eps) {
    // A write made only in setup (every test in a folder saves the same fixture) is not a use by that test.
    if (e.write && e.inBody === 0) continue;
    usage.set(e.key, (usage.get(e.key) || 0) + 1);
  }

  // How many tests saw each string value per endpoint: session-wide data repeats across tests.
  const spread = new Map();
  for (const { endpoints: eps } of Object.values(endpointsOf)) for (const e of eps) {
    if (!e.shape) continue;
    const m = spread.get(e.key) || new Map(); spread.set(e.key, m);
    for (const v of new Set((e.shape.leaves || []).filter(l => typeof l.value === 'string').map(l => l.value))) m.set(v, (m.get(v) || 0) + 1);
  }
  const tests = {};
  for (const [key, { endpoints, asserted: all }] of Object.entries(endpointsOf)) {
    // Assertions on a request the page sent check the app, not the server: no response fault can reach them.
    const asserted = all.filter(a => a.k !== 'request');
    const sentChecks = [...new Set(all.filter(a => a.k === 'request').map(a => a.t))].slice(0, 3);
    if (sentChecks.length) info[key].requestChecks = sentChecks;
    const { candidates, linkedAny } = candidatesFor(endpoints, asserted, usage, Object.keys(endpointsOf).length, spread);

    const ranked = candidates
      .sort((a, b) => a.score - b.score || (usage.get(a.fault.endpoint) || 0) - (usage.get(b.fault.endpoint) || 0));
    // Linked faults first, then failed writes, then fallbacks; spread within each tier.
    const targeted = [];
    // A value the test created itself is the most specific evidence there is, so it always gets a slot.
    // Without this, an exact match on a generic word ('Text' in a type dropdown's config) can take every
    // slot and the list holding the created row is never changed.
    // Only when the normal pick left it out does it replace the last pick from the linked tier (or the last
    // pick), so tests whose created row was already targeted keep their plan.
    for (const tier of [r => r.score < 1, r => r.score >= 1 && r.score < 2, r => r.score >= 2]) {
      if (targeted.length >= maxTargeted) break;
      targeted.push(...pickDiverse(ranked.filter(tier), maxTargeted - targeted.length));
    }
    const fid = f => `${f.op}|${f.endpoint}|${JSON.stringify(f.path || [])}`;
    const ownRow = ranked.find(c => c.created);
    if (ownRow && targeted.length && !targeted.some(f => fid(f) === fid(ownRow.fault))) {
      const linkedIdx = targeted.map((f, i) => [f, i]).filter(([f]) => f.linked === true && f.op === 'change-value').map(([, i]) => i);
      targeted[linkedIdx.length ? linkedIdx[linkedIdx.length - 1] : targeted.length - 1] = ownRow.fault;
    }
    // The flip gets a slot of its own, so it never displaces a fault that already proves something.
    if ((info[key].expects || []).some(m => BOOL_MATCHERS.has(m))) {
      const flip = flipCandidate(endpoints, asserted);
      if (flip) targeted.push(flip);
    }
    info[key].assertionsLinked = linkedAny;
    // The page's main list: the largest list in any response the test read. Always probe it,
    // because "still passes with no data" is the most common way a test fails to test anything.
    // Prefer the largest list whose rows the test's checked text comes from.
    let main = null;
    for (const e of endpoints) {
      if (e.write || e.telemetry || e.auth || (e.mocked && !e.real) || !e.shape?.arrays?.length) continue;
      for (const a of e.shape.arrays) {
        if (a.length < 2) continue;
        const inList = l => a.path.every((p, i) => l.path[i] === p) && l.path.length > a.path.length;
        const rowLeaves = (e.shape.leaves || []).filter(inList);
        const touched = rowLeaves.some(l => asserted.some(x => leafLink(l, x) !== null));
        const checked = rowLeaves.some(l => asserted.some(x => { const s = leafLink(l, x); return s !== null && s < 1; }));
        const better = !main || (touched && !main.touched) || (touched === main.touched && a.length > main.length);
        if (better) main = { endpoint: e.key, path: a.path, length: a.length, touched, checked };
      }
    }
    if (main) {
      const { touched, checked } = main;
      info[key].mainList = { endpoint: main.endpoint, path: main.path, touched, checked };
      const has = targeted.some(f => f.op === 'empty-list' && f.endpoint === main.endpoint && JSON.stringify(f.path) === JSON.stringify(main.path));
      const count = Object.keys(endpointsOf).length;
      const wide = count >= 4 && (usage.get(main.endpoint) || 0) > 0.6 * count ? { sessionWide: true } : {};
      if (!has) targeted.push({ op: 'empty-list', endpoint: main.endpoint, path: main.path, mainList: true, ...wide });
      // No assertion we can read is tied to the rows' values (they may be checked through a
      // boolean or a computed value), so change the visible text in every row and see.
      if (!checked) targeted.push({ op: 'change-rows', endpoint: main.endpoint, path: main.path, mainList: true, ...wide });
    }
    // The test's own write (made in its body, by few tests) is usually what it is about: always fail it once.
    if (!targeted.some(f => f.op === 'fail-write')) {
      // How often a write appears says little: a folder about one feature makes that feature's write
      // common. Incidental writes are recognisable by name instead (preferences, tracking, heartbeats).
      const persists = e => isPersistingWrite(e.key, e.status) ? 1 : 0;
      const INCIDENTAL = /preference|track|analytic|telemetry|log(ging)?event|ping|heartbeat|seen|visit|lastactive|session|beacon|metric/i;
      const own = endpoints.filter(e => e.write && !e.telemetry && !e.auth && e.inBody !== 0 && !(e.mocked && !e.real) &&
        !INCIDENTAL.test(e.key.split('#')[1] || new URL(e.url).pathname))
        // Prefer the write that persists something over helper calls (previews, validations), then the rarest.
        .sort((a, b) => persists(b) - persists(a) || (usage.get(a.key) || 0) - (usage.get(b.key) || 0))[0];
      if (own) targeted.push({ op: 'fail-write', endpoint: own.key, ownWrite: true, ...(persists(own) ? { persisting: true } : {}) });
    }
    const mocked = endpoints.filter(e => e.mocked && !e.real);
    info[key].mockedEndpoints = mocked.map(e => e.key);
    // The test makes a request fail itself (a mocked 4xx/5xx): an outage is the condition it creates, so
    // staying green under a real outage is expected there, not a sign the test is empty.
    info[key].mocksFailure = mocked.some(e => e.status >= 400);
    info[key].checksMockedData = mocked.some(e => (e.shape?.leaves || []).some(l => asserted.some(a => linkStrength(l.value, a) !== null)));
    tests[key] = { faults: [{ op: 'blackout' }, ...targeted], endpoints: endpoints.length };
  }

  // Serial groups: a failure in one test makes Playwright skip the rest of the group in that run.
  // So each test of a group gets its own block of runs, in which the other tests are skipped (a skip
  // does not stop the group). The block starts with a no-fault run of the test on its own, which shows
  // whether it depends on the tests before it.
  const serialGroups = new Map();
  for (const key of Object.keys(tests)) {
    const g = info[key].serialGroup;
    if (!g) continue;
    if (!serialGroups.has(g)) serialGroups.set(g, []);
    serialGroups.get(g).push(key);
  }
  for (const keys of serialGroups.values()) {
    if (keys.length < 2) continue;
    keys.sort((a, b) => info[a].line - info[b].line);
    let offset = 0;
    for (const key of keys) {
      const own = [{ op: 'alone' }, ...tests[key].faults];
      const schedule = new Array(offset).fill(null).concat(own);
      tests[key].faults = schedule;
      offset += own.length;
    }
  }
  const maxFaults = Math.max(1, ...Object.values(tests).map(t => t.faults.length));
  const slowestExpect = Math.max(0, ...Object.values(info).map(i => i.maxExpectMs));
  return { setupProjects, maxFaults, tests, excluded, info, slowestExpectMs: slowestExpect };
}

module.exports = { buildPlan, linkStrength };
// For mustfail's own tests only.
module.exports._internal = { isCreated, leafLink, candidatesFor, flipCandidate, pickDiverse, mergeTraffic };
