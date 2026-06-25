import * as vscode from 'vscode';
import { ReviewThread } from './github';

export class CommentsController implements vscode.Disposable {
  private _ctrl: vscode.CommentController | undefined;
  private _enabled = false;
  private _threads: Map<string, vscode.CommentThread> = new Map();
  private _threadIdMap: Map<vscode.CommentThread, string> = new Map();
  private _changedFiles = new Set<string>();

  constructor() {
    if (vscode.extensions.getExtension('GitHub.vscode-pull-request-github')?.isActive) {
      return;
    }

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

  setChangedFiles(files: string[]): void {
    this._changedFiles = new Set(files);
  }

  expandThread(githubThreadId: string): void {
    const vsThread = this._threads.get(githubThreadId);
    if (vsThread) {
      vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  update(reviewThreads: ReviewThread[]): void {
    if (!this._enabled || !this._ctrl) {
      return;
    }

    for (const thread of this._threads.values()) {
      thread.dispose();
    }
    this._threads.clear();
    this._threadIdMap.clear();

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return;
    }

    for (const reviewThread of reviewThreads) {
      const fileUri = vscode.Uri.file(`${workspaceRoot}/${reviewThread.path}`);
      const line = reviewThread.line != null ? Math.max(0, reviewThread.line - 1) : 0;
      const range = new vscode.Range(line, 0, line, 0);

      const vsComments: vscode.Comment[] = reviewThread.comments.map((comment) => ({
        body: new vscode.MarkdownString(comment.body),
        mode: vscode.CommentMode.Preview,
        author: {
          name: comment.author.login,
          iconPath: comment.author.avatarUrl
            ? vscode.Uri.parse(comment.author.avatarUrl)
            : undefined,
        },
        timestamp: new Date(comment.createdAt),
      }));

      const vsThread = this._ctrl.createCommentThread(fileUri, range, vsComments);
      vsThread.label = reviewThread.isOutdated ? '⚠ Outdated thread' : undefined;
      vsThread.state = reviewThread.isResolved
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
      vsThread.canReply = reviewThread.viewerCanReply;
      vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      vsThread.contextValue = reviewThread.isResolved ? 'resolved' : 'unresolved';

      this._threads.set(reviewThread.id, vsThread);
      this._threadIdMap.set(vsThread, reviewThread.id);
    }
  }

  dispose(): void {
    for (const thread of this._threads.values()) {
      thread.dispose();
    }
    this._threads.clear();
    this._threadIdMap.clear();
    this._ctrl?.dispose();
  }
}
