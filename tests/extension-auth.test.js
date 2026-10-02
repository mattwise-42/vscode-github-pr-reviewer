const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadExtensionModule(vscodeMock) {
  const modulePath = require.resolve('../dist/extension.js');
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
}

function createVscodeMock({ errorAction } = {}) {
  const commands = new Map();
  const sessionCalls = [];
  const treeProviders = [];
  const errorMessages = [];
  const outputLines = [];
  let treeEvents = 0;
  const disposable = { dispose() {} };

  class EventEmitter {
    listeners = new Set();

    event = (listener) => {
      this.listeners.add(listener);
      return disposable;
    };

    fire(value) {
      for (const listener of this.listeners) {
        listener(value);
      }
    }
  }

  const vscode = {
    authentication: {
      async getSession(providerId, scopes, options) {
        sessionCalls.push({ providerId, scopes, options });
        return {
          id: `session-${sessionCalls.length}`,
          accessToken: `token-${sessionCalls.length}`,
          account: { id: `account-${sessionCalls.length}`, label: `Account ${sessionCalls.length}` },
          scopes,
        };
      },
    },
    window: {
      createOutputChannel() {
        return { appendLine(line) { outputLines.push(line); }, show() {}, dispose() {} };
      },
      createTreeView(_id, options) {
        treeProviders.push(options.treeDataProvider);
        return {
          badge: undefined,
          onDidChangeSelection() {
            return disposable;
          },
          async reveal() {},
          dispose() {},
        };
      },
      onDidChangeActiveTextEditor() {
        return disposable;
      },
      async showErrorMessage(message, ...actions) {
        errorMessages.push({ message, actions });
        return errorAction;
      },
    },
    workspace: {
      workspaceFolders: undefined,
      registerTextDocumentContentProvider() {
        return disposable;
      },
    },
    comments: {
      createCommentController() {
        return { dispose() {} };
      },
    },
    commands: {
      registerCommand(id, callback) {
        commands.set(id, callback);
        return disposable;
      },
      async executeCommand(id, ...args) {
        return commands.get(id)?.(...args);
      },
    },
    extensions: {
      getExtension() {
        return undefined;
      },
    },
    EventEmitter,
  };

  return {
    vscode,
    commands,
    sessionCalls,
    errorMessages,
    outputLines,
    get treeEvents() {
      return treeEvents;
    },
    trackTreeEvents() {
      treeProviders[0].onDidChangeTreeData(() => {
        treeEvents += 1;
      });
    },
  };
}

test('switch GitHub account clears the session preference and reloads pull requests', async () => {
  const manifest = require('../package.json');
  assert.ok(manifest.contributes.commands.some(
    (command) => command.command === 'githubReviewer.switchGitHubAccount',
  ));

  const previousTestToken = process.env.GITHUB_REVIEWER_TEST_TOKEN;
  const previousDevWorkspace = process.env.GITHUB_REVIEWER_DEV_WORKSPACE;
  delete process.env.GITHUB_REVIEWER_TEST_TOKEN;
  delete process.env.GITHUB_REVIEWER_DEV_WORKSPACE;
  const env = createVscodeMock();

  try {
    const extension = loadExtensionModule(env.vscode);
    await extension.activate({ subscriptions: [] });
    env.trackTreeEvents();

    const switchAccount = env.commands.get('githubReviewer.switchGitHubAccount');
    assert.equal(typeof switchAccount, 'function');
    await switchAccount();

    assert.deepEqual(env.sessionCalls[1], {
      providerId: 'github',
      scopes: ['read:user', 'user:email', 'repo'],
      options: { clearSessionPreference: true, forceNewSession: true },
    });
    assert.ok(env.outputLines.some((line) =>
      line.includes('GitHub session available for Account 1 (scopes: read:user, user:email, repo)')));
    assert.ok(env.outputLines.some((line) =>
      line.includes('Selected GitHub account Account 2 (scopes: read:user, user:email, repo)')));
    assert.ok(env.outputLines.every((line) => !line.includes('token-')));
    assert.equal(env.treeEvents, 2);
  } finally {
    if (previousTestToken === undefined) {
      delete process.env.GITHUB_REVIEWER_TEST_TOKEN;
    } else {
      process.env.GITHUB_REVIEWER_TEST_TOKEN = previousTestToken;
    }
    if (previousDevWorkspace === undefined) {
      delete process.env.GITHUB_REVIEWER_DEV_WORKSPACE;
    } else {
      process.env.GITHUB_REVIEWER_DEV_WORKSPACE = previousDevWorkspace;
    }
  }
});

test('a 404 offers account switching and retries with the selected session', async () => {
  const previousTestToken = process.env.GITHUB_REVIEWER_TEST_TOKEN;
  const previousDevWorkspace = process.env.GITHUB_REVIEWER_DEV_WORKSPACE;
  const originalFetch = global.fetch;
  delete process.env.GITHUB_REVIEWER_TEST_TOKEN;
  delete process.env.GITHUB_REVIEWER_DEV_WORKSPACE;
  const env = createVscodeMock({ errorAction: 'Switch GitHub Account' });
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url: String(url), authorization: init.headers.Authorization });
    return requests.length === 1
      ? { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) }
      : { ok: true, status: 200, json: async () => [] };
  };

  try {
    const extension = loadExtensionModule(env.vscode);
    await extension.activate({ subscriptions: [] });
    env.vscode.workspace.workspaceFolders = [{ uri: { fsPath: process.cwd() } }];

    await env.commands.get('githubReviewer.refresh')();

    assert.match(env.errorMessages[0].message, /404/);
    assert.ok(env.errorMessages[0].actions.includes('Switch GitHub Account'));
    assert.equal(env.sessionCalls[1].options.clearSessionPreference, true);
    assert.equal(env.sessionCalls[1].options.forceNewSession, true);
    assert.equal(requests.length, 2);
    assert.match(requests[1].authorization, /token-2$/);
  } finally {
    global.fetch = originalFetch;
    if (previousTestToken === undefined) {
      delete process.env.GITHUB_REVIEWER_TEST_TOKEN;
    } else {
      process.env.GITHUB_REVIEWER_TEST_TOKEN = previousTestToken;
    }
    if (previousDevWorkspace === undefined) {
      delete process.env.GITHUB_REVIEWER_DEV_WORKSPACE;
    } else {
      process.env.GITHUB_REVIEWER_DEV_WORKSPACE = previousDevWorkspace;
    }
  }
});
