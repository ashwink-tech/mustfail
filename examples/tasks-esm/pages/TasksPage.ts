import { type Page, type Locator, expect } from '@playwright/test';
export class TasksPage {
  readonly rows: Locator;
  readonly stats: Locator;
  readonly error: Locator;
  readonly newTask: Locator;
  constructor(readonly page: Page) {
    this.rows = page.locator('[data-testid="task-row"]');
    this.stats = page.locator('#stats');
    this.error = page.getByRole('alert');
    this.newTask = page.getByLabel('New task');
  }
  async open() { await this.page.goto('/app'); }
  async add(title: string) { await this.newTask.fill(title); await this.page.getByRole('button', { name: 'Add' }).click(); }
  // Setup helper that checks its own work: adds a task and waits for its row to show.
  async addAndConfirm(title: string) {
    await this.newTask.fill(title);
    await Promise.all([
      this.page.waitForResponse(r => r.url().includes('/api/tasks') && r.request().method() === 'POST' && r.ok(), { timeout: 4000 }),
      this.page.getByRole('button', { name: 'Add' }).click(),
    ]);
    await this.page.reload();
    await expect(this.rows.filter({ hasText: title })).toBeVisible();
  }
  async expectTaskTitle(i: number, title: string) { await expect(this.rows.nth(i).locator('.title')).toHaveText(title); }
}
