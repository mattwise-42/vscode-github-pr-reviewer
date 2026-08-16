import * as vscode from 'vscode';
import { getReviewThreadAnchor, ReviewThread } from './github';

export class CommentsController implements vscode.Disposable {
  private _ctrl: vscode.CommentController | undefined;
  private _enabled = false;
  private _threads: Map<string, vscode.CommentThread> = new Map();
  private _threadIdMap: Map<vscode.CommentThread, string> = new Map();
  private _threadUrlMap: Map<vscode.CommentThread, string> = new Map();
  private _reviewThreads: Map<string, ReviewThread> = new Map();
  private _changedFiles = new Set<string>();
  private _updateGeneration = 0;

  constructor() {
    this._ctrl = vscode.comments.createCommentController(
      'github-reviewer',
      'GitHub Review Threads',
    );
    this._ctrl.options = { placeHolder: 'Reply to this review thread...' };
    this._ctrl.commentingRangeProvider = {
      provideCommentingRanges: (document: vscode.TextDocument): vscode.Range[] => {
        const relPath = vscode.workspace.asRelativePath(document.uri, false);
        if (!this._changedFiles.has(relPath)) {
          return [];
        }

        return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
      },
    };
    this._enabled = true;
  }

  isEnabled(): boolean {
    return this._enabled;
  }

  getThreadId(vsThread: vscode.CommentThread): string | undefined {
    return this._threadIdMap.get(vsThread);
  }

  getThreadUrl(vsThread: vscode.CommentThread): string | undefined {
    return this._threadUrlMap.get(vsThread);
  }

  setChangedFiles(files: string[]): void {
    this._changedFiles = new Set(files);
  }

  expandThread(githubThreadId: string): void {
    this.showThread(githubThreadId);
  }

  showThread(githubThreadId: string, uri?: vscode.Uri): void {
    const reviewThread = this._reviewThreads.get(githubThreadId);
    if (!reviewThread || !this._ctrl) {
      return;
    }

    const workspaceRoot = getWorkspaceRoot();
    const fallbackUri = workspaceRoot
      ? vscode.Uri.file(`${workspaceRoot}/${reviewThread.path}`)
      : undefined;
    const targetUri = uri ?? fallbackUri;
    if (!targetUri) {
      return;
    }

    let vsThread = this._threads.get(githubThreadId);
    if (!vsThread || serializeUri(vsThread.uri) !== serializeUri(targetUri)) {
      vsThread?.dispose();
      this._threadIdMap.delete(vsThread as vscode.CommentThread);
      this._threadUrlMap.delete(vsThread as vscode.CommentThread);
      vsThread = this.createThread(reviewThread, targetUri);
    }

    if (vsThread) {
      // Re-assigning the same range nudges VS Code to reveal the inline widget
      // after the editor opens, especially when the thread was created earlier.
      vsThread.range = new vscode.Range(
        vsThread.range.start.line,
        vsThread.range.start.character,
        vsThread.range.end.line,
        vsThread.range.end.character,
      );
      vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  async update(reviewThreads: ReviewThread[]): Promise<void> {
    if (!this._enabled || !this._ctrl) {
      return;
    }

    const updateGeneration = ++this._updateGeneration;
    for (const thread of this._threads.values()) {
      thread.dispose();
    }
    this._threads.clear();
    this._threadIdMap.clear();
    this._threadUrlMap.clear();
    this._reviewThreads.clear();

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    for (const reviewThread of reviewThreads) {
      this._reviewThreads.set(reviewThread.id, reviewThread);
      const fileUri = vscode.Uri.file(`${workspaceRoot}/${reviewThread.path}`);
      try {
        await vscode.workspace.fs.stat(fileUri);
      } catch {
        continue;
      }
      if (updateGeneration !== this._updateGeneration) {
        return;
      }
      this.createThread(reviewThread, fileUri);
    }
  }

  dispose(): void {
    this._updateGeneration += 1;
    for (const thread of this._threads.values()) {
      thread.dispose();
    }
    this._threads.clear();
    this._threadIdMap.clear();
    this._threadUrlMap.clear();
    this._reviewThreads.clear();
    this._ctrl?.dispose();
  }

  private createThread(reviewThread: ReviewThread, uri: vscode.Uri): vscode.CommentThread {
    if (!this._ctrl) {
      throw new Error('Comment controller is not initialized.');
    }

    const anchor = getReviewThreadAnchor(reviewThread);
    const startLine = anchor.startLine != null ? Math.max(0, anchor.startLine - 1) : 0;
    const endLine = anchor.endLine != null ? Math.max(0, anchor.endLine - 1) : startLine;
    const range = new vscode.Range(startLine, 0, endLine, 0);

    const vsComments: vscode.Comment[] = reviewThread.comments.map((comment) => ({
      body: createCommentBody(comment.body, comment.url),
      mode: vscode.CommentMode.Preview,
      author: {
        name: comment.author.login,
        iconPath: comment.author.avatarUrl
          ? vscode.Uri.parse(comment.author.avatarUrl)
          : undefined,
      },
      timestamp: new Date(comment.createdAt),
    }));

    const vsThread = this._ctrl.createCommentThread(uri, range, vsComments);
    vsThread.label = reviewThread.isOutdated ? '⚠ Outdated thread' : undefined;
    vsThread.state = reviewThread.isResolved
      ? vscode.CommentThreadState.Resolved
      : vscode.CommentThreadState.Unresolved;
    vsThread.canReply = reviewThread.viewerCanReply;
    vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    vsThread.contextValue = reviewThread.isResolved ? 'resolved' : 'unresolved';

    this._threads.set(reviewThread.id, vsThread);
    this._threadIdMap.set(vsThread, reviewThread.id);
    const firstCommentUrl = reviewThread.comments[0]?.url;
    if (firstCommentUrl) {
      this._threadUrlMap.set(vsThread, firstCommentUrl);
    }

    return vsThread;
  }
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    ?? process.env.GITHUB_REVIEWER_DEV_WORKSPACE;
}

function createCommentBody(body: string, url: string): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(`${body}\n\n[Open on GitHub](${url})`);
  markdown.isTrusted = false;
  return markdown;
}

function serializeUri(uri: vscode.Uri): string {
  if (typeof uri.toString === 'function' && uri.toString !== Object.prototype.toString) {
    return uri.toString();
  }

  if ('fsPath' in uri && typeof uri.fsPath === 'string') {
    return uri.fsPath;
  }

  return JSON.stringify(uri);
}
