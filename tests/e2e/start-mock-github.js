const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const port = Number(process.env.GITHUB_REVIEWER_MOCK_PORT ?? 43123);
const healthUrl = `http://127.0.0.1:${port}/health`;
const pidPath = path.resolve('.vscode-test/mock-github-server.pid');
const deadline = Date.now() + 30_000;

async function startMockGitHub() {
  const child = spawn(process.execPath, ['tests/e2e/mock-github-server.js'], {
    cwd: path.resolve('.'),
    detached: true,
    env: process.env,
    stdio: 'ignore',
  });
  if (!child.pid) {
    throw new Error('Unable to start mock GitHub API');
  }

  let exitReason;
  child.once('error', (error) => {
    exitReason = error.message;
  });
  child.once('exit', (code, signal) => {
    exitReason = `exited with ${signal ?? `code ${code}`}`;
  });
  child.unref();

  try {
    while (Date.now() < deadline) {
      if (exitReason) {
        throw new Error(`Mock GitHub API ${exitReason}`);
      }

      try {
        const response = await fetch(healthUrl);
        if (response.ok) {
          await fs.mkdir(path.dirname(pidPath), { recursive: true });
          await fs.writeFile(pidPath, String(child.pid));
          return;
        }
      } catch {}

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timed out waiting for mock GitHub API at ${healthUrl}`);
  } catch (error) {
    process.kill(child.pid, 'SIGTERM');
    throw error;
  }
}

startMockGitHub().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
