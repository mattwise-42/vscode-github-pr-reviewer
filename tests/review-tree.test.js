const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function createVscodeMock(workspacePath = '/workspace') {
  class Uri {
    constructor(fsPath, fragment = '') {
      this.fsPath = fsPath;
      this.fragment = fragment;
    }

    static file(fsPath) {
      return new Uri(fsPath);
    }

    with(changes) {
      return new Uri(this.fsPath, changes.fragment ?? this.fragment);
    }
  }

  class TreeItem {
    constructor(resourceOrLabel, collapsibleState) {
      this.collapsibleState = collapsibleState;

      if (resourceOrLabel instanceof Uri) {
        this.resourceUri = resourceOrLabel;
      } else {
        this.label = resourceOrLabel;
      }
    }
  }

  class EventEmitter {
    constructor() {
      this.listeners = [];
      this.event = (listener) => {
        this.listeners.push(listener);
        return {
          dispose: () => {
            this.listeners = this.listeners.filter((entry) => entry !== listener);
          },
        };
      };
    }

    fire(value) {
      for (const listener of this.listeners) {
        listener(value);
      }
    }
  }

  class ThemeIcon {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  }

  ThemeIcon.Folder = new ThemeIcon('folder');

  class MarkdownString {
    constructor(value) {
      this.value = value;
    }
  }

  return {
    EventEmitter,
    MarkdownString,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
    Uri,
    workspace: {
      workspaceFolders: [
        {
          uri: { fsPath: workspacePath },
        },
      ],
    },
  };
}

function loadReviewTreeModule(vscodeMock = createVscodeMock()) {
  try {
    const modulePath = require.resolve('../dist-tests/review-tree.js');
    delete require.cache[modulePath];

    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'vscode') {
        return vscodeMock;
      }

      return originalLoad.call(this, request, parent, isMain);
    };

    try {
      return require(modulePath);
    } finally {
      Module._load = originalLoad;
    }
  } catch {
    return {};
  }
}

function createThread(overrides = {}) {
  const hasLine = Object.prototype.hasOwnProperty.call(overrides, 'line');
  const line = hasLine ? overrides.line : 12;
  const hasStartLine = Object.prototype.hasOwnProperty.call(overrides, 'startLine');

  return {
    id: overrides.id ?? 'thread-1',
    path: overrides.path ?? 'src/example.ts',
    line,
    startLine: hasStartLine ? overrides.startLine : line,
    diffSide: overrides.diffSide ?? 'RIGHT',
    isResolved: overrides.isResolved ?? false,
    isOutdated: overrides.isOutdated ?? false,
    viewerCanResolve: true,
    viewerCanReply: true,
    comments: overrides.comments ?? [
      {
        id: 'comment-1',
        body: 'Please tighten this branch.\nMore detail here.',
        author: { login: 'octocat', avatarUrl: 'https://example.com/avatar.png' },
        createdAt: '2026-06-25T10:00:00Z',
        url: 'https://github.com/octo/reviewer/pull/42#discussion_r1',
      },
    ],
  };
}

function createFile(overrides = {}) {
  return {
    filename: overrides.filename ?? 'src/example.ts',
    status: overrides.status ?? 'modified',
    additions: overrides.additions ?? 3,
    deletions: overrides.deletions ?? 1,
    changes: overrides.changes ?? 4,
    previousFilename: overrides.previousFilename,
  };
}

function createPR(overrides = {}) {
  return {
    number: overrides.number ?? 42,
    nodeId: overrides.nodeId ?? 'PR_node_42',
    title: overrides.title ?? 'Sidebar tree',
    headRefName: overrides.headRefName ?? 'feature/sidebar-tree',
    baseRefName: overrides.baseRefName ?? 'main',
    isDraft: overrides.isDraft ?? false,
  };
}

test('ReviewTreeProvider lazily loads PR files and preserves loaded data across PR list refreshes', async () => {
  const vscodeMock = createVscodeMock('/workspace-root');
  const { FileNode, FolderNode, PRNode, ReviewTreeProvider } = loadReviewTreeModule(vscodeMock);

  assert.equal(typeof PRNode, 'function');
  assert.equal(typeof FileNode, 'function');
  assert.equal(typeof FolderNode, 'function');
  assert.equal(typeof ReviewTreeProvider, 'function');

  const provider = new ReviewTreeProvider();
  const events = [];
  const loadCalls = [];

  provider.onDidChangeTreeData((value) => events.push(value));
  provider.setLoader(async (pr) => {
    loadCalls.push(pr.number);
    return {
      files: [
        createFile({ filename: 'src/zeta.ts', additions: 1, deletions: 0 }),
        createFile({ filename: 'src/auth/alpha.ts', additions: 7, deletions: 2 }),
        createFile({ filename: 'README.md', additions: 2, deletions: 0 }),
      ],
      threads: [
        createThread({ id: 'thread-z', path: 'src/zeta.ts', line: 40 }),
        createThread({ id: 'thread-a', path: 'src/auth/alpha.ts', line: 5 }),
      ],
    };
  });

  provider.updatePRs([
    createPR({ number: 42, title: 'Sidebar tree' }),
    createPR({ number: 38, title: 'Docs update', isDraft: true, headRefName: 'docs/update' }),
  ]);

  const rootNodes = await provider.getChildren();
  assert.equal(rootNodes.length, 2);
  assert.ok(rootNodes[0] instanceof PRNode);

  const prItem = provider.getTreeItem(rootNodes[0]);
  assert.equal(prItem.label, '#42: Sidebar tree');
  assert.equal(prItem.collapsibleState, 1);
  assert.equal(prItem.iconPath.id, 'git-pull-request');
  assert.equal(prItem.contextValue, 'pr');
  assert.equal(prItem.id, 'pr-42-collapsed');

  provider.setPRExpanded(rootNodes[0], true);
  const expandedPrItem = provider.getTreeItem(rootNodes[0]);
  assert.equal(expandedPrItem.collapsibleState, 2);
  assert.equal(expandedPrItem.id, 'pr-42-expanded');

  const draftItem = provider.getTreeItem(rootNodes[1]);
  assert.equal(draftItem.iconPath.id, 'git-pull-request-draft');

  const treeNodes = await provider.getChildren(rootNodes[0]);
  assert.deepEqual(loadCalls, [42]);
  assert.equal(treeNodes.length, 2);
  assert.ok(treeNodes[0] instanceof FolderNode);
  assert.ok(treeNodes[1] instanceof FileNode);
  assert.equal(treeNodes[1].file.filename, 'README.md');
  assert.equal(treeNodes[0].name, 'src');
  assert.equal(treeNodes[0].fullPath, 'src');
  assert.equal(provider.getParent(treeNodes[0]), rootNodes[0]);

  const srcFolderItem = provider.getTreeItem(treeNodes[0]);
  assert.equal(srcFolderItem.label, 'src');
  assert.equal(srcFolderItem.collapsibleState, 2);
  assert.equal(srcFolderItem.iconPath.id, 'folder');
  assert.equal(srcFolderItem.id, 'folder-42-src');
  assert.equal(srcFolderItem.tooltip, 'src');
  assert.equal(srcFolderItem.contextValue, 'folder');

  const srcChildren = await provider.getChildren(treeNodes[0]);
  assert.equal(srcChildren.length, 2);
  assert.ok(srcChildren[0] instanceof FolderNode);
  assert.ok(srcChildren[1] instanceof FileNode);
  assert.equal(srcChildren[0].name, 'auth');
  assert.equal(srcChildren[1].file.filename, 'src/zeta.ts');

  const authChildren = await provider.getChildren(srcChildren[0]);
  assert.equal(authChildren.length, 1);
  assert.ok(authChildren[0] instanceof FileNode);
  assert.equal(authChildren[0].file.filename, 'src/auth/alpha.ts');
  assert.equal(provider.getParent(authChildren[0]), srcChildren[0]);
  assert.equal(provider.findFileNode('src/auth/alpha.ts')?.file.filename, 'src/auth/alpha.ts');
  assert.equal(provider.findFileNode('README.md')?.file.filename, 'README.md');
  assert.equal(provider.findFileNode('missing.ts'), undefined);
  assert.equal(rootNodes[0].loaded, true);
  assert.equal(events.length, 2);
  assert.equal(events[0], undefined);
  assert.equal(events[1], rootNodes[0]);

  provider.updatePRs([
    createPR({ number: 42, title: 'Sidebar tree v2' }),
    createPR({ number: 38, title: 'Docs update', isDraft: true, headRefName: 'docs/update' }),
  ]);

  const refreshedNodes = await provider.getChildren();
  const refreshedTree = await provider.getChildren(refreshedNodes[0]);
  assert.deepEqual(loadCalls, [42]);
  assert.equal(refreshedTree.length, 2);
  assert.ok(refreshedTree[0] instanceof FolderNode);
  assert.ok(refreshedTree[1] instanceof FileNode);
});

test('ReviewTreeProvider builds file and thread items, parents, navigation ordering, and badge counts', async () => {
  const vscodeMock = createVscodeMock('/workspace-root');
  const { CommentNode, FileNode, PRNode, ReviewTreeProvider, ThreadNode } = loadReviewTreeModule(vscodeMock);
  const provider = new ReviewTreeProvider();

  provider.updatePRs([createPR()]);
  const [prNode] = await provider.getChildren();
  const alphaThread = createThread({
    id: 'thread-a',
    path: 'src/alpha.ts',
    line: 33,
    comments: [
      {
        id: 'comment-live',
        body: 'Refactor this conditional before merging.\nSecond line ignored.',
        author: { login: 'hubot', avatarUrl: '' },
        createdAt: '2026-06-25T10:00:00Z',
        url: 'https://github.com/octo/reviewer/pull/42#discussion_r10',
      },
      {
        id: 'comment-reply',
        body: 'I updated the branch and added coverage.',
        author: { login: 'octocat', avatarUrl: '' },
        createdAt: '2026-06-25T10:15:00Z',
        url: 'https://github.com/octo/reviewer/pull/42#discussion_r11',
      },
    ],
  });
  const outdatedThread = createThread({
    id: 'thread-old',
    path: 'src/alpha.ts',
    line: null,
    startLine: null,
    isOutdated: true,
    comments: [],
  });
  const resolvedThread = createThread({
    id: 'thread-resolved',
    path: 'src/alpha.ts',
    line: 1,
    isResolved: true,
  });
  const betaThread = createThread({ id: 'thread-b', path: 'src/beta.ts', line: 2 });

  prNode.loaded = true;
  prNode.fileNodes = [
    new FileNode(
      createFile({ filename: 'src/alpha.ts', additions: 12, deletions: 3 }),
      prNode,
      [alphaThread, outdatedThread, resolvedThread],
    ),
    new FileNode(
      createFile({ filename: 'src/beta.ts', additions: 5, deletions: 1 }),
      prNode,
      [betaThread],
    ),
  ];

  const fileItem = provider.getTreeItem(prNode.fileNodes[0]);
  assert.equal(fileItem.resourceUri.fsPath, '/workspace-root/src/alpha.ts');
  assert.equal(fileItem.collapsibleState, 2);
  assert.equal(fileItem.description, '+12 -3');
  assert.equal(fileItem.tooltip, 'src/alpha.ts — 2 unresolved');
  assert.equal(fileItem.contextValue, 'file');
  assert.equal(fileItem.command.command, 'githubReviewer.openFile');
  assert.equal(fileItem.command.arguments[0], prNode.fileNodes[0]);

  const threadNodes = await provider.getChildren(prNode.fileNodes[0]);
  assert.deepEqual(threadNodes.map((node) => node.thread.id), ['thread-old', 'thread-a']);
  const liveNode = threadNodes.find((node) => node.thread.id === 'thread-a');
  const oldNode = threadNodes.find((node) => node.thread.id === 'thread-old');
  assert.ok(liveNode instanceof ThreadNode);
  assert.ok(oldNode instanceof ThreadNode);
  assert.equal(provider.getParent(prNode.fileNodes[0]), prNode);
  assert.equal(provider.getParent(liveNode), prNode.fileNodes[0]);
  const commentNodes = await provider.getChildren(liveNode);
  assert.equal(commentNodes.length, 2);
  assert.ok(commentNodes[0] instanceof CommentNode);
  assert.equal(provider.getParent(commentNodes[0]), liveNode);
  assert.equal((await provider.getChildren(commentNodes[0])).length, 0);

  const liveItem = provider.getTreeItem(liveNode);
  assert.equal(liveItem.label, 'hubot: Refactor this conditional before merging.');
  assert.equal(liveItem.collapsibleState, 2);
  assert.equal(liveItem.iconPath.id, 'comment-unresolved');
  assert.equal(liveItem.description, ':33 2 comments');
  assert.equal(
    liveItem.tooltip.value,
    '**hubot** on `src/alpha.ts:33`\n\nRefactor this conditional before merging.\nSecond line ignored.',
  );
  assert.equal(liveItem.contextValue, 'thread-unresolved');
  assert.equal(liveItem.id, 'thread-thread-a');
  assert.equal(liveItem.command.command, 'githubReviewer.openThread');
  assert.equal(liveItem.command.title, 'Open thread');
  assert.equal(liveItem.command.arguments[0], liveNode);

  const firstCommentItem = provider.getTreeItem(commentNodes[0]);
  assert.equal(firstCommentItem.label, 'hubot: Refactor this conditional before merging.');
  assert.equal(firstCommentItem.collapsibleState, 0);
  assert.equal(firstCommentItem.iconPath.id, 'comment');
  assert.equal(firstCommentItem.description, 'opened');
  assert.equal(
    firstCommentItem.tooltip.value,
    'Refactor this conditional before merging.\nSecond line ignored.',
  );
  assert.equal(firstCommentItem.contextValue, 'comment');
  assert.equal(firstCommentItem.id, 'comment-comment-live');
  assert.equal(firstCommentItem.command.command, 'githubReviewer.openThread');
  assert.equal(firstCommentItem.command.arguments[0], liveNode);

  const secondCommentItem = provider.getTreeItem(commentNodes[1]);
  assert.equal(secondCommentItem.label, 'octocat: I updated the branch and added coverage.');
  assert.equal(secondCommentItem.description, 'reply 1');

  const outdatedItem = provider.getTreeItem(oldNode);
  assert.equal(outdatedItem.label, 'unknown: (no comment)');
  assert.equal(outdatedItem.iconPath.id, 'comment-draft');
  assert.equal(outdatedItem.description, '');
  assert.equal(outdatedItem.contextValue, 'thread-outdated');
  assert.equal(outdatedItem.command.command, 'githubReviewer.openThread');
  assert.equal(outdatedItem.command.arguments[0], oldNode);

  provider.showResolved = true;
  const allVisibleThreadNodes = await provider.getChildren(prNode.fileNodes[0]);
  assert.deepEqual(allVisibleThreadNodes.map((node) => node.thread.id), [
    'thread-old',
    'thread-resolved',
    'thread-a',
  ]);
  const resolvedNode = allVisibleThreadNodes.find((node) => node.thread.id === 'thread-resolved');
  const resolvedItem = provider.getTreeItem(resolvedNode);
  assert.equal(resolvedItem.iconPath.id, 'pass');
  assert.equal(resolvedItem.contextValue, 'thread-resolved');
  provider.showResolved = false;

  const treeView = { badge: undefined };
  provider.setBadge(treeView);
  assert.deepEqual(treeView.badge, {
    value: 3,
    tooltip: '3 unresolved threads',
  });
  assert.equal(provider.unresolvedCount(), 3);
  assert.equal(provider.unresolvedCount(prNode), 3);

  const updatedPrNode = provider.markThreadResolved('thread-a');
  assert.equal(updatedPrNode, prNode);
  assert.equal(alphaThread.isResolved, true);
  assert.equal(provider.unresolvedCount(), 2);
  assert.equal(provider.markThreadResolved('missing-thread'), undefined);

  const allThreadNodes = provider.getAllThreadNodes();
  assert.deepEqual(allThreadNodes.map((node) => node.thread.id), ['thread-old', 'thread-b']);

  const refreshEvents = [];
  provider.onDidChangeTreeData((value) => refreshEvents.push(value));
  provider.refresh(prNode.fileNodes[0]);
  assert.equal(refreshEvents.at(-1), prNode.fileNodes[0]);
});
