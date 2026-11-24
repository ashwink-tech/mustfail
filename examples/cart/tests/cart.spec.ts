import { test, expect } from '@playwright/test';
test('cart page loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible();
});
test('shows cart items', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('listitem').first()).toBeVisible();
});
test('shows correct total', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#total')).toHaveText('42.00');
  await expect(page.getByRole('listitem')).toHaveCount(2);
});
test('checkout works', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page.locator('#done')).toHaveText('Order placed');
});
test('coupon can be entered', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Coupon').fill('SAVE10');
  await expect(page.getByLabel('Coupon')).toHaveValue('SAVE10');
});
test('no assertion at all', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Checkout' }).click();
});
