import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  createReviewComment,
  fetchOpenPRs,
  fetchPRFiles,
  fetchReviewThreads,
  GitHubRepo,
  parseGitHubRemote,
  PRSummary,
  replyToThread,
  resolveThread,
  ReviewThread,
} from './github';
import {
  PRNode,
  ReviewTreeNode,
  ReviewTreeProvider,
  ThreadNode,
} from './review-tree';
import { CommentsController } from './comments';

const execFileAsync = promisify(execFile);

interface GitRepositoryState {
  HEAD?: {
    name?: string;
  };
  onDidChange(listener: () => void): vscode.Disposable;
}

interface GitRepository {
  state: GitRepositoryState;
}

interface GitApi {
  repositories: GitRepository[];
}

interface GitExtensionApi {
  getAPI(version: number): GitApi;
}

async function getGitHubSession(
  options: { silent?: boolean; createIfNone?: boolean },
): Promise<vscode.AuthenticationSession | undefined> {
  try {
    return await vscode.authentication.getSession('github', ['repo'], options);
  } catch {
    return undefined;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let session = await getGitHubSession({ silent: true });
  let currentRepo: GitHubRepo | null = null;
  let currentBranch: string | null = null;
  let navIndex = 0;

  const reviewProvider = new ReviewTreeProvider();
  const treeView = vscode.window.createTreeView<ReviewTreeNode>('githubReviewer.reviewView', {
    treeDataProvider: reviewProvider,
    showCollapseAll: true,
  });
  const commentsCtrl = new CommentsController();

  function currentBranchNode(): PRNode | undefined {
    return currentBranch
      ? reviewProvider.prNodes.find((node) => node.pr.headRefName === currentBranch)
      : undefined;
  }

  function syncComments(): void {
    const node = currentBranchNode();
    const threads = node?.fileNodes.flatMap((fileNode) => fileNode.threads) ?? [];
    const files = node?.fileNodes.map((fileNode) => fileNode.file.filename) ?? [];
    commentsCtrl.update(threads);
    commentsCtrl.setChangedFiles(files);
  }

  reviewProvider.setLoader(async (pr: PRSummary) => {
    if (!session || !currentRepo) {
      return { files: [], threads: [] };
    }

    const [files, threads] = await Promise.all([
      fetchPRFiles(session.accessToken, currentRepo, pr.number),
      fetchReviewThreads(session.accessToken, currentRepo, pr.number),
    ]);
    return { files, threads };
  });

  const reviewTreeSubscription = reviewProvider.onDidChangeTreeData(() => {
    reviewProvider.setBadge(treeView);
    syncComments();
  });

  async function navigateToThread(thread: ReviewThread): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const fileUri = vscode.Uri.file(`${workspaceRoot}/${thread.path}`);
    const line = thread.line != null ? thread.line - 1 : 0;
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(line, 0, line, 0),
      });
    } catch {}
  }

  async function loadPRs(options: { forceReloadCurrentPR?: boolean } = {}): Promise<void> {
    if (!session) {
      session = await getGitHubSession({ silent: true });
    }
    if (!session) {
      currentRepo = null;
      currentBranch = null;
      navIndex = 0;
      reviewProvider.updatePRs([]);
      commentsCtrl.update([]);
      commentsCtrl.setChangedFiles([]);
      return;
    }

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      currentRepo = null;
      currentBranch = null;
      navIndex = 0;
      reviewProvider.updatePRs([]);
      commentsCtrl.update([]);
      commentsCtrl.setChangedFiles([]);
      return;
    }

    let repo: GitHubRepo | null = null;
    let branch: string | null = null;
    try {
      const [{ stdout: remoteOut }, { stdout: branchOut }] = await Promise.all([
        execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd }),
        execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }),
      ]);
      repo = parseGitHubRemote(remoteOut.trim());
      branch = branchOut.trim() || null;
    } catch {
      repo = null;
      branch = null;
    }

    if (!repo) {
      currentRepo = null;
      currentBranch = null;
      navIndex = 0;
      reviewProvider.updatePRs([]);
      commentsCtrl.update([]);
      commentsCtrl.setChangedFiles([]);
      return;
    }

    currentRepo = repo;
    currentBranch = branch;

    const prs = await fetchOpenPRs(session.accessToken, repo);
    reviewProvider.updatePRs(prs);

    const matchingPR = currentBranchNode();
    if (matchingPR && options.forceReloadCurrentPR) {
      matchingPR.loaded = false;
      matchingPR.fileNodes = [];
    }

    navIndex = 0;
    reviewProvider.setBadge(treeView);
    syncComments();

    if (matchingPR) {
      try {
        await treeView.reveal(matchingPR, { expand: true, focus: false, select: false });
      } catch {}
      reviewProvider.setBadge(treeView);
      syncComments();
    }
  }

  const refreshCommand = vscode.commands.registerCommand('githubReviewer.refresh', async () => {
    try {
      if (!session) {
        session = await vscode.authentication.getSession('github', ['repo'], {
          createIfNone: true,
        });
      }

      await loadPRs({ forceReloadCurrentPR: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to refresh GitHub review threads.';
      void vscode.window.showErrorMessage(message);
    }
  });

  void vscode.commands.executeCommand('setContext', 'githubReviewer.showResolved', false);

  const showResolvedCommand = vscode.commands.registerCommand('githubReviewer.showResolved', () => {
    reviewProvider.showResolved = true;
    reviewProvider.refresh();
    void vscode.commands.executeCommand('setContext', 'githubReviewer.showResolved', true);
  });

  const hideResolvedCommand = vscode.commands.registerCommand('githubReviewer.hideResolved', () => {
    reviewProvider.showResolved = false;
    reviewProvider.refresh();
    void vscode.commands.executeCommand('setContext', 'githubReviewer.showResolved', false);
  });

  const openThreadCommand = vscode.commands.registerCommand(
    'githubReviewer.openThread',
    async (node: ThreadNode) => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const fileUri = vscode.Uri.file(`${workspaceRoot}/${node.thread.path}`);
      const line = node.thread.line != null ? node.thread.line - 1 : 0;
      try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, {
          selection: new vscode.Range(line, 0, line, 0),
          preserveFocus: false,
        });
        commentsCtrl.expandThread(node.thread.id);
      } catch {}
    },
  );

  const showInTreeViewCommand = vscode.commands.registerCommand(
    'githubReviewer.showInTreeView',
    async (uri?: vscode.Uri) => {
      const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!fileUri) {
        return;
      }

      const relPath = vscode.workspace.asRelativePath(fileUri, false);
      const fileNode = reviewProvider.findFileNode(relPath);
      if (fileNode) {
        await treeView.reveal(fileNode, { select: true, focus: true, expand: 1 });
        return;
      }

      void vscode.window.showInformationMessage(`${relPath} is not part of any open PR.`);
    },
  );

  const resolveCommand = vscode.commands.registerCommand(
    'githubReviewer.resolveThread',
    async (thread: vscode.CommentThread) => {
      try {
        if (!session) {
          return;
        }

        const threadId = commentsCtrl.getThreadId(thread);
        if (!threadId) {
          return;
        }

        await resolveThread(session.accessToken, threadId);
        await loadPRs({ forceReloadCurrentPR: true });
      } catch {}
    },
  );

  const replyCommand = vscode.commands.registerCommand(
    'githubReviewer.replyToThread',
    async (reply: vscode.CommentReply) => {
      try {
        if (!session) {
          return;
        }

        const threadId = commentsCtrl.getThreadId(reply.thread);

        if (!threadId) {
          const node = currentBranchNode();
          if (!node) {
            return;
          }

          const relPath = vscode.workspace.asRelativePath(reply.thread.uri, false);
          const line = (reply.thread.range?.end.line ?? 0) + 1;

          await createReviewComment(session.accessToken, node.pr.nodeId, relPath, line, reply.text);
          reply.thread.dispose();
          await loadPRs({ forceReloadCurrentPR: true });
          return;
        }

        await replyToThread(session.accessToken, threadId, reply.text);
        reply.thread.canReply = false;
        await loadPRs({ forceReloadCurrentPR: true });
      } catch {}
    },
  );

  const resolveNodeCommand = vscode.commands.registerCommand(
    'githubReviewer.resolveThreadNode',
    async (node: ThreadNode) => {
      try {
        if (!session) {
          return;
        }

        await resolveThread(session.accessToken, node.thread.id);
        const threadIndex = node.fileNode.threads.indexOf(node.thread);
        if (threadIndex >= 0) {
          node.fileNode.threads.splice(threadIndex, 1);
        }
        reviewProvider.refresh(node.fileNode);
        reviewProvider.setBadge(treeView);
        syncComments();
        loadPRs({ forceReloadCurrentPR: true }).catch(() => {});
      } catch {}
    },
  );

  const replyNodeCommand = vscode.commands.registerCommand(
    'githubReviewer.replyToThreadNode',
    async (node: ThreadNode) => {
      try {
        if (!session) {
          return;
        }

        const text = await vscode.window.showInputBox({
          prompt: `Reply to thread in ${node.fileNode.file.filename}`,
          placeHolder: 'Your reply...',
        });
        if (!text) {
          return;
        }

        await replyToThread(session.accessToken, node.thread.id, text);
        await loadPRs({ forceReloadCurrentPR: true });
      } catch {}
    },
  );

  const nextThreadCommand = vscode.commands.registerCommand('githubReviewer.nextThread', async () => {
    const nodes = reviewProvider.getAllThreadNodes();
    if (!nodes.length) {
      return;
    }

    const target = nodes[navIndex % nodes.length];
    navIndex = (navIndex + 1) % nodes.length;
    await navigateToThread(target.thread);
  });

  const prevThreadCommand = vscode.commands.registerCommand('githubReviewer.prevThread', async () => {
    const nodes = reviewProvider.getAllThreadNodes();
    if (!nodes.length) {
      return;
    }

    navIndex = (navIndex - 1 + nodes.length) % nodes.length;
    await navigateToThread(nodes[navIndex].thread);
  });

  context.subscriptions.push(
    treeView,
    commentsCtrl,
    reviewTreeSubscription,
    refreshCommand,
    showResolvedCommand,
    hideResolvedCommand,
    openThreadCommand,
    showInTreeViewCommand,
    resolveCommand,
    replyCommand,
    resolveNodeCommand,
    replyNodeCommand,
    nextThreadCommand,
    prevThreadCommand,
  );

  const gitExt = vscode.extensions.getExtension('vscode.git')?.exports as
    | GitExtensionApi
    | undefined;
  const gitApi = gitExt?.getAPI(1);
  if (gitApi?.repositories?.length) {
    const repo = gitApi.repositories[0];
    context.subscriptions.push(
      repo.state.onDidChange(() => {
        if (repo.state.HEAD?.name) {
          loadPRs({ forceReloadCurrentPR: true }).catch(() => {});
        }
      }),
    );
  }

  loadPRs().catch(() => {});
}

export function deactivate(): void {}
