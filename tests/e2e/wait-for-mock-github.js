const port = Number(process.env.GITHUB_REVIEWER_MOCK_PORT ?? 43123);
const healthUrl = `http://127.0.0.1:${port}/health`;
const deadline = Date.now() + 30_000;

async function waitForMockGitHub() {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for mock GitHub API at ${healthUrl}`);
}

waitForMockGitHub().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
