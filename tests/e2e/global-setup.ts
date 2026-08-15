import fs from 'node:fs/promises';
import path from 'node:path';
import { createFixtureWorkspace, launchVSCodeHost } from './vscode-host.js';

export const statePath = path.resolve('.vscode-test/playwright-state.json');

export default async function globalSetup() {
  const root = path.resolve('.');
  const testDataPath = path.dirname(statePath);
  await fs.mkdir(testDataPath, { recursive: true });
  const workspacePath = await createFixtureWorkspace(testDataPath);
  const host = await launchVSCodeHost({
    extensionPath: root,
    workspacePath,
    port: 9333,
  });

  await fs.writeFile(statePath, JSON.stringify({
    ...host,
    workspacePath,
  }));
}
