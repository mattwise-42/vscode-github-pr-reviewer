import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  createReviewComment,
  fetchFileContent,
  fetchOpenPRs,
  fetchPRFiles,
  fetchReviewThreads,
  getReviewCommentVersion,
  getReviewThreadAnchor,
  getReviewThreadRefCandidates,
  GitHubRepo,
  parseGitHubRemote,
  PRSummary,
  ReviewComment,
  ReviewThread,
  replyToThread,
  resolveThread,
} from './github';
import {
  CommentNode,
  FileNode,
  FolderNode,
  PRNode,
  OpenCommentNode,
  OpenCommentsProvider,
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

interface ActiveCommentDiff {
  threadId: string;
  thread: ReviewThread;
  comment: ReviewComment;
  commentUri: vscode.Uri;
  currentUri: vscode.Uri;
  sideBySide: boolean;
}

async function getGitHubSession(
  options: { silent?: boolean; createIfNone?: boolean },
): Promise<vscode.AuthenticationSession | undefined> {
  const testToken = process.env.GITHUB_REVIEWER_TEST_TOKEN;
  if (testToken) {
    return {
      id: 'github-reviewer-test',
      accessToken: testToken,
      account: {
        id: 'github-reviewer-test',
        label: 'GitHub Reviewer Test',
      },
      scopes: ['repo'],
    };
  }

  try {
    return await vscode.authentication.getSession('github', ['repo'], options);
  } catch {
    return undefined;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('GitHub PR Reviewer');
  context.subscriptions.push(output);
  const log = (message: string): void => {
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
  };
  const logError = (message: string, error: unknown): void => {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    log(`${message}: ${detail}`);
    output.show(true);
  };

  log('Activating extension');
  log(`GitHub API base URL: ${process.env.GITHUB_REVIEWER_API_URL ?? 'https://api.github.com'}`);
  if (!vscode.workspace.workspaceFolders && process.env.GITHUB_REVIEWER_DEV_WORKSPACE) {
    log(`Using development workspace fallback: ${process.env.GITHUB_REVIEWER_DEV_WORKSPACE}`);
  }
  let session = await getGitHubSession({ silent: true });
  log(session ? 'GitHub session available' : 'No GitHub session available');
  let currentRepo: GitHubRepo | null = null;
  let currentBranch: string | null = null;
  let navIndex = 0;
  let selectedPRNode: PRNode | undefined;
  let activeCommentDiff: ActiveCommentDiff | undefined;

  const reviewProvider = new ReviewTreeProvider();
  const treeView = vscode.window.createTreeView<ReviewTreeNode>('githubReviewer.reviewView', {
    treeDataProvider: reviewProvider,
  });
  const openCommentsProvider = new OpenCommentsProvider();
  const openCommentsView = vscode.window.createTreeView('githubReviewer.openCommentsView', {
    treeDataProvider: openCommentsProvider,
  });
  const commentsCtrl = new CommentsController();
  const remoteFileContents = new Map<string, string>();

  const remoteFileProvider = vscode.workspace.registerTextDocumentContentProvider(
    'github-reviewer-remote',
    {
      provideTextDocumentContent(uri: vscode.Uri): string {
        return remoteFileContents.get(uri.toString()) ?? '';
      },
    },
  );

  function getOriginalCommentUrl(target: ThreadNode | CommentNode | vscode.CommentThread): string | undefined {
    if (target instanceof ThreadNode) {
      return target.thread.comments[0]?.url;
    }
    if (target instanceof CommentNode) {
      return target.comment.url;
    }
    return commentsCtrl.getThreadUrl(target);
  }

  function workspaceRootPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      ?? process.env.GITHUB_REVIEWER_DEV_WORKSPACE;
  }

  function workspaceFileUri(relPath: string): vscode.Uri | undefined {
    const root = workspaceRootPath();
    return root ? vscode.Uri.file(`${root}/${relPath}`) : undefined;
  }

  function remoteFileUri(relPath: string, ref: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: 'github-reviewer-remote',
      path: `/${relPath}`,
      query: `ref=${encodeURIComponent(ref)}`,
    });
  }

  async function openRemoteFile(
    relPath: string,
    candidates: Array<{ ref: string; startLine: number | null; endLine: number | null }>,
  ): Promise<vscode.TextEditor | undefined> {
    if (!session || !currentRepo) {
      return undefined;
    }

    for (const candidate of candidates) {
      const uri = await fetchRemoteFileUri(relPath, candidate.ref);
      if (!uri) {
        continue;
      }

      const doc = await vscode.workspace.openTextDocument(uri);
      const startLine = candidate.startLine != null ? Math.max(0, candidate.startLine - 1) : 0;
      const endLine = candidate.endLine != null ? Math.max(0, candidate.endLine - 1) : startLine;
      const editor = await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(startLine, 0, endLine, 0),
        preserveFocus: false,
      });
      editor.revealRange(
        new vscode.Range(startLine, 0, endLine, 0),
        vscode.TextEditorRevealType.InCenter,
      );
      return editor;
    }

    return undefined;
  }

  async function fetchRemoteFileUri(relPath: string, ref: string): Promise<vscode.Uri | undefined> {
    if (!session || !currentRepo) {
      return undefined;
    }

    const content = await fetchFileContent(session.accessToken, currentRepo, ref, relPath);
    if (content == null) {
      return undefined;
    }

    const uri = remoteFileUri(relPath, ref);
    remoteFileContents.set(uri.toString(), content);
    return uri;
  }

  async function openCommentDiff(
    target: ThreadNode | CommentNode | OpenCommentNode | vscode.CommentThread,
  ): Promise<vscode.Uri | undefined> {
    const diffTarget = getCommentDiffTarget(target);
    if (!diffTarget) {
      return undefined;
    }

    if (!session || !currentRepo) {
      return undefined;
    }

    const commentRef = getReviewCommentVersion(diffTarget.comment);
    if (!commentRef) {
      return undefined;
    }

    const currentRef = diffTarget.pr.headSha ?? diffTarget.pr.headRefName;
    const [commentUri, currentUri] = await Promise.all([
      fetchRemoteFileUri(diffTarget.thread.path, commentRef),
      fetchRemoteFileUri(diffTarget.thread.path, currentRef),
    ]);
    if (!commentUri || !currentUri) {
      return undefined;
    }

    const originalAnchor = getReviewThreadAnchor(diffTarget.thread, { preferOriginal: true });
    const commentPreview = diffTarget.comment.body.split('\n')[0].slice(0, 80);
    const commentLine = originalAnchor.endLine != null
      ? ` (comment at line ${originalAnchor.endLine}${commentPreview ? `: ${commentPreview}` : ''})`
      : '';
    activeCommentDiff = {
      threadId: diffTarget.thread.id,
      thread: diffTarget.thread,
      comment: diffTarget.comment,
      commentUri,
      currentUri,
      sideBySide: true,
    };
    void vscode.commands.executeCommand('setContext', 'githubReviewer.commentDiffActive', true);
    commentsCtrl.showThread(diffTarget.thread.id, commentUri, { preferOriginal: true });
    await vscode.commands.executeCommand(
      'vscode.diff',
      commentUri,
      currentUri,
      `${diffTarget.thread.path}: ${commentRef.slice(0, 7)} -> ${currentRef.slice(0, 7)}${commentLine}`,
      {
        preserveFocus: false,
        preview: false,
        ...(originalAnchor.startLine != null && originalAnchor.endLine != null
          ? {
              selection: new vscode.Range(
                Math.max(0, originalAnchor.startLine - 1),
                0,
                Math.max(0, originalAnchor.endLine - 1),
                0,
              ),
            }
          : {}),
      },
    );
    return commentUri;
  }

  function getCommentDiffTarget(
    target: ThreadNode | CommentNode | OpenCommentNode | vscode.CommentThread,
  ): { thread: ReviewThread; comment: ReviewComment; pr: PRSummary } | undefined {
    if (target instanceof ThreadNode) {
      const comment = target.thread.comments.find((entry) => getReviewCommentVersion(entry))
        ?? target.thread.comments[0];
      return comment ? { thread: target.thread, comment, pr: target.fileNode.prNode.pr } : undefined;
    }
    if (target instanceof CommentNode) {
      const comment = getReviewCommentVersion(target.comment)
        ? target.comment
        : target.threadNode.thread.comments.find((entry) => getReviewCommentVersion(entry))
          ?? target.comment;
      return {
        thread: target.threadNode.thread,
        comment,
        pr: target.threadNode.fileNode.prNode.pr,
      };
    }
    if (target instanceof OpenCommentNode) {
      const comment = getReviewCommentVersion(target.comment)
        ? target.comment
        : target.thread.comments.find((entry) => getReviewCommentVersion(entry))
          ?? target.comment;
      return { thread: target.thread, comment, pr: target.pr };
    }

    const thread = commentsCtrl.getReviewThread(target);
    const pr = selectedPRNode?.pr ?? currentBranchNode()?.pr;
    const comment = thread?.comments.find((entry) => getReviewCommentVersion(entry))
      ?? thread?.comments[0];
    return thread && pr && comment ? { thread, comment, pr } : undefined;
  }

  async function openWorkspaceFile(
    relPath: string,
    options: {
      anchor?: { startLine: number | null; endLine: number | null };
      preserveFocus?: boolean;
      missingMessage: string;
      fallbackUrl?: string;
      remoteCandidates?: Array<{ ref: string; startLine: number | null; endLine: number | null }>;
    },
  ): Promise<vscode.TextEditor | undefined> {
    const fileUri = workspaceFileUri(relPath);
    if (!fileUri) {
      return undefined;
    }

    try {
      await vscode.workspace.fs.stat(fileUri);
    } catch {
      if (options.remoteCandidates?.length) {
        const remoteEditor = await openRemoteFile(relPath, options.remoteCandidates);
        if (remoteEditor) {
          return remoteEditor;
        }
      }

      const action = options.fallbackUrl
        ? await vscode.window.showWarningMessage(options.missingMessage, 'Open on GitHub')
        : undefined;
      if (action === 'Open on GitHub' && options.fallbackUrl) {
        await vscode.env.openExternal(vscode.Uri.parse(options.fallbackUrl));
      }
      return undefined;
    }

    const startLine = options.anchor?.startLine != null ? Math.max(0, options.anchor.startLine - 1) : 0;
    const endLine = options.anchor?.endLine != null ? Math.max(0, options.anchor.endLine - 1) : startLine;
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(startLine, 0, endLine, 0),
      preserveFocus: options.preserveFocus,
    });
    editor.revealRange(
      new vscode.Range(startLine, 0, endLine, 0),
      vscode.TextEditorRevealType.InCenter,
    );
    return editor;
  }

  async function syncComments(): Promise<void> {
    const targetPR = selectedPRNode ?? currentBranchNode();
    const loadedNodes = targetPR?.loaded ? [targetPR] : [];
    const entries = loadedNodes.flatMap((node) =>
      node.fileNodes.flatMap((fileNode) =>
        fileNode.threads.map((thread) => ({ thread, pr: node.pr })),
      ),
    );
    const threads = entries
      .map(({ thread }) => thread)
      .filter((thread) => reviewProvider.showResolved || !thread.isResolved);
    const files = [...new Set(loadedNodes.flatMap((node) =>
      node.fileNodes.map((fileNode) => fileNode.file.filename),
    ))];
    openCommentsProvider.update(entries);
    commentsCtrl.setChangedFiles(files);
    await commentsCtrl.update(threads);
  }

  function currentBranchNode(): PRNode | undefined {
    return currentBranch
      ? reviewProvider.prNodes.find((node) => node.pr.headRefName === currentBranch)
      : undefined;
  }

  function updateSelectedPRContext(): void {
    const target = selectedPRNode ?? currentBranchNode();
    void vscode.commands.executeCommand('setContext', 'githubReviewer.hasSelectedPR', Boolean(target));
    void vscode.commands.executeCommand('setContext', 'githubReviewer.selectedPRExpanded', Boolean(target?.expanded));
  }

  function updateCommentDiffContext(editor?: vscode.TextEditor): void {
    const isCommentDiff = Boolean(
      editor
      && activeCommentDiff
      && [activeCommentDiff.commentUri, activeCommentDiff.currentUri]
        .some((uri) => uri.toString() === editor.document.uri.toString()),
    );
    void vscode.commands.executeCommand(
      'setContext',
      'githubReviewer.commentDiffActive',
      isCommentDiff,
    );
  }

  function getTargetPRNode(node?: PRNode): PRNode | undefined {
    return node ?? selectedPRNode ?? currentBranchNode();
  }

  async function reloadPRNode(prNode: PRNode): Promise<void> {
    prNode.loaded = false;
    prNode.fileNodes = [];
    await reviewProvider.loadPR(prNode);
    reviewProvider.refresh(prNode);
  }

  reviewProvider.setLoader(async (pr: PRSummary) => {
    if (!session || !currentRepo) {
      log(`Skipping pull request #${pr.number} load: no session or repository`);
      return { files: [], threads: [] };
    }

    try {
      const [files, threads] = await Promise.all([
        fetchPRFiles(session.accessToken, currentRepo, pr.number),
        fetchReviewThreads(session.accessToken, currentRepo, pr.number),
      ]);
      log(`Loaded pull request #${pr.number}: ${files.length} file(s), ${threads.length} thread(s)`);
      return { files, threads };
    } catch (error) {
      logError(`Failed to fetch data for pull request #${pr.number}`, error);
      throw error;
    }
  });

  const reviewTreeSubscription = reviewProvider.onDidChangeTreeData(() => {
    reviewProvider.setBadge(treeView);
    updateSelectedPRContext();
    void syncComments();
  });

  const treeSelectionSubscription = treeView.onDidChangeSelection((event) => {
    const selected = event.selection[0];
    selectedPRNode = selected instanceof PRNode
      ? selected
      : (selected instanceof FolderNode
        ? selected.prNode
        : (selected instanceof FileNode
          ? selected.prNode
          : (selected instanceof ThreadNode
            ? selected.fileNode.prNode
            : (selected instanceof CommentNode ? selected.threadNode.fileNode.prNode : undefined))));
    updateSelectedPRContext();
    void syncComments();
  });

  async function navigateToThread(node: ThreadNode): Promise<void> {
    await syncComments();
    try {
      const editor = await openWorkspaceFile(node.thread.path, {
        anchor: getReviewThreadAnchor(node.thread),
        preserveFocus: false,
        missingMessage: `${node.thread.path} was not found locally. This thread may be on a deleted or renamed file.`,
        fallbackUrl: node.thread.comments[0]?.url,
        remoteCandidates: getReviewThreadRefCandidates(node.thread, node.fileNode.prNode.pr),
      });
      if (editor) {
        commentsCtrl.showThread(node.thread.id, editor.document.uri);
      }
    } catch (error) {
      logError(`Failed to navigate to ${node.thread.path}`, error);
    }
  }

  async function loadPRs(options: { forceReloadCurrentPR?: boolean } = {}): Promise<void> {
    log(`Loading pull requests${options.forceReloadCurrentPR ? ' (forced)' : ''}`);
    if (!session) {
      session = await getGitHubSession({ silent: true });
    }
    if (!session) {
      currentRepo = null;
      currentBranch = null;
      navIndex = 0;
      reviewProvider.updatePRs([]);
      openCommentsProvider.update([]);
      await commentsCtrl.update([]);
      commentsCtrl.setChangedFiles([]);
      log('Skipping pull request load: no GitHub session');
      return;
    }

    const cwd = workspaceRootPath();
    if (!cwd) {
      currentRepo = null;
      currentBranch = null;
      navIndex = 0;
      reviewProvider.updatePRs([]);
      openCommentsProvider.update([]);
      await commentsCtrl.update([]);
      commentsCtrl.setChangedFiles([]);
      log('Skipping pull request load: no workspace folder');
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
      log(`Detected repository ${remoteOut.trim()} on branch ${branch ?? '(detached)'}`);
    } catch (error) {
      repo = null;
      branch = null;
      logError(`Git repository detection failed in ${cwd}`, error);
    }

    if (!repo) {
      currentRepo = null;
      currentBranch = null;
      navIndex = 0;
      reviewProvider.updatePRs([]);
      openCommentsProvider.update([]);
      await commentsCtrl.update([]);
      commentsCtrl.setChangedFiles([]);
      log('Skipping pull request load: no GitHub repository remote was detected');
      return;
    }

    const previousBranch = currentBranch;
    currentRepo = repo;
    currentBranch = branch;
    if (previousBranch && previousBranch !== branch) {
      selectedPRNode = undefined;
    }

    log(`Fetching open pull requests for ${repo.owner}/${repo.repo}`);
    const prs = await fetchOpenPRs(session.accessToken, repo);
    reviewProvider.updatePRs(prs);
    log(`Received ${prs.length} open pull request(s)`);

    const matchingPR = currentBranchNode();
    log(
      matchingPR
        ? `Matched pull request #${matchingPR.pr.number} to branch ${currentBranch}`
        : `No pull request matches branch ${currentBranch ?? '(detached)'}`,
    );
    if (matchingPR && options.forceReloadCurrentPR) {
      matchingPR.loaded = false;
      matchingPR.fileNodes = [];
    }

    navIndex = 0;
    reviewProvider.setBadge(treeView);
    await syncComments();

    if (matchingPR) {
      try {
        await reviewProvider.loadPR(matchingPR);
        await treeView.reveal(matchingPR, { expand: true, focus: false, select: false });
      } catch (error) {
        logError(`Failed to load pull request #${matchingPR.number}`, error);
      }
      reviewProvider.setBadge(treeView);
      await syncComments();
    }
  }

  const refreshCommand = vscode.commands.registerCommand('githubReviewer.refresh', async () => {
    try {
      if (!session) {
        session = await getGitHubSession({ createIfNone: true });
      }

      await loadPRs({ forceReloadCurrentPR: true });
    } catch (error) {
      logError('Refresh failed', error);
      const message =
        error instanceof Error ? error.message : 'Unable to refresh GitHub review threads.';
      void vscode.window.showErrorMessage(message);
    }
  });

  void vscode.commands.executeCommand('setContext', 'githubReviewer.showResolved', false);
  void vscode.commands.executeCommand('setContext', 'githubReviewer.hasSelectedPR', false);
  void vscode.commands.executeCommand('setContext', 'githubReviewer.selectedPRExpanded', false);
  void vscode.commands.executeCommand('setContext', 'githubReviewer.commentDiffActive', false);

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
    async (node: ThreadNode | OpenCommentNode) => {
      try {
        await syncComments();
        const pr = node instanceof OpenCommentNode ? node.pr : node.fileNode.prNode.pr;
        let diffOpened = false;
        try {
          diffOpened = Boolean(await openCommentDiff(node));
        } catch (error) {
          logError('Failed to open default comment diff', error);
        }
        if (diffOpened) {
          return;
        }

        const editor = await openWorkspaceFile(node.thread.path, {
          anchor: getReviewThreadAnchor(node.thread),
          preserveFocus: false,
          missingMessage: `${node.thread.path} was not found locally. This thread may be on a deleted or renamed file.`,
          fallbackUrl: node.thread.comments[0]?.url,
          remoteCandidates: getReviewThreadRefCandidates(node.thread, pr),
        });
        if (editor) {
          commentsCtrl.showThread(node.thread.id, editor.document.uri);
        }
      } catch {}
    },
  );

  const openFileCommand = vscode.commands.registerCommand(
    'githubReviewer.openFile',
    async (node: FileNode) => {
      try {
        await openWorkspaceFile(node.file.filename, {
          preserveFocus: false,
          missingMessage: `${node.file.filename} was not found locally. This file may have been deleted or renamed in the PR.`,
          remoteCandidates: [
            { ref: node.prNode.pr.headRefName, startLine: null, endLine: null },
            { ref: node.prNode.pr.baseRefName, startLine: null, endLine: null },
          ],
        });
      } catch {}
    },
  );

  const openOriginalCommentCommand = vscode.commands.registerCommand(
    'githubReviewer.openOriginalComment',
    async (target: ThreadNode | CommentNode | vscode.CommentThread) => {
      const url = getOriginalCommentUrl(target);
      if (!url) {
        void vscode.window.showInformationMessage('No GitHub comment URL is available for this thread.');
        return;
      }

      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
  );

  const toggleCommentDiffCommand = vscode.commands.registerCommand(
    'githubReviewer.toggleCommentDiffView',
    async () => {
      if (!activeCommentDiff) {
        return;
      }

      try {
        await vscode.commands.executeCommand('toggle.diff.renderSideBySide');
        activeCommentDiff.sideBySide = !activeCommentDiff.sideBySide;
        commentsCtrl.showThread(
          activeCommentDiff.threadId,
          activeCommentDiff.sideBySide
            ? activeCommentDiff.commentUri
            :             activeCommentDiff.currentUri,
            { preferOriginal: activeCommentDiff.sideBySide },
        );
      } catch (error) {
        logError('Failed to toggle the comment diff layout', error);
        const message = error instanceof Error ? error.message : 'Unable to toggle the comment diff layout.';
        void vscode.window.showErrorMessage(message);
      }
    },
  );

  const activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
    updateCommentDiffContext(editor);
  });

  const expandPRCommand = vscode.commands.registerCommand(
    'githubReviewer.expandPullRequest',
    async (node?: PRNode) => {
      const target = getTargetPRNode(node);
      if (!target) {
        return;
      }

      try {
        await reviewProvider.loadPR(target);
        reviewProvider.setPRExpanded(target, true);
        selectedPRNode = target;
        updateSelectedPRContext();
        reviewProvider.refresh(target);
        await treeView.reveal(target, { select: true, focus: true, expand: 99 });
      } catch {}
    },
  );

  const collapsePRCommand = vscode.commands.registerCommand(
    'githubReviewer.collapsePullRequest',
    async (node?: PRNode) => {
      const target = getTargetPRNode(node);
      if (!target) {
        return;
      }

      reviewProvider.setPRExpanded(target, false);
      selectedPRNode = target;
      updateSelectedPRContext();
      reviewProvider.refresh(target);
      try {
        await treeView.reveal(target, { select: true, focus: true });
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
        const prNode = reviewProvider.markThreadResolved(threadId);
        reviewProvider.refresh(prNode);
        reviewProvider.setBadge(treeView);
        await syncComments();

        if (prNode) {
          reloadPRNode(prNode).catch(() => {});
        } else {
          loadPRs({ forceReloadCurrentPR: true }).catch(() => {});
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to resolve GitHub review thread.';
        void vscode.window.showErrorMessage(message);
      }
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

  const nextThreadCommand = vscode.commands.registerCommand('githubReviewer.nextThread', async () => {
    const nodes = reviewProvider.getAllThreadNodes();
    if (!nodes.length) {
      return;
    }

    const target = nodes[navIndex % nodes.length];
    navIndex = (navIndex + 1) % nodes.length;
    await navigateToThread(target);
  });

  const prevThreadCommand = vscode.commands.registerCommand('githubReviewer.prevThread', async () => {
    const nodes = reviewProvider.getAllThreadNodes();
    if (!nodes.length) {
      return;
    }

    navIndex = (navIndex - 1 + nodes.length) % nodes.length;
    await navigateToThread(nodes[navIndex]);
  });

  context.subscriptions.push(
    treeView,
    openCommentsView,
    commentsCtrl,
    remoteFileProvider,
    reviewTreeSubscription,
    treeSelectionSubscription,
    refreshCommand,
    showResolvedCommand,
    hideResolvedCommand,
    openThreadCommand,
    openFileCommand,
    openOriginalCommentCommand,
    toggleCommentDiffCommand,
    activeEditorSubscription,
    expandPRCommand,
    collapsePRCommand,
    showInTreeViewCommand,
    resolveCommand,
    replyCommand,
    nextThreadCommand,
    prevThreadCommand,
  );

  const gitExt = vscode.extensions.getExtension<GitExtensionApi>('vscode.git');
  log(gitExt ? `Git extension found (active: ${gitExt.isActive})` : 'Git extension not found');
  const gitApi = gitExt ? (await gitExt.activate()).getAPI(1) : undefined;
  log(gitApi ? `Git API activated (${gitApi.repositories.length} repository(s))` : 'Git API unavailable');
  if (gitApi?.repositories?.length) {
    const repo = gitApi.repositories[0];
    context.subscriptions.push(
      repo.state.onDidChange(() => {
        if (repo.state.HEAD?.name) {
          loadPRs({ forceReloadCurrentPR: true }).catch((error) => {
            logError('Branch-change reload failed', error);
          });
        }
      }),
    );
  }

  loadPRs().catch((error) => {
    logError('Initial pull request load failed', error);
  });
}

export function deactivate(): void {}
