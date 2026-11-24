'use strict';
// Preloaded with NODE_OPTIONS=--require into the Playwright runner and its workers.
// Redirects `@playwright/test` imports made by the user's own files (config, specs,
// fixtures, page objects) to our shim, so no test file needs editing.
const Module = require('module');
const path = require('path');

const SHIM = path.join(__dirname, 'shim.js');
const OWN_DIR = __dirname + path.sep;
const NODE_MODULES = path.sep + 'node_modules' + path.sep;
const original = Module._resolveFilename;
// Windows paths can differ in drive-letter case between the loader and __dirname.
const norm = process.platform === 'win32' ? p => p.toLowerCase() : p => p;
const OWN = norm(OWN_DIR);

Module._resolveFilename = function (request, parent, ...rest) {
  // 'playwright/test' is the same module under its other name; some projects import it directly.
  if ((request === '@playwright/test' || request === 'playwright/test') && parent && parent.filename) {
    const from = norm(parent.filename);
    if (!from.startsWith(OWN) && !from.includes(NODE_MODULES)) return SHIM;
  }
  return original.call(this, request, parent, ...rest);
};
