import { test as base, expect } from '@playwright/test';
const test = base.extend<{ greeting: string }>({ greeting: async ({}, use) => { await use('hi'); } });
test('custom fixture: total shown', async ({ page, greeting }) => {
  expect(greeting).toBe('hi');
  await page.goto('/');
  await expect(page.locator('#total')).toHaveText('42.00');
});
