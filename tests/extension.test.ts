import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const statePath = path.resolve('.vscode-test/playwright-state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as { port: number };
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.port}`);
  const pages = browser.contexts().flatMap((context) => context.pages());
  page = pages[0];
  await expect(page.locator('.monaco-workbench')).toBeVisible();
});

test.afterAll(async () => {
  await browser?.close();
});

test('loads the fixture pull request in the GitHub PR Reviewer view', async () => {
  const reviewView = page.getByRole('tab', { name: /GitHub PR Reviewer/ });
  await expect(reviewView).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /#42: Fixture PR/ })).toBeVisible();
});

test('opens a review thread in the workspace file', async () => {
  const file = page.getByRole('treeitem', { name: /src\/fixture.ts/ });
  await expect(file).toBeVisible();
  await file.click();
  await expect(page.getByRole('tab', { name: 'fixture.ts' })).toBeVisible();

  const thread = page
    .getByRole('treeitem', { name: /test-user: Please review this fixture thread/ })
    .first();
  await expect(thread).toBeVisible();
  await thread.click();
  const editor = page.getByRole('main');
  await expect(
    editor.getByRole('treeitem', { name: /test-user, Please review this fixture thread/ }),
  ).toBeVisible();
  await editor.getByRole('button', { name: 'Reply...' }).click();
  const reply = editor.getByLabel(/Comment, use/).getByRole('textbox');
  await expect(reply).toBeVisible();
  await reply.focus();
  await page.keyboard.type('Looks good');
  await editor.getByRole('button', { name: /Reply to Thread/ }).click();
  await expect(page.getByText('Looks good', { exact: true })).toBeVisible();

  await editor.getByRole('button', { name: 'Resolve' }).first().click();
  await expect(
    page.getByRole('treeitem', { name: /test-user: Please review this fixture thread/ }).first(),
  ).toHaveCount(0);
});

test('reloads the matching pull request after a branch switch', async () => {
  await page.getByRole('button', { name: /feature\/review, Checkout Branch\/Tag/ }).click();
  await expect(page.getByRole('option', { name: /feature\/second/ })).toBeVisible();
  await page.getByRole('option', { name: /feature\/second/ }).click();
  const secondPr = page.getByRole('treeitem', { name: /#43: Second Fixture PR/ });
  await expect(secondPr).toBeVisible();
  await secondPr.click();
  await expect(
    page.getByRole('treeitem', { name: /test-user: Review the second branch fixture/ }).first(),
  ).toBeVisible({ timeout: 15_000 });
});
