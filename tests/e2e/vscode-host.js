const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

function runGit(workspacePath, args) {
  execFileSync('git', args, {
    cwd: workspacePath,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Playwright',
      GIT_AUTHOR_EMAIL: 'playwright@example.test',
      GIT_COMMITTER_NAME: 'Playwright',
      GIT_COMMITTER_EMAIL: 'playwright@example.test',
    },
  });
}

async function createFixtureWorkspace(parentPath) {
  const workspacePath = await fs.promises.mkdtemp(path.join(parentPath, 'workspace-'));
  await fs.promises.mkdir(path.join(workspacePath, 'src'));
  await fs.promises.writeFile(
    path.join(workspacePath, 'src/fixture.ts'),
    'export const fixture = "main";\nexport const reviewLine = true;\n',
  );
  runGit(workspacePath, ['init', '-b', 'main']);
  runGit(workspacePath, ['add', '.']);
  runGit(workspacePath, ['commit', '-m', 'Create fixture']);
  runGit(workspacePath, ['remote', 'add', 'origin', 'https://github.com/test-owner/test-repo.git']);
  runGit(workspacePath, ['checkout', '-b', 'feature/review']);
  await fs.promises.appendFile(
    path.join(workspacePath, 'src/fixture.ts'),
    'export const branch = "review";\n',
  );
  runGit(workspacePath, ['add', '.']);
  runGit(workspacePath, ['commit', '-m', 'Add review fixture']);
  runGit(workspacePath, ['checkout', '-b', 'feature/second']);
  await fs.promises.appendFile(
    path.join(workspacePath, 'src/fixture.ts'),
    'export const secondBranch = true;\n',
  );
  runGit(workspacePath, ['add', '.']);
  runGit(workspacePath, ['commit', '-m', 'Add second fixture']);
  runGit(workspacePath, ['checkout', 'feature/review']);
  return workspacePath;
}

async function waitForCdp(port, child, getStderr) {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `VS Code exited before CDP was ready with code ${child.exitCode}: ${getStderr()}`,
      );
    }

    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        return;
      }
    } catch {
      // The VS Code process may need more time to start its debugging server.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for VS Code CDP at ${endpoint}.`);
}

async function launchVSCodeHost({ extensionPath, workspacePath, port }) {
  const downloadedExecutablePath = await downloadAndUnzipVSCode();
  const vscodeExecutablePath = fs.existsSync(downloadedExecutablePath)
    ? downloadedExecutablePath
    : downloadedExecutablePath.replace(`${path.sep}Electron`, `${path.sep}Code`);
  const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'github-reviewer-user-'));
  const extensionsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'github-reviewer-ext-'));
  const child = spawn(vscodeExecutablePath, [
    '--extensionDevelopmentPath=' + extensionPath,
    '--user-data-dir=' + userDataDir,
    '--extensions-dir=' + extensionsDir,
    '--remote-debugging-port=' + port,
    '--disable-gpu',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-updates',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    workspacePath,
  ], {
    env: {
      ...process.env,
      GITHUB_REVIEWER_API_URL: `http://127.0.0.1:${process.env.GITHUB_REVIEWER_MOCK_PORT ?? 43123}`,
      GITHUB_REVIEWER_TEST_TOKEN: 'test-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let spawnError = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', (error) => {
    spawnError = error.message;
  });

  await waitForCdp(port, child, () => `${stderr}${spawnError}`);
  return {
    pid: child.pid,
    userDataDir,
    extensionsDir,
    port,
  };
}

function stopVSCodeHost({ pid }) {
  if (!pid) {
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

module.exports = {
  createFixtureWorkspace,
  launchVSCodeHost,
  stopVSCodeHost,
};
