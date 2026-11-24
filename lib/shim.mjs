// ESM entry for the shim: the same object as shim.js, with the named exports Playwright's own ESM
// entry (playwright/test.mjs) declares.
import { createRequire } from 'node:module';
const shim = createRequire(import.meta.url)('./shim.js');
export const chromium = shim.chromium;
export const firefox = shim.firefox;
export const webkit = shim.webkit;
export const selectors = shim.selectors;
export const devices = shim.devices;
export const errors = shim.errors;
export const request = shim.request;
export const _electron = shim._electron;
export const _android = shim._android;
export const _baseTest = shim._baseTest;
export const _utilityTest = shim._utilityTest;
export const test = shim.test;
export const expect = shim.expect;
export const defineConfig = shim.defineConfig;
export const mergeTests = shim.mergeTests;
export const mergeExpects = shim.mergeExpects;
export default shim.test;
