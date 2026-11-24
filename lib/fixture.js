'use strict';
// Fixtures added to the user's `test`. Off unless MUSTFAIL_MODE is set.
//   baseline: record each test's API traffic and a sample of each JSON response's shape
//   fault:    apply the fault the plan assigns to this test and repeat index
const fs = require('fs');
const { endpointKey, isWrite, isAuthUrl, isTelemetryUrl, shapeOf, mergeShapes, testKey } = require('./shared');

const MODE = process.env.MUSTFAIL_MODE || 'off';
let planCache;
function plan() {
  if (planCache === undefined) {
    planCache = MODE === 'fault' ? JSON.parse(fs.readFileSync(process.env.MUSTFAIL_PLAN, 'utf8')) : null;
  }
  return planCache;
}
function faultFor(testInfo) {
  const entry = plan()?.tests[testKey(testInfo.project.name, testInfo.titlePath)];
  return entry ? (entry.faults[testInfo.repeatEachIndex] || undefined) : undefined;
}
function isSetupProject(testInfo) {
  return (plan()?.setupProjects || []).includes(testInfo.project.name);
}
// Text checked by each passing locator assertion, keyed by test (baseline only).
const asserted = new WeakMap();
function recordAsserted(testInfo, texts, matcher, kind) {
  if (!testInfo) return;
  const list = asserted.get(testInfo) || [];
  for (const t of texts) if (t && list.length < 300) list.push({ t: String(t).slice(0, 2000), m: matcher || '', ...(kind ? { k: kind } : {}) });
  asserted.set(testInfo, list);
}

// Bodies of the write requests each test's page sent (baseline only), so an assertion on what was sent
// can be told apart from one on what came back.
const sentBodies = new WeakMap();
function sentMatch(testInfo, actual) {
  const list = (testInfo && sentBodies.get(testInfo)) || [];
  if (!list.length || actual == null) return null;
  if (typeof actual === 'string') {
    if (actual.length < 4) return null;
    const whole = list.find(b => b.body === actual);
    if (whole) return { key: whole.key, whole: true };
    const part = actual.length >= 8 && list.find(b => b.body.includes(actual));
    return part ? { key: part.key, whole: false } : null;
  }
  if (typeof actual === 'object') {
    let text; try { text = JSON.stringify(actual); } catch { return null; }
    if (!text || text.length < 8) return null;
    const hit = list.find(b => b.body === text || b.body.includes(text) || (b.json && (JSON.stringify(b.json) === text || JSON.stringify(b.json.variables) === text)));
    return hit ? { key: hit.key, whole: true } : null;
  }
  return null;
}

// Tests whose body has finished. From then on (afterEach hooks, fixture teardown: where cleanup
// runs) no fault applies and nothing is recorded, so a cleanup that deletes through the UI still works.
const bodyDone = new WeakSet();
const bodyStarted = new WeakSet();
function markBodyDone(testInfo) { if (testInfo) bodyDone.add(testInfo); }
function markBodyStarted(testInfo) { if (testInfo) bodyStarted.add(testInfo); }
// False when the shim could not hook test bodies (a Playwright internal moved). Then nothing here knows
// where a body starts, so every request counts as in the body and "body started" is reported as unknown,
// rather than as "never started" (which would read as every fault run breaking in setup).
let bodyTracking = true;
function setBodyTracking(on) { bodyTracking = !!on; }
const inBodyNow = testInfo => !bodyTracking || bodyStarted.has(testInfo);
const bodyStartedFlag = testInfo => bodyTracking ? bodyStarted.has(testInfo) : undefined;

const isApi = req => req.resourceType() === 'fetch' || req.resourceType() === 'xhr';
const MAX_SHAPE_BYTES = 1_000_000;
const MAX_SHAPE_READS = 40;

async function recordBaseline(context, use, testInfo) {
  const seen = new Map();
  const pending = [];
  const shapeParts = new Map(); // endpoint key -> what each response of it held, by arrival order
  const onResponse = response => {
    const req = response.request();
    if (!isApi(req) || bodyDone.has(testInfo)) return;
    const url = req.url();
    const key = endpointKey(req.method(), url, req.postData());
    const row = seen.get(key) || { key, method: req.method(), url, status: response.status(), count: 0, mocked: false, real: 0,
      write: isWrite(req.method(), url, req.postData()),
      auth: isAuthUrl(url), telemetry: isTelemetryUrl(url), shape: null };
    row.count++;
    delete row.sentOnly;
    if (!row.status) row.status = response.status();
    row.inBody = (row.inBody || 0) + (inBodyNow(testInfo) ? 1 : 0);
    seen.set(key, row);
    // A response the test fulfilled itself (page.route) has no server address.
    pending.push(response.serverAddr().then(addr => {
      if (addr || response.fromServiceWorker()) row.real++; else row.mocked = true;
    }).catch(() => {}));
    const type = (response.headers()['content-type'] || '');
    // Every response is read (up to a cap), not only the first: a list fetched again after the test
    // created a row is the only response that holds that row's values.
    if (!row.write && type.includes('json') && response.status() < 400 && (row.shapeReads = (row.shapeReads || 0) + 1) <= MAX_SHAPE_READS) {
      const n = row.shapeReads;
      pending.push(response.body().then(buf => {
        if (buf.length > MAX_SHAPE_BYTES) return;
        const parts = shapeParts.get(key) || [];
        parts.push({ n, shape: shapeOf(JSON.parse(buf.toString('utf8'))) });
        shapeParts.set(key, parts);
      }).catch(() => {}));
    }
  };
  const onRequest = req => {
    if (!isApi(req) || bodyDone.has(testInfo)) return;
    const body = req.postData();
    // A write is the test's own as soon as it is sent, even if its response arrives after the body
    // ends (a delete whose row the UI removes at once, so the last assertion passes first).
    const url = req.url();
    if (isWrite(req.method(), url, body) && !isAuthUrl(url) && !isTelemetryUrl(url)) {
      const key = endpointKey(req.method(), url, body);
      const row = seen.get(key) || { key, method: req.method(), url, status: 0, count: 0, mocked: false, real: 0,
        write: true, auth: false, telemetry: false, shape: null, sentOnly: true };
      if (inBodyNow(testInfo)) row.inBodySent = (row.inBodySent || 0) + 1;
      seen.set(key, row);
    }
    if (!body || !isWrite(req.method(), url, body)) return;
    const list = sentBodies.get(testInfo) || [];
    if (list.length >= 50) return;
    let json = null; try { json = JSON.parse(body); } catch {}
    list.push({ key: endpointKey(req.method(), req.url(), body), body, json });
    sentBodies.set(testInfo, list);
  };
  // A listener that throws would surface as an error in the user's test: recording must never do that.
  const safe = fn => arg => { try { fn(arg); } catch {} };
  const onReq = safe(onRequest), onRes = safe(onResponse);
  context.on('request', onReq);
  context.on('response', onRes);
  try {
    await use(context);
  } finally {
    context.off('request', onReq);
    context.off('response', onRes);
    await Promise.race([Promise.all(pending), new Promise(r => setTimeout(r, 2000))]);
    for (const row of seen.values()) if (row.inBodySent) row.inBody = Math.max(row.inBody || 0, row.inBodySent);
    for (const [key, parts] of shapeParts) {
      parts.sort((a, b) => a.n - b.n);
      seen.get(key).shape = parts.map(p => p.shape).reduce((acc, s) => mergeShapes(acc, s));
    }
    // In a finally block: a throw here would replace the test's own error.
    await testInfo.attach('mustfail-traffic', { body: JSON.stringify({ endpoints: [...seen.values()], asserted: asserted.get(testInfo) || [],
      ...(bodyTracking ? {} : { noBodyTracking: true }) }), contentType: 'application/json' }).catch(() => {});
  }
}

// Changes every occurrence of one value, wherever it sits in the response.
// Every copy gets the same new value, so the page sees one consistent wrong value.
function replaceValue(node, value, depth = 0, next = changeValue(value)) {
  if (depth > 30 || node == null || typeof node !== 'object') return 0;
  let n = 0;
  for (const k of Object.keys(node)) {
    if (node[k] === value) { node[k] = next; n++; }
    else if (node[k] && typeof node[k] === 'object') n += replaceValue(node[k], value, depth + 1, next);
  }
  return n;
}
// Changes the field at `path` ('*' = every row) and, in each row, every other field holding the
// same value (APIs send value and displayValue; the page may show either).
function changeInRows(json, path) {
  const last = path.lastIndexOf('*');
  if (last < 0) {
    let v; const got = setPath(json, path, x => (v = x, x));
    return got ? replaceValue(json, v) : 0;
  }
  const rest = path.slice(last + 1);
  let n = 0;
  setPath(json, path.slice(0, last + 1), row => {
    let v; const got = rest.length ? setPath(row, rest, x => (v = x, x)) : 0;
    if (got && v !== undefined && v !== null && typeof v !== 'object') n += replaceValue(row, v);
    return row;
  });
  return n;
}
// '*' in a path means every element of that list (change a field in every row).
function setPath(obj, path, fn) {
  if (obj == null || typeof obj !== 'object') return 0;
  const [head, ...rest] = path;
  if (head === '*') {
    if (!Array.isArray(obj)) return 0;
    return obj.reduce((n, item, i) => n + (rest.length ? setPath(item, rest, fn) : (obj[i] = fn(item), 1)), 0);
  }
  if (!rest.length) {
    if (!(head in obj)) return 0;
    obj[head] = fn(obj[head]);
    return 1;
  }
  return setPath(obj[head], rest, fn);
}
// Unique per change, so two changed rows never end up equal (a sort test compares rows).
let changeSeq = 0;
function changeValue(v) {
  if (typeof v === 'number') return v + 7;
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'string') return 'mustfail-' + (++changeSeq);
  return v;
}
// Fields the app uses to wire things up, not to show: changing them breaks rendering, which
// would make any test fail for the wrong reason.
const WIRING_KEY = /(^|_)(id|uuid|guid|key|slug|url|uri|href|link|token|cursor|hash|path|icon|image|avatar|color|colour|__typename)$|Id$|Ids$|Url$|At$|Date$|Time$/i;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{2,4}/;
function changeRowTexts(node, depth = 0) {
  if (depth > 3 || node == null || typeof node !== 'object') return 0;
  let n = 0;
  for (const [k, v] of Object.entries(node)) {
    if (WIRING_KEY.test(k)) continue;
    // Codes are rewritten too: pages often show a label derived from a status code (DRAFT -> Draft).
    if (typeof v === 'string' && v.trim().length >= 2 && !DATE_LIKE.test(v)) { node[k] = changeValue(v); n++; }
    else if (v && typeof v === 'object') n += changeRowTexts(v, depth + 1);
  }
  return n;
}

// Flips the true/false fields of each row (done, enabled, active). Fields that decide whether a row is
// shown at all are left alone, so the row stays on the page and only its state is wrong.
const ROW_FILTER_KEY = /^(is)?(deleted|archived|hidden|visible|removed)$/i;
function flipRowBooleans(node, depth = 0) {
  if (depth > 3 || node == null || typeof node !== 'object') return 0;
  let n = 0;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'boolean') { if (!ROW_FILTER_KEY.test(k)) { node[k] = !v; n++; } }
    else if (v && typeof v === 'object') n += flipRowBooleans(v, depth + 1);
  }
  return n;
}

async function applyFault(context, use, testInfo, fault) {
  const stats = { applied: 0, handlerErrors: 0, afterBody: 0 };
  await context.route('**/*', async route => {
    const req = route.request();
    try {
      if (!isApi(req)) return await route.fallback();
      if (bodyDone.has(testInfo)) { stats.afterBody++; return await route.fallback(); }
      const url = req.url();
      if (fault.op === 'blackout') {
        if (isAuthUrl(url)) return await route.fallback();
        stats.applied++;
        return await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"mustfail: simulated outage"}' });
      }
      const key = endpointKey(req.method(), url, req.postData());
      const extra = (fault.also || []).find(a => a.endpoint === key);
      if (key !== fault.endpoint && !extra) return await route.fallback();
      if (fault.op === 'fail-write') {
        stats.applied++;
        return await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"mustfail: simulated failure"}' });
      }
      const response = await route.fetch();
      let json;
      try { json = await response.json(); } catch { return await route.fulfill({ response }); }
      const changed = fault.op === 'empty-list' ? setPath(json, fault.path, () => [])
        : fault.op === 'change-rows' ? setPath(json, fault.path, rows => { if (Array.isArray(rows)) rows.forEach(r => changeRowTexts(r)); return rows; })
        : fault.op === 'flip-booleans' ? setPath(json, fault.path, rows => { if (Array.isArray(rows)) rows.forEach(r => flipRowBooleans(r)); return rows; })
        : fault.sameInRow ? changeInRows(json, extra ? extra.path : fault.path)
        : setPath(json, fault.path, changeValue);
      if (changed) stats.applied++;
      return await route.fulfill({ response, json });
    } catch {
      // Our handler must never fail a test by itself (route aborted, test already ended).
      stats.handlerErrors++;
      try { await route.fallback(); } catch {}
    }
  });
  try {
    await use(context);
  } finally {
    await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await testInfo.attach('mustfail-fault', { body: JSON.stringify({ ...fault, ...stats, bodyStarted: bodyStartedFlag(testInfo) }), contentType: 'application/json' }).catch(() => {});
  }
}

function extendTest(base) {
  if (MODE === 'off') return base;
  return base.extend({
    // Skips repeats that have no fault assigned, so a test with one fault runs once.
    _mustfailGate: [async ({}, use, testInfo) => {
      if (MODE === 'fault' && !isSetupProject(testInfo) && !faultFor(testInfo)) {
        testInfo.skip(true, 'mustfail: no fault for this repeat');
      }
      await use();
    }, { auto: true }],
    // Wrapping `context` (not an auto fixture) means API-only tests never get a browser.
    context: async ({ context }, use, testInfo) => {
      if (MODE === 'baseline') return recordBaseline(context, use, testInfo);
      const fault = MODE === 'fault' && !isSetupProject(testInfo) ? faultFor(testInfo) : undefined;
      if (fault && (fault.op === 'alone' || fault.op === 'clean')) {
        // 'clean': a suspect run with no fault before retrying lost runs (see lost.js).
        // A serial-group test run on its own with no fault: shows whether it needs the tests before it.
        try { await use(context); }
        finally { await testInfo.attach('mustfail-fault', { body: JSON.stringify({ ...fault, applied: 1, bodyStarted: bodyStartedFlag(testInfo) }), contentType: 'application/json' }).catch(() => {}); }
        return;
      }
      if (fault) return applyFault(context, use, testInfo, fault);
      await use(context);
    },
  });
}

module.exports = { extendTest, recordAsserted, markBodyDone, markBodyStarted, setBodyTracking, MODE, sentMatch };
// For mustfail's own tests only.
module.exports._internal = { setPath, changeInRows, changeRowTexts, changeValue, replaceValue, flipRowBooleans, sentBodies };
