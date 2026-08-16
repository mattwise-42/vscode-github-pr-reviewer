const http = require('node:http');
const { execFileSync } = require('node:child_process');

const port = Number(process.env.GITHUB_REVIEWER_MOCK_PORT ?? 43123);
const mockFile = process.env.GITHUB_REVIEWER_MOCK_FILE ?? 'src/fixture.ts';
const configuredBranch = process.env.GITHUB_REVIEWER_MOCK_BRANCH;
const mockBranch = configuredBranch === 'auto'
  ? execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
  : configuredBranch ?? 'feature/review';

if (!mockBranch) {
  throw new Error('Unable to determine the mock GitHub branch');
}

const prs = [
  {
    number: 42,
    node_id: 'PR_node_42',
    title: 'Fixture PR',
    draft: false,
    head: { ref: mockBranch },
    base: { ref: 'main' },
  },
  {
    number: 43,
    node_id: 'PR_node_43',
    title: 'Second Fixture PR',
    draft: false,
    head: { ref: 'feature/second' },
    base: { ref: 'main' },
  },
];

const threads = new Map([
  ['thread-42', {
    id: 'thread-42',
    isResolved: false,
    isOutdated: false,
    path: mockFile,
    line: 2,
    startLine: 2,
    diffSide: 'RIGHT',
    viewerCanResolve: true,
    viewerCanReply: true,
    comments: [{
      id: 'comment-42',
      body: 'Please review this fixture thread.',
      author: { login: 'test-user', avatarUrl: '' },
      createdAt: '2026-08-15T18:00:00Z',
      url: 'http://github.test/pull/42#discussion_r42',
      line: 2,
      startLine: 2,
      originalLine: 2,
      originalStartLine: 2,
      commit: { oid: 'fixture-commit-42' },
      originalCommit: { oid: 'fixture-commit-42' },
    }],
  }],
  ['thread-42-resolved', {
    id: 'thread-42-resolved',
    isResolved: true,
    isOutdated: false,
    path: mockFile,
    line: 3,
    startLine: 3,
    diffSide: 'RIGHT',
    viewerCanResolve: true,
    viewerCanReply: true,
    comments: [{
    id: 'comment-42-resolved',
    body: 'This fixture thread is already resolved.',
    author: { login: 'test-user', avatarUrl: '' },
    createdAt: '2026-08-15T18:01:00Z',
    url: 'http://github.test/pull/42#discussion_r42_resolved',
    line: 3,
    startLine: 3,
    originalLine: 3,
    originalStartLine: 3,
    commit: { oid: 'fixture-commit-42' },
    originalCommit: { oid: 'fixture-commit-42' },
    }],
  }],
  ['thread-43', {
    id: 'thread-43',
    isResolved: false,
    isOutdated: false,
    path: mockFile,
    line: 2,
    startLine: 2,
    diffSide: 'RIGHT',
    viewerCanResolve: true,
    viewerCanReply: true,
    comments: [{
      id: 'comment-43',
      body: 'Review the second branch fixture.',
      author: { login: 'test-user', avatarUrl: '' },
      createdAt: '2026-08-15T18:00:00Z',
      url: 'http://github.test/pull/43#discussion_r43',
      line: 2,
      startLine: 2,
      originalLine: 2,
      originalStartLine: 2,
      commit: { oid: 'fixture-commit-43' },
      originalCommit: { oid: 'fixture-commit-43' },
    }],
  }],
  ['thread-43-resolved', {
    id: 'thread-43-resolved',
    isResolved: true,
    isOutdated: false,
    path: mockFile,
    line: 3,
    startLine: 3,
    diffSide: 'RIGHT',
    viewerCanResolve: true,
    viewerCanReply: true,
    comments: [{
    id: 'comment-43-resolved',
    body: 'This second fixture thread is already resolved.',
    author: { login: 'test-user', avatarUrl: '' },
    createdAt: '2026-08-15T18:01:00Z',
    url: 'http://github.test/pull/43#discussion_r43_resolved',
    line: 3,
    startLine: 3,
    originalLine: 3,
    originalStartLine: 3,
    commit: { oid: 'fixture-commit-43' },
    originalCommit: { oid: 'fixture-commit-43' },
    }],
  }],
]);

function writeJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function threadForPullRequest(number) {
  return [...threads.values()]
    .filter((thread) =>
      thread.id === `thread-${number}` || thread.id.startsWith(`thread-${number}-`))
    .map((thread) => {
      const clone = structuredClone(thread);
      clone.comments = { nodes: clone.comments };
      return clone;
    });
}

function handleGraphQL(payload) {
  const variables = payload.variables ?? {};
  if (payload.query.includes('GetPRReviewThreads')) {
    return {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: threadForPullRequest(variables.prNumber),
            },
          },
        },
      },
    };
  }

  if (payload.query.includes('ResolveThread')) {
    const thread = threads.get(variables.threadId);
    if (!thread) {
      return { errors: [{ message: 'Thread not found' }] };
    }

    thread.isResolved = true;
    return {
      data: {
        resolveReviewThread: {
          thread: { id: thread.id, isResolved: true },
        },
      },
    };
  }

  if (payload.query.includes('ReplyToThread')) {
    const thread = threads.get(variables.threadId);
    if (!thread) {
      return { errors: [{ message: 'Thread not found' }] };
    }

    const comment = {
      id: `reply-${thread.id}`,
      body: variables.body,
      author: { login: 'test-user', avatarUrl: '' },
      createdAt: '2026-08-15T18:05:00Z',
      url: `http://github.test/pull/${thread.id.slice(7)}#reply`,
    };
    thread.comments.push(comment);
    return {
      data: {
        addPullRequestReviewThreadReply: { comment },
      },
    };
  }

  return { errors: [{ message: 'Unsupported GraphQL operation' }] };
}

const server = http.createServer(async (request, response) => {
  if (request.url === '/health') {
    writeJson(response, 200, { status: 'ok' });
    return;
  }

  if (request.headers.authorization !== 'Bearer test-token') {
    writeJson(response, 401, { message: 'Unauthorized' });
    return;
  }

  const requestUrl = new URL(request.url, `http://127.0.0.1:${port}`);
  if (
    request.method === 'GET'
    && /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(requestUrl.pathname)
  ) {
    writeJson(response, 200, prs);
    return;
  }

  if (
    request.method === 'GET'
    && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/.test(requestUrl.pathname)
  ) {
    writeJson(response, 200, [{
      filename: mockFile,
      status: 'modified',
      additions: 1,
      deletions: 0,
      changes: 1,
    }]);
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/graphql') {
    try {
      writeJson(response, 200, handleGraphQL(JSON.parse(await readBody(request))));
    } catch (error) {
      writeJson(response, 400, { message: error instanceof Error ? error.message : 'Invalid request' });
    }
    return;
  }

  writeJson(response, 404, { message: 'Not found' });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Mock GitHub server listening on ${port}\n`);
});
