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

test('CommentsController disables itself when the GitHub PR extension is active', () => {
  const env = createVscodeMock({ ghPrActive: true });
  const { CommentsController } = loadCommentsModule(env.vscode);
  const controller = new CommentsController();

  assert.equal(controller.isEnabled(), false);
  assert.equal(env.createCommentControllerCalls, 0);
});

test('CommentsController creates expanded VS Code threads, exposes commenting ranges, and tracks GitHub thread ids', () => {
  const env = createVscodeMock();
  const { CommentsController } = loadCommentsModule(env.vscode);
  const controller = new CommentsController();
  controller.setChangedFiles(['src/github.ts']);

  controller.update([
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
    placeHolder: 'Reply to this review thread...',
  });
  assert.ok(env.commentController.commentingRangeProvider);

  const thread = env.createdThreads[0];
  assert.equal(thread.uri.fsPath, '/workspace/src/github.ts');
  assert.equal(thread.range.start.line, 3);
  assert.equal(thread.range.start.character, 0);
  assert.equal(thread.range.end.line, 3);
  assert.equal(thread.range.end.character, 0);
  assert.equal(thread.comments[0].body.value, 'Needs a test');
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
});

test('CommentsController disposes old threads, clears thread id mappings, and disposes the controller', () => {
  const env = createVscodeMock();
  const { CommentsController } = loadCommentsModule(env.vscode);
  const controller = new CommentsController();

  controller.update([
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

  controller.update([
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
  assert.equal(secondThread.range.start.line, 0);
  assert.equal(secondThread.contextValue, 'unresolved');
  assert.equal(controller.getThreadId(secondThread), 'thread-node-2');

  controller.dispose();

  assert.equal(secondThread.disposed, true);
  assert.equal(controller.getThreadId(secondThread), undefined);
  assert.equal(env.commentController.disposed, true);
});

test('CommentsController marks resolved GitHub threads as resolved in VS Code', () => {
  const env = createVscodeMock();
  const { CommentsController } = loadCommentsModule(env.vscode);
  const controller = new CommentsController();

  controller.update([
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
