import fs from 'node:fs/promises';
import path from 'node:path';
import { stopMockGitHub } from './stop-mock-github.js';
import { stopVSCodeHost } from './vscode-host.js';

export default async function globalTeardown() {
  await stopMockGitHub();
  const statePath = path.resolve('.vscode-test/playwright-state.json');
  let state: { pid?: number; workspacePath?: string } = {};
  try {
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  stopVSCodeHost(state);
  if (state.workspacePath) {
    await fs.rm(state.workspacePath, { recursive: true, force: true });
  }
  await fs.rm(statePath, { force: true });
}
