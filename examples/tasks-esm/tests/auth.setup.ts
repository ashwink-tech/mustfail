import { test as setup, expect } from '@playwright/test';
setup('sign in', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('ashwin@example.com');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My tasks' })).toBeVisible();
  await page.context().storageState({ path: '.auth/user.json' });
});
