const fs = require('node:fs/promises');
const path = require('node:path');

const pidPath = path.resolve('.vscode-test/mock-github-server.pid');

async function stopMockGitHub() {
  let pid;
  try {
    pid = Number((await fs.readFile(pidPath, 'utf8')).trim());
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid mock GitHub API PID in ${pidPath}`);
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ESRCH') {
      throw error;
    }
  }

  await fs.rm(pidPath, { force: true });
}

stopMockGitHub().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
