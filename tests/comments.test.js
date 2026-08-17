const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function createVscodeMock({ ghPrActive = false, workspaceRoot = '/workspace' } = {}) {
  const createdThreads = [];
  let commentController;
  let createCommentControllerCalls = 0;

  class MarkdownString {
    constructor(value) {
      this.value = value;
    }
  }

  class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  }

  const vscode = {
    extensions: {
      getExtension(id) {
        assert.equal(id, 'GitHub.vscode-pull-request-github');
        return ghPrActive ? { isActive: true } : undefined;
      },
    },
    comments: {
      createCommentController(id, label) {
        createCommentControllerCalls += 1;
        commentController = {
          id,
          label,
          options: undefined,
          commentingRangeProvider: undefined,
          disposed: false,
          createCommentThread(uri, range, comments) {
            const thread = {
              uri,
              range,
              comments,
              disposed: false,
              dispose() {
                thread.disposed = true;
              },
            };
            createdThreads.push(thread);
            return thread;
          },
          dispose() {
            commentController.disposed = true;
          },
        };
        return commentController;
      },
    },
    workspace: {
      workspaceFolders: workspaceRoot ? [{ uri: { fsPath: workspaceRoot } }] : undefined,
      fs: {
        async stat(uri) {
          const prefix = `${workspaceRoot}/`;
          if (uri.fsPath.startsWith(prefix)) {
            return {};
          }
          throw new Error('missing');
        },
      },
      asRelativePath(uri) {
        const prefix = `${workspaceRoot}/`;
        return uri.fsPath.startsWith(prefix) ? uri.fsPath.slice(prefix.length) : uri.fsPath;
      },
    },
    Uri: {
      file(fsPath) {
        return { fsPath };
      },
      parse(value) {
        return { value };
      },
    },
    MarkdownString,
    Range,
    CommentMode: {
      Preview: 'preview',
    },
    CommentThreadState: {
      Resolved: 'resolved',
      Unresolved: 'unresolved',
    },
    CommentThreadCollapsibleState: {
      Collapsed: 'collapsed',
      Expanded: 'expanded',
    },
  };

  return {
    vscode,
    get createCommentControllerCalls() {
      return createCommentControllerCalls;
    },
    get commentController() {
      return commentController;
    },
    createdThreads,
  };
}

function loadCommentsModule(vscodeMock) {
  let commentsModulePath;
  try {
    commentsModulePath = require.resolve('../dist-tests/comments.js');
    delete require.cache[commentsModulePath];
  } catch {
    return {};
  }

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') {
      return vscodeMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(commentsModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test('CommentsController stays enabled when the GitHub PR extension is active', () => {
  const env = createVscodeMock({ ghPrActive: true });
  const { CommentsController } = loadCommentsModule(env.vscode);
  const controller = new CommentsController();

  assert.equal(controller.isEnabled(), true);
  assert.equal(env.createCommentControllerCalls, 1);
});

test('CommentsController creates expanded VS Code threads, exposes commenting ranges, and tracks GitHub thread ids', async () => {
  const env = createVscodeMock();
  const { CommentsController } = loadCommentsModule(env.vscode);
  const controller = new CommentsController();
  controller.setChangedFiles(['src/github.ts']);

  await controller.update([
    {
      id: 'thread-node-1',
      path: 'src/github.ts',
      line: 4,
      startLine: 4,
      diffSide: 'RIGHT',
      isResolved: false,
      isOutdated: true,
      viewerCanResolve: true,
      viewerCanReply: true,
      comments: [
        {
          id: 'comment-1',
          body: 'Needs a test',
          author: {
            login: 'octocat',
            avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
          },
          createdAt: '2026-06-25T10:00:00Z',
          url: 'https://github.com/octo/reviewer/pull/42#discussion_r1',
        },
      ],
    },
  ]);

  assert.equal(controller.isEnabled(), true);
  assert.equal(env.createCommentControllerCalls, 1);
  assert.deepEqual(env.commentController.options, {
    placeHolder: 'Add a review comment...',
  });
  assert.ok(env.commentController.commentingRangeProvider);

  const thread = env.createdThreads[0];
  assert.equal(thread.uri.fsPath, '/workspace/src/github.ts');
  assert.equal(thread.range.start.line, 3);
  assert.equal(thread.range.start.character, 0);
  assert.equal(thread.range.end.line, 3);
  assert.equal(thread.range.end.character, 0);
  assert.equal(
    thread.comments[0].body.value,
    'Needs a test\n\n[Open on GitHub](https://github.com/octo/reviewer/pull/42#discussion_r1)',
  );
  assert.equal(thread.comments[0].body.isTrusted, false);
  assert.equal(thread.comments[0].mode, 'preview');
  assert.equal(thread.comments[0].author.name, 'octocat');
  assert.equal(
    thread.comments[0].author.iconPath.value,
    'https://avatars.githubusercontent.com/u/1?v=4',
  );
  assert.ok(thread.comments[0].timestamp instanceof Date);
  assert.equal(thread.label, '⚠ Outdated thread');
  assert.equal(thread.state, 'unresolved');
  assert.equal(thread.canReply, true);
  assert.equal(thread.collapsibleState, 'expanded');
  assert.equal(thread.contextValue, 'unresolved');
  assert.equal(controller.getThreadId(thread), 'thread-node-1');
  assert.equal(controller.getReviewThread(thread)?.id, 'thread-node-1');
  assert.equal(
    controller.getThreadUrl(thread),
    'https://github.com/octo/reviewer/pull/42#discussion_r1',
  );

  const changedRanges = env.commentController.commentingRangeProvider.provideCommentingRanges({
    uri: { fsPath: '/workspace/src/github.ts' },
    lineCount: 8,
  });
  assert.equal(changedRanges.length, 1);
  assert.equal(changedRanges[0].start.line, 0);
  assert.equal(changedRanges[0].end.line, 7);

  const unchangedRanges = env.commentController.commentingRangeProvider.provideCommentingRanges({
    uri: { fsPath: '/workspace/src/other.ts' },
    lineCount: 8,
  });
  assert.deepEqual(unchangedRanges, []);

  thread.collapsibleState = 'collapsed';
  controller.expandThread('thread-node-1');
  assert.equal(thread.collapsibleState, 'expanded');

  controller.showThread('thread-node-1', {
    toString() {
      return 'github-reviewer-remote:/src/github.ts?ref=abc123';
    },
  });
  const reboundThread = env.createdThreads[1];
  assert.equal(thread.disposed, true);
  assert.equal(reboundThread.uri.toString(), 'github-reviewer-remote:/src/github.ts?ref=abc123');
  assert.equal(controller.getThreadId(reboundThread), 'thread-node-1');
});

test('CommentsController ignores stale concurrent updates', async () => {
  const env = createVscodeMock();
  const { CommentsController } = loadCommentsModule(env.vscode);
  const controller = new CommentsController();
  const reviewThread = {
    id: 'thread-node-1',
    path: 'src/github.ts',
    line: 4,
    startLine: 4,
    diffSide: 'RIGHT',
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanReply: true,
    comments: [],
  };

  await Promise.all([
    controller.update([reviewThread]),
    controller.update([reviewThread]),
  ]);

  assert.equal(env.createdThreads.filter((thread) => !thread.disposed).length, 1);
});

test('CommentsController disposes old threads, clears thread id mappings, and disposes the controller', async () => {
  const env = createVscodeMock();
  const { CommentsController } = loadCommentsModule(env.vscode);
  const controller = new CommentsController();

  await controller.update([
    {
      id: 'thread-node-1',
      path: 'src/github.ts',
      line: 4,
      startLine: 4,
      diffSide: 'RIGHT',
      isResolved: false,
      isOutdated: false,
      viewerCanResolve: true,
      viewerCanReply: true,
      comments: [],
    },
  ]);

  const firstThread = env.createdThreads[0];

  await controller.update([
    {
      id: 'thread-node-2',
      path: 'src/github.ts',
      line: null,
      startLine: null,
      diffSide: 'RIGHT',
      isResolved: false,
      isOutdated: false,
      viewerCanResolve: true,
      viewerCanReply: false,
      comments: [],
    },
  ]);

  const secondThread = env.createdThreads[1];

  assert.equal(firstThread.disposed, true);
  assert.equal(controller.getThreadId(firstThread), undefined);
  assert.equal(controller.getThreadUrl(firstThread), undefined);
  assert.equal(secondThread.range.start.line, 0);
  assert.equal(secondThread.contextValue, 'unresolved');
  assert.equal(controller.getThreadId(secondThread), 'thread-node-2');

  controller.dispose();

  assert.equal(secondThread.disposed, true);
  assert.equal(controller.getThreadId(secondThread), undefined);
  assert.equal(env.commentController.disposed, true);
});

test('CommentsController marks resolved GitHub threads as resolved in VS Code', async () => {
  const env = createVscodeMock();
  const { CommentsController } = loadCommentsModule(env.vscode);
  const controller = new CommentsController();

  await controller.update([
    {
      id: 'thread-node-3',
      path: 'src/github.ts',
      line: 8,
      startLine: 8,
      diffSide: 'RIGHT',
      isResolved: true,
      isOutdated: false,
      viewerCanResolve: false,
      viewerCanReply: false,
      comments: [],
    },
  ]);

  const thread = env.createdThreads[0];
  assert.equal(thread.state, 'resolved');
  assert.equal(thread.contextValue, 'resolved');
});

test('CommentsController falls back to original comment line when thread line is missing', async () => {
  const env = createVscodeMock();
  const { CommentsController } = loadCommentsModule(env.vscode);
  const controller = new CommentsController();

  await controller.update([
    {
      id: 'thread-node-4',
      path: 'src/github.ts',
      line: null,
      startLine: null,
      diffSide: 'RIGHT',
      isResolved: false,
      isOutdated: false,
      viewerCanResolve: true,
      viewerCanReply: true,
      comments: [
        {
          id: 'comment-4',
          body: 'Anchor me correctly',
          author: { login: 'octocat', avatarUrl: '' },
          createdAt: '2026-06-25T10:00:00Z',
          url: 'https://github.com/octo/reviewer/pull/42#discussion_r4',
          originalLine: 23,
        },
      ],
    },
  ]);

  const thread = env.createdThreads[0];
  assert.equal(thread.range.start.line, 22);
  assert.equal(thread.range.end.line, 22);
});

test('CommentsController uses the original range for historical diff threads', async () => {
  const env = createVscodeMock();
  const { CommentsController } = loadCommentsModule(env.vscode);
  const controller = new CommentsController();

  await controller.update([{
    id: 'thread-versioned',
    path: 'src/github.ts',
    line: 30,
    startLine: 28,
    diffSide: 'RIGHT',
    isResolved: false,
    isOutdated: true,
    viewerCanResolve: true,
    viewerCanReply: true,
    comments: [{
      id: 'comment-versioned',
      body: 'Compare this change',
      author: { login: 'octocat', avatarUrl: '' },
      createdAt: '2026-06-25T10:00:00Z',
      url: 'https://github.com/octo/reviewer/pull/42#discussion_r5',
      line: 30,
      startLine: 28,
      originalLine: 12,
      originalStartLine: 10,
      commitOid: 'current-sha',
      originalCommitOid: 'original-sha',
    }],
  }]);

  controller.showThread('thread-versioned', {
    toString() {
      return 'github-reviewer-remote:/src/github.ts?ref=original-sha';
    },
  }, { preferOriginal: true });

  const historicalThread = env.createdThreads[1];
  assert.equal(historicalThread.range.start.line, 9);
  assert.equal(historicalThread.range.end.line, 11);

  controller.showThread('thread-versioned', {
    toString() {
      return 'github-reviewer-remote:/src/github.ts?ref=current-sha';
    },
  });

  const inlineThread = env.createdThreads[2];
  assert.equal(inlineThread.range.start.line, 27);
  assert.equal(inlineThread.range.end.line, 29);
});
