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

test('opens a review thread in the historical code diff by default', async () => {
  const file = page.getByRole('treeitem', { name: /^src\/fixture\.ts —/ });
  await expect(file).toBeVisible();
  await file.click();

  const thread = page
    .getByRole('treeitem', { name: /test-user: Please review this fixture thread/ })
    .first();
  await expect(thread).toBeVisible();
  await thread.click();

  const diffTitle = page.getByText(/1111111 -> 2222222 \(comment at line 2:/);
  await expect(diffTitle).toBeVisible();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await expect(diffTitle).toBeVisible();
  await expect(page.getByRole('tab', { name: /1111111/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Close/ }).first()).toBeVisible();
  const editorLines = await page.locator('.monaco-editor .view-lines').allTextContents();
  const editorText = editorLines.join('\n').replace(/\u00a0/g, ' ');
  expect(editorText).toContain('comment version');
  expect(editorText).toContain('current version');
  const layoutButton = page.getByRole('button', { name: 'Toggle Inline/Side-by-Side Diff' });
  await expect(layoutButton).toBeVisible();
  await layoutButton.click();
  await expect(page.getByText(/comment at line 2: Please review this fixture thread\./)).toBeVisible();
  const editor = page.getByRole('main');
  await expect(
    editor.getByRole('treeitem', { name: /test-user, Please review this fixture thread/ }),
  ).toBeVisible();
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
