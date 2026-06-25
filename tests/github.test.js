const test = require('node:test');
const assert = require('node:assert/strict');

function loadGithubModule() {
  try {
    const modulePath = require.resolve('../dist-tests/github.js');
    delete require.cache[modulePath];
    return require(modulePath);
  } catch {
    return {};
  }
}

function mockFetch(handler) {
  const originalFetch = global.fetch;
  global.fetch = handler;
  return () => {
    global.fetch = originalFetch;
  };
}

function createResponse({ ok = true, status = 200, json }) {
  return {
    ok,
    status,
    json: async () => json,
  };
}

test('parseGitHubRemote parses GitHub HTTPS and SSH remotes', () => {
  const { parseGitHubRemote } = loadGithubModule();

  assert.deepEqual(
    parseGitHubRemote?.('https://github.com/octo/repo.git'),
    { owner: 'octo', repo: 'repo' },
  );
  assert.deepEqual(
    parseGitHubRemote?.('git@github.com:octo/repo.git'),
    { owner: 'octo', repo: 'repo' },
  );
  assert.equal(parseGitHubRemote?.('https://example.com/octo/repo.git'), null);
});

test('findPRForBranch calls the GitHub pulls REST API and returns the first open PR', async () => {
  const { findPRForBranch } = loadGithubModule();
  const restoreFetch = mockFetch(async (url, init) => {
    const parsedUrl = new URL(url);
    assert.equal(parsedUrl.pathname, '/repos/octo/reviewer/pulls');
    assert.equal(parsedUrl.searchParams.get('head'), 'octo:feature/thread-sidebar');
    assert.equal(parsedUrl.searchParams.get('state'), 'open');
    assert.equal(init?.headers?.Authorization, 'Bearer token-123');
    assert.equal(init?.headers?.Accept, 'application/vnd.github+json');

    return createResponse({
      json: [
        { number: 42, node_id: 'PR_node_42', title: 'Thread sidebar' },
        { number: 99, node_id: 'PR_node_99', title: 'Ignored later PR' },
      ],
    });
  });

  try {
    const pr = await findPRForBranch?.(
      'token-123',
      { owner: 'octo', repo: 'reviewer' },
      'feature/thread-sidebar',
    );

    assert.deepEqual(pr, {
      number: 42,
      nodeId: 'PR_node_42',
      title: 'Thread sidebar',
    });
  } finally {
    restoreFetch();
  }
});

test('fetchOpenPRs loads the first page of open pull requests and maps branch metadata', async () => {
  const { fetchOpenPRs } = loadGithubModule();
  const restoreFetch = mockFetch(async (url, init) => {
    assert.equal(
      url,
      'https://api.github.com/repos/octo/reviewer/pulls?state=open&per_page=30',
    );
    assert.equal(init?.headers?.Authorization, 'Bearer token-123');
    assert.equal(init?.headers?.Accept, 'application/vnd.github+json');

    return createResponse({
      json: [
        {
          number: 42,
          node_id: 'PR_node_42',
          title: 'Thread sidebar',
          draft: false,
          head: { ref: 'feature/thread-sidebar' },
        },
        {
          number: 43,
          node_id: 'PR_node_43',
          title: 'Docs polish',
          draft: true,
          head: { ref: 'docs/polish' },
        },
      ],
    });
  });

  try {
    const prs = await fetchOpenPRs?.(
      'token-123',
      { owner: 'octo', repo: 'reviewer' },
    );

    assert.deepEqual(prs, [
      {
        number: 42,
        nodeId: 'PR_node_42',
        title: 'Thread sidebar',
        headRefName: 'feature/thread-sidebar',
        isDraft: false,
      },
      {
        number: 43,
        nodeId: 'PR_node_43',
        title: 'Docs polish',
        headRefName: 'docs/polish',
        isDraft: true,
      },
    ]);
  } finally {
    restoreFetch();
  }
});

test('fetchReviewThreads returns resolved and unresolved threads and normalizes comment authors', async () => {
  const { fetchReviewThreads } = loadGithubModule();
  const restoreFetch = mockFetch(async (url, init) => {
    assert.equal(url, 'https://api.github.com/graphql');
    assert.equal(init?.headers?.Authorization, 'Bearer token-123');
    assert.equal(init?.headers?.Accept, 'application/vnd.github+json');

    const payload = JSON.parse(init?.body ?? '{}');
    assert.match(payload.query, /query GetPRReviewThreads/);
    assert.deepEqual(payload.variables, {
      owner: 'octo',
      repo: 'reviewer',
      prNumber: 42,
    });

    return createResponse({
      json: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: 'thread-1',
                    isResolved: false,
                    isOutdated: false,
                    path: 'src/github.ts',
                    line: 27,
                    startLine: 20,
                    diffSide: null,
                    viewerCanResolve: true,
                    viewerCanReply: true,
                    comments: {
                      nodes: [
                        {
                          id: 'comment-1',
                          body: 'Needs a test',
                          author: null,
                          createdAt: '2026-06-25T10:00:00Z',
                          url: 'https://github.com/octo/reviewer/pull/42#discussion_r1',
                        },
                      ],
                    },
                  },
                  {
                    id: 'thread-2',
                    isResolved: true,
                    isOutdated: false,
                    path: 'src/ignored.ts',
                    line: 11,
                    startLine: 11,
                    diffSide: 'RIGHT',
                    viewerCanResolve: true,
                    viewerCanReply: true,
                    comments: { nodes: [] },
                  },
                ],
              },
            },
          },
        },
      },
    });
  });

  try {
    const threads = await fetchReviewThreads?.(
      'token-123',
      { owner: 'octo', repo: 'reviewer' },
      42,
    );

    assert.deepEqual(threads, [
      {
        id: 'thread-1',
        isResolved: false,
        isOutdated: false,
        path: 'src/github.ts',
        line: 27,
        startLine: 20,
        diffSide: 'RIGHT',
        viewerCanResolve: true,
        viewerCanReply: true,
        comments: [
          {
            id: 'comment-1',
            body: 'Needs a test',
            author: { login: 'ghost', avatarUrl: '' },
            createdAt: '2026-06-25T10:00:00Z',
            url: 'https://github.com/octo/reviewer/pull/42#discussion_r1',
          },
        ],
      },
      {
        id: 'thread-2',
        isResolved: true,
        isOutdated: false,
        path: 'src/ignored.ts',
        line: 11,
        startLine: 11,
        diffSide: 'RIGHT',
        viewerCanResolve: true,
        viewerCanReply: true,
        comments: [],
      },
    ]);
  } finally {
    restoreFetch();
  }
});

test('resolveThread sends the GraphQL mutation and throws the first GraphQL error', async () => {
  const { resolveThread } = loadGithubModule();
  let calls = 0;
  const restoreFetch = mockFetch(async (_url, init) => {
    calls += 1;
    const payload = JSON.parse(init?.body ?? '{}');
    assert.match(payload.query, /mutation ResolveThread/);
    assert.equal(payload.variables.threadId, 'thread-node-1');

    return createResponse({
      json: calls === 1
        ? {
            data: {
              resolveReviewThread: {
                thread: { id: 'thread-node-1', isResolved: true },
              },
            },
          }
        : {
            errors: [{ message: 'Thread already resolved' }],
          },
    });
  });

  try {
    await resolveThread?.('token-123', 'thread-node-1');
    await assert.rejects(
      () => resolveThread?.('token-123', 'thread-node-1'),
      /Thread already resolved/,
    );
  } finally {
    restoreFetch();
  }
});

test('replyToThread posts a thread reply and returns the created comment', async () => {
  const { replyToThread } = loadGithubModule();
  const restoreFetch = mockFetch(async (_url, init) => {
    const payload = JSON.parse(init?.body ?? '{}');
    assert.match(payload.query, /addPullRequestReviewThreadReply/);
    assert.deepEqual(payload.variables, {
      threadId: 'thread-node-1',
      body: 'Done',
    });

    return createResponse({
      json: {
        data: {
          addPullRequestReviewThreadReply: {
            comment: {
              id: 'comment-2',
              body: 'Done',
              createdAt: '2026-06-25T10:05:00Z',
              author: {
                login: 'octocat',
                avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
              },
              url: 'https://github.com/octo/reviewer/pull/42#discussion_r2',
            },
          },
        },
      },
    });
  });

  try {
    const comment = await replyToThread?.('token-123', 'thread-node-1', 'Done');

    assert.deepEqual(comment, {
      id: 'comment-2',
      body: 'Done',
      createdAt: '2026-06-25T10:05:00Z',
      author: {
        login: 'octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      },
      url: 'https://github.com/octo/reviewer/pull/42#discussion_r2',
    });
  } finally {
    restoreFetch();
  }
});

test('createReviewComment submits a single-comment review thread', async () => {
  const { createReviewComment } = loadGithubModule();
  const restoreFetch = mockFetch(async (_url, init) => {
    const payload = JSON.parse(init?.body ?? '{}');
    assert.match(payload.query, /mutation CreateComment/);
    assert.deepEqual(payload.variables, {
      input: {
        pullRequestId: 'PR_node_42',
        event: 'COMMENT',
        threads: [
          {
            path: 'src/github.ts',
            line: 14,
            body: 'Add a comment thread here',
            side: 'RIGHT',
          },
        ],
      },
    });

    return createResponse({
      json: {
        data: {
          addPullRequestReview: {
            pullRequestReview: {
              id: 'review-1',
              state: 'COMMENTED',
            },
          },
        },
      },
    });
  });

  try {
    await createReviewComment?.(
      'token-123',
      'PR_node_42',
      'src/github.ts',
      14,
      'Add a comment thread here',
    );
  } finally {
    restoreFetch();
  }
});
