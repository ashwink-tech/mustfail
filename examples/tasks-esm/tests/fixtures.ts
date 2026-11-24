import { test as base } from '@playwright/test';
import { TasksPage } from '../pages/TasksPage';
export const test = base.extend<{ tasksPage: TasksPage }>({
  tasksPage: async ({ page, request, baseURL }, use, testInfo) => {
    // A task store per worker (see server.js), so parallel resets cannot wipe this test's data.
    const ws = 'w' + testInfo.parallelIndex;
    await page.context().addCookies([{ name: 'ws', value: ws, url: baseURL! }]);
    await request.get('/__reset', { headers: { cookie: 'ws=' + ws } });
    const p = new TasksPage(page); await p.open(); await use(p);
  },
});
export { expect } from '@playwright/test';
