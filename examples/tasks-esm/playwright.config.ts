import { defineConfig, devices } from '@playwright/test';
// E2E_BROWSER=firefox|webkit runs the example on that engine (CI); the default is installed Chrome.
const engine = process.env.E2E_BROWSER && process.env.E2E_BROWSER !== 'chrome' ? process.env.E2E_BROWSER as 'firefox' | 'webkit' : null;
const browser = engine ? { browserName: engine, channel: undefined } : { channel: 'chrome' };
export default defineConfig({
  testDir: './tests',
  workers: 2,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://localhost:4125', ...browser },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    { name: 'chrome', use: { ...devices[engine === 'firefox' ? 'Desktop Firefox' : engine === 'webkit' ? 'Desktop Safari' : 'Desktop Chrome'], ...browser, storageState: '.auth/user.json' }, dependencies: ['setup'] },
  ],
  webServer: { command: 'node server.cjs', port: 4125, reuseExistingServer: true },
});
