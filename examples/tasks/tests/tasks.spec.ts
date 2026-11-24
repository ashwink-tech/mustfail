import { test, expect } from './fixtures';

test.describe('task list', () => {
  test('lists every task', async ({ tasksPage }) => {
    await expect(tasksPage.rows).toHaveCount(3);
  });
  test('first task title (page object helper)', async ({ tasksPage }) => {
    await tasksPage.expectTaskTitle(0, 'Write report');
  });
  test('heading is shown', async ({ tasksPage }) => {
    await expect(tasksPage.page.getByRole('heading')).toHaveText('My tasks');
  });
  test('priority of first task (soft)', async ({ tasksPage }) => {
    await expect.soft(tasksPage.rows.first().locator('.priority')).toHaveText('high');
  });
  test('rows appear (poll)', async ({ tasksPage }) => {
    await expect.poll(() => tasksPage.rows.count()).toBeGreaterThan(0);
  });
  test('no error banner', async ({ tasksPage }) => {
    await expect(tasksPage.error).not.toBeVisible();
  });
  test('row contains a word', async ({ tasksPage }) => {
    await expect(tasksPage.rows.first()).toContainText('high');
  });
});

test.describe('stats', () => {
  test('open count from GraphQL', async ({ tasksPage }) => {
    await expect(tasksPage.stats).toHaveText('2 open, 1 done');
  });
});

test.describe('adding', () => {
  test('adds a task', async ({ tasksPage }) => {
    await tasksPage.add('Ship mustfail');
    await expect(tasksPage.rows.last().locator('.title')).toHaveText('Ship mustfail');
  });
  test('clears the input after adding', async ({ tasksPage }) => {
    await tasksPage.add('Another one');
    await expect(tasksPage.newTask).toHaveValue('');
  });
  test('waits a fixed second', async ({ tasksPage }) => {
    await tasksPage.page.waitForTimeout(1000);
    await expect(tasksPage.rows).toHaveCount(3);
  });
});

test('API only: tasks endpoint', async ({ request }) => {
  const res = await request.get('/api/tasks');
  expect((await res.json()).tasks.length).toBe(3);
});

test('own browser context', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: '.auth/user.json' });
  const page = await ctx.newPage();
  await page.goto('/app');
  await expect(page.locator('[data-testid="task-row"]')).toHaveCount(3);
  await ctx.close();
});

test('fully mocked list', async ({ page }) => {
  await page.route('**/api/tasks', r => r.fulfill({ json: { tasks: [{ id: 1, title: 'Mocked', done: false, priority: 'low' }], total: 1 } }));
  await page.goto('/app');
  await expect(page.locator('[data-testid="task-row"] .title')).toHaveText('Mocked');
});

test('flaky on purpose', async ({ tasksPage }) => {
  test.skip(!process.env.WITH_FLAKY, 'enable with WITH_FLAKY=1');
  await expect(tasksPage.rows).toHaveCount(Math.random() < 0.5 ? 3 : 4);
});

test('shows who is signed in (GraphQL on /)', async ({ tasksPage }) => {
  await expect(tasksPage.page.locator('#who')).toHaveText('ashwin@example.com (pro)');
});

test('grid visible, then first priority matches a pattern', async ({ tasksPage }) => {
  await expect(tasksPage.page.locator('table')).toBeVisible();
  await expect(tasksPage.rows).not.toHaveCount(0);
  await expect(tasksPage.rows.first().locator('.priority')).toHaveText(/high|medium|low/);
});

test('every row is Open or Done (passes on an empty list)', async ({ tasksPage }) => {
  await expect(tasksPage.page.getByRole('heading', { name: 'My tasks' })).toBeVisible();
  await expect.poll(async () => {
    const n = await tasksPage.rows.count();
    for (let i = 0; i < n; i++) {
      const s = (await tasksPage.rows.nth(i).locator('.state').textContent()) ?? '';
      if (!/^(Open|Done)$/.test(s.trim())) return false;
    }
    return true;
  }).toBe(true);
});

test('priorities checked through a boolean (allInnerTexts + every)', async ({ tasksPage }) => {
  // allInnerTexts() does not wait: without this it can read the table before the rows arrive.
  await tasksPage.rows.first().waitFor();
  const texts = await tasksPage.rows.allInnerTexts();
  expect(texts.length).toBeGreaterThan(0);
  expect(texts.every(t => /high|medium|low/.test(t))).toBe(true);
});

test.describe('cleanup through the UI', () => {
  let created = '';
  test.afterEach(async ({ page }) => {
    // Cleanup runs after the body: it must work even during a blackout fault.
    if (created) {
      const r = await page.evaluate(t => fetch('/api/tasks/by-title/' + encodeURIComponent(t), { method: 'DELETE' }).then(r => r.status), created);
      if (r !== 204) throw new Error('cleanup failed with ' + r);
    }
  });
  test('adds a task, cleaned up in afterEach', async ({ tasksPage, page }) => {
    created = 'cleanup-' + Date.now();
    await page.locator('#add input').fill(created);
    await page.locator('#add button').click();
    await expect(page.getByText(created)).toBeVisible();
  });
});

test('label shown from a displayValue copy', async ({ page }) => {
  // The API sends priority twice; the page shows priorityLabel. The checked value must change in both.
  await page.goto('/labels');
  await expect(page.locator('#label')).toHaveText('High');
});

test('list request fails (mocked 500): the heading is still shown', async ({ page }) => {
  // The test creates the outage itself, so surviving an outage proves nothing either way.
  await page.route('**/api/tasks', r => r.fulfill({ status: 500, json: { error: 'down' } }));
  await page.goto('/app');
  await expect(page.getByRole('heading')).toHaveText('My tasks');
});

test('known open bug (test.fail)', async ({ tasksPage }) => {
  test.fail(true, 'BUG-1 open: the list shows 3 rows where 99 are expected');
  await expect(tasksPage.rows).toHaveCount(99, { timeout: 1500 });
});

test.describe('write-gated', () => {
  test('adds a task and waits for the save, never checks the result', async ({ tasksPage, page }) => {
    await tasksPage.newTask.fill('Gated task');
    await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/tasks') && r.request().method() === 'POST' && r.ok(), { timeout: 4000 }),
      page.locator('#add button').click(),
    ]);
    await expect(page.getByRole('heading')).toHaveText('My tasks');
  });
});

test.describe('serial group', () => {
  test.describe.configure({ mode: 'serial' });
  test('serial first: lists every task', async ({ tasksPage }) => {
    await expect(tasksPage.rows).toHaveCount(3);
  });
  let firstRan = false;
  test('serial needs first (depends on the test before it)', async ({ tasksPage }) => {
    firstRan = true;
    await expect(tasksPage.rows).toHaveCount(3);
  });
  test('serial uses state from the test before', async ({ tasksPage }) => {
    expect(firstRan).toBe(true);
    await expect(tasksPage.rows.first()).toContainText('Write report');
  });
  test('serial second: heading only', async ({ tasksPage }) => {
    await expect(tasksPage.page.getByRole('heading')).toHaveText('My tasks');
  });
});

test.describe('create, reload, find it', () => {
  let created = '';
  test.afterEach(async ({ page }) => {
    if (created) {
      await page.evaluate(t => fetch('/api/tasks/by-title/' + encodeURIComponent(t), { method: 'DELETE' }).then(r => r.status), created);
      created = '';
    }
  });
  test('adds a uniquely named task, waits for the save, reloads and finds it', async ({ tasksPage, page }) => {
    created = 'persist-' + Date.now();
    await tasksPage.newTask.fill(created);
    await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/tasks') && r.request().method() === 'POST' && r.ok(), { timeout: 4000 }),
      page.locator('#add button').click(),
    ]);
    await page.reload();
    await expect(tasksPage.rows.filter({ hasText: created })).toBeVisible();
  });
});

test.describe('setup helper checks its own row', () => {
  let created = '';
  test.afterEach(async ({ page }) => {
    if (created) {
      await page.evaluate(t => fetch('/api/tasks/by-title/' + encodeURIComponent(t), { method: 'DELETE' }).then(r => r.status), created);
      created = '';
    }
  });
  test('adding a task list is not empty after adding (setup helper checks the row)', async ({ tasksPage, page }) => {
    created = 'helper-' + Date.now();
    await tasksPage.addAndConfirm(created);
    expect(await tasksPage.rows.count()).toBeGreaterThan(0);
  });
});

test.describe('booleans', () => {
  test('done state shown as a ticked checkbox (true/false from the server)', async ({ tasksPage }) => {
    await expect(tasksPage.rows.filter({ hasText: 'Review PR' }).getByRole('checkbox')).toBeChecked();
    await expect(tasksPage.rows.filter({ hasText: 'Write report' }).getByRole('checkbox')).not.toBeChecked();
  });
  test('ticking a checkbox ticks it (browser only)', async ({ tasksPage }) => {
    const box = tasksPage.rows.filter({ hasText: 'Plan sprint' }).getByRole('checkbox');
    await box.check();
    await expect(box).toBeChecked();
  });
});

test.describe('request body', () => {
  let created = '';
  test.afterEach(async ({ page }) => {
    if (created) {
      await page.evaluate(t => fetch('/api/tasks/by-title/' + encodeURIComponent(t), { method: 'DELETE' }).then(r => r.status), created);
      created = '';
    }
  });
  test('save sends the typed title (asserts the request body only)', async ({ tasksPage, page }) => {
    created = 'req-' + Date.now();
    await tasksPage.newTask.fill(created);
    const [req] = await Promise.all([
      page.waitForRequest(r => r.url().includes('/api/tasks') && r.method() === 'POST'),
      page.locator('#add button').click(),
    ]);
    expect(req.postData()).toContain(created);
    expect(req.postDataJSON()).toEqual({ title: created });
  });
});
