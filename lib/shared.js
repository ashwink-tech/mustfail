'use strict';

const SEP = ' › ';
function testKey(projectName, titlePath) {
  return [projectName || '', ...titlePath].join(SEP);
}

const ID_SEGMENT = /\/(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24})(?=\/|$)/gi;
// GraphQL is recognised by its request body, not its path: many servers (Apollo among them)
// answer on "/" or another custom path. Handles batched and persisted-query requests.
const WRITE_NAME = /^(create|update|delete|remove|add|set|save|archive|unarchive|publish|unpublish|upsert|insert|assign|unassign|invite|send|submit|toggle|enable|disable|deploy|import|upload|duplicate|rename|move|reset|revoke|approve|reject|cancel|mark)/i;
function graphqlInfo(url, postData) {
  if (!postData) return null;
  let body;
  try { body = JSON.parse(postData); } catch { return null; }
  const op = Array.isArray(body) ? body[0] : body;
  if (!op || typeof op !== 'object') return null;
  const query = typeof op.query === 'string' ? op.query.trim() : '';
  const persisted = !!(op.extensions && op.extensions.persistedQuery);
  if (!query && !persisted && typeof op.operationName !== 'string') return null;
  if (query && !/^(query|mutation|subscription|fragment|\{)/.test(query.replace(/^#.*\n/gm, '').trim())) return null;
  const nameFromQuery = (/^(?:query|mutation|subscription)\s+(\w+)/.exec(query) || [])[1];
  const name = op.operationName || nameFromQuery || '(anonymous)';
  const readName = /^(is|has|can|get|list|fetch|check|validate|search|find|count|lookup)[A-Z_]/.test(name);
  const write = !readName && (query ? /^mutation\b/.test(query) : WRITE_NAME.test(name));
  return { name, write, batch: Array.isArray(body) ? body.length : 1 };
}
// Generated ids that are not numbers or UUIDs (cuid, nanoid, ULID: "afx9rllvwj5apmc19ckfe5eu"): one path
// segment of 16+ letters and digits with at least three digits. They differ every run, and an endpoint
// whose key changes between baseline and fault run would never be faulted.
const OPAQUE_ID = /\/(?=[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}(?=\/|$)/g;
function endpointKey(method, url, postData) {
  const u = new URL(url);
  // Timestamps baked into paths (upload keys, generated names) differ every run: fold them too.
  const base = `${method} ${u.origin}${u.pathname.replace(ID_SEGMENT, '/:id').replace(OPAQUE_ID, '/:id').replace(/\d{10,}/g, ':n')}`;
  const gql = graphqlInfo(url, postData);
  return gql ? `${base}#${gql.name}` : base;
}
function isWrite(method, url, postData) {
  const gql = graphqlInfo(url, postData);
  if (gql) return gql.write;
  return !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

const AUTH = /\/(login|logout|signin|sign-in|signout|sign-out|token|oauth2?|auth|authorize|session|sessions|sso|saml|refresh|me)(\/|$|\?)/i;
const TELEMETRY = /(google-analytics|googletagmanager|segment\.(io|com)|sentry\.io|ingest\.sentry|datadoghq|browser-intake|hotjar|mixpanel|amplitude|fullstory|newrelic|nr-data\.net|intercom|clarity\.ms|posthog|logrocket|bugsnag|rollbar|launchdarkly|pusher)/i;
const isAuthUrl = url => AUTH.test(new URL(url).pathname);
const isTelemetryUrl = url => TELEMETRY.test(url);

// Collects scalar leaves (with their values) and non-empty lists from a JSON response.
// Leaves are later matched against the text the test's assertions checked.
const SKIP_KEY = /^(id|uuid|guid|_id|__typename|etag|token|cursor|createdAt|updatedAt|created_at|updated_at|timestamp)$|Id$|_id$/;
const MAX_LEAVES = 300;
function shapeOf(json) {
  const leaves = [];
  const arrays = [];
  const walk = (v, path, depth) => {
    if (depth > 8 || v == null || leaves.length >= MAX_LEAVES) return;
    if (Array.isArray(v)) {
      if (v.length) arrays.push({ path, length: v.length });
      v.slice(0, 5).forEach((item, i) => walk(item, [...path, i], depth + 1));
      return;
    }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) walk(v[k], [...path, k], depth + 1);
      return;
    }
    const key = path[path.length - 1];
    if (typeof key === 'string' && SKIP_KEY.test(key)) return;
    if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length && v.length < 200)) {
      leaves.push({ path, value: typeof v === 'string' ? v : v, type: typeof v });
    }
  };
  walk(json, [], 0);
  return { leaves, arrays };
}

// Combines what two responses of the same endpoint held. A test that creates a row sees the list
// before the row exists and again after: only the later response contains the row's values.
const MAX_MERGED_LEAVES = 600;
// keepLate: merging two separate runs, where a value new in the second run is not "created" unless it
// was already late within its own run.
function mergeShapes(a, b, { keepLate = false } = {}) {
  if (!a) return b;
  if (!b) return a;
  const key = l => JSON.stringify(l.path) + '\u0000' + JSON.stringify(l.value);
  const seen = new Set(a.leaves.map(key));
  const leaves = a.leaves.slice();
  for (const l of b.leaves) {
    if (leaves.length >= MAX_MERGED_LEAVES) break;
    if (!seen.has(key(l))) { seen.add(key(l)); leaves.push(keepLate ? { ...l } : { ...l, late: true }); }
  }
  const arrays = a.arrays.map(x => ({ ...x }));
  const byPath = new Map(arrays.map(x => [JSON.stringify(x.path), x]));
  for (const x of b.arrays) {
    const cur = byPath.get(JSON.stringify(x.path));
    if (!cur) { const c = { ...x }; arrays.push(c); byPath.set(JSON.stringify(x.path), c); }
    else if (x.length > cur.length) cur.length = x.length;
  }
  return { leaves, arrays };
}

// True when a response value is visible inside text an assertion checked.
function appearsIn(value, text) {
  if (!text) return false;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    const forms = Number.isInteger(value) ? [String(value)] : [String(value), value.toFixed(2)];
    // A standalone number: not a digit inside an ID, a hash or a word ("6af5fbb1e8" holds no 1).
    return forms.some(f => new RegExp(`(^|[^\\w.])${f.replace('.', '\\.')}(?![\\w])`).test(text));
  }
  if (typeof value === 'string') {
    // A whole word or phrase, not letters inside a longer word ("read" is not in "spreadsheet").
    const v = value.trim();
    if (v.length < 4) return false;
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'u').test(text);
  }
  return false;
}

// A write that saves something (create, update, delete), as opposed to a call that merely travels as a
// POST (search, validate, generate a slug, refresh a token).
// GraphQL: the operation name holds a saving verb. REST: PUT, PATCH and DELETE always save; a POST saves
// when its path holds a saving verb (/roles/batch-delete, /actions/publish) or, passed in as `status`,
// the server answered 201 Created in the baseline (POST /tasks, the usual REST create).
// Words are matched whole: "settings" is not "set", "assets" is not "set", "address" is not "add".
const PERSIST_WORD = /^(create|update|delete|remove|save|upsert|add|set|publish|submit)(s|d|ed)?$/i;
const words = name => name.split(/[^A-Za-z0-9]+/).flatMap(w => w.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)).filter(Boolean);
function isPersistingWrite(endpoint, status) {
  const [method, rest = ''] = String(endpoint || '').split(' ');
  if (rest.includes('#')) return words(rest.split('#')[1]).some(w => PERSIST_WORD.test(w));
  if (/^(PUT|PATCH|DELETE)$/.test(method)) return true;
  if (method !== 'POST') return false;
  if (status === 201) return true;
  let pathname = rest; try { pathname = new URL(rest).pathname; } catch {}
  return words(pathname).some(w => PERSIST_WORD.test(w));
}

const pathLabel = path => path.reduce((s, p) => typeof p === 'number' || p === '*' ? `${s}[${p}]` : (s ? `${s}.${p}` : p), '');

module.exports = { testKey, endpointKey, isWrite, graphqlInfo, isAuthUrl, isTelemetryUrl, shapeOf, mergeShapes, appearsIn, pathLabel, isPersistingWrite, SEP };
