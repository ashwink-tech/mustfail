import { defineConfig } from '@playwright/test';
// E2E_BROWSER=firefox|webkit runs the example on that engine (CI); the default is installed Chrome.
const engine = process.env.E2E_BROWSER && process.env.E2E_BROWSER !== 'chrome' ? process.env.E2E_BROWSER as 'firefox' | 'webkit' : null;
const browser = engine ? { browserName: engine, channel: undefined } : { channel: 'chrome' };
export default defineConfig({
  testDir: './tests', workers: 2, retries: 1, reporter: [['list']],
  use: { baseURL: 'http://localhost:4123', ...browser },
  webServer: { command: 'node server.js', port: 4123, reuseExistingServer: true },
});
