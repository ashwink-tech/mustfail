// ESM counterpart of register.js: an import of `@playwright/test` from the user's own files resolves
// to our shim. Imports from node_modules and from mustfail itself keep the real package.
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const OWN_DIR = path.dirname(fileURLToPath(import.meta.url)) + path.sep;
const SHIM = pathToFileURL(path.join(OWN_DIR, 'shim.mjs')).href;
const NODE_MODULES = path.sep + 'node_modules' + path.sep;
// Windows paths can differ in drive-letter case between the loader and import.meta.url.
const norm = process.platform === 'win32' ? p => p.toLowerCase() : p => p;
const OWN = norm(OWN_DIR);

export async function resolve(specifier, context, next) {
  if ((specifier === '@playwright/test' || specifier === 'playwright/test') && context.parentURL && context.parentURL.startsWith('file:')) {
    const from = norm(fileURLToPath(context.parentURL));
    if (!from.startsWith(OWN) && !from.includes(NODE_MODULES)) return { url: SHIM, shortCircuit: true };
  }
  return next(specifier, context);
}
