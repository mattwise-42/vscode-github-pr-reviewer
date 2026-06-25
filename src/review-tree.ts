import * as vscode from 'vscode';
import type { PRFile, PRSummary, ReviewThread } from './github';

export type ReviewTreeNode = PRNode | FolderNode | FileNode | ThreadNode;

export class PRNode {
  loaded = false;
  fileNodes: FileNode[] = [];
  treeNodes: (FolderNode | FileNode)[] = [];
  visibleFileNodes: Map<string, FileNode> = new Map();

  constructor(public readonly pr: PRSummary) {}
}

export class FolderNode {
  children: (FolderNode | FileNode)[] = [];

  constructor(
    public readonly name: string,
    public readonly fullPath: string,
    public readonly prNode: PRNode,
    public readonly parent: PRNode | FolderNode,
  ) {}
}

export class FileNode {
  constructor(
    public readonly file: PRFile,
    public readonly prNode: PRNode,
    public readonly threads: ReviewThread[],
    public readonly parent: PRNode | FolderNode = prNode,
  ) {}
}

export class ThreadNode {
  constructor(
    public readonly thread: ReviewThread,
    public readonly fileNode: FileNode,
  ) {}
}

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewTreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ReviewTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _prNodes: PRNode[] = [];
  private loadPRData: ((pr: PRSummary) => Promise<{ files: PRFile[]; threads: ReviewThread[] }>) | null = null;
  showResolved = false;

  get prNodes(): readonly PRNode[] {
    return this._prNodes;
  }

  setLoader(fn: (pr: PRSummary) => Promise<{ files: PRFile[]; threads: ReviewThread[] }>): void {
    this.loadPRData = fn;
  }

  updatePRs(prs: PRSummary[]): void {
    const existingByNumber = new Map(this._prNodes.map((node) => [node.pr.number, node]));
    this._prNodes = prs.map((pr) => {
      const nextNode = new PRNode(pr);
      const existing = existingByNumber.get(pr.number);
      if (existing) {
        nextNode.loaded = existing.loaded;
        nextNode.fileNodes = existing.fileNodes.map((fileNode) => new FileNode(
          fileNode.file,
          nextNode,
          fileNode.threads,
        ));
      }
      return nextNode;
    });
    this._onDidChangeTreeData.fire();
  }

  refresh(node?: ReviewTreeNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  getTreeItem(element: ReviewTreeNode): vscode.TreeItem {
    if (element instanceof PRNode) {
      const item = new vscode.TreeItem(
        `#${element.pr.number}: ${element.pr.title}`,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.iconPath = new vscode.ThemeIcon(
        element.pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request',
      );
      item.contextValue = 'pr';
      item.id = `pr-${element.pr.number}`;
      return item;
    }

    if (element instanceof FileNode) {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const fileUri = vscode.Uri.file(`${workspaceRoot}/${element.file.filename}`);
      const item = new vscode.TreeItem(fileUri, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `+${element.file.additions} -${element.file.deletions}`;
      const unresolvedCount = element.threads.filter((thread) => !thread.isResolved).length;
      item.tooltip = unresolvedCount > 0
        ? `${element.file.filename} — ${unresolvedCount} unresolved`
        : element.file.filename;
      item.contextValue = 'file';
      item.command = {
        command: 'vscode.open',
        title: 'Open file',
        arguments: [fileUri],
      };
      return item;
    }

    if (element instanceof FolderNode) {
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('folder');
      item.id = `folder-${element.prNode.pr.number}-${element.fullPath}`;
      item.tooltip = element.fullPath;
      item.contextValue = 'folder';
      return item;
    }

    const firstComment = element.thread.comments[0];
    const preview = firstComment?.body.split('\n')[0].slice(0, 80) ?? '(no comment)';
    const author = firstComment?.author.login ?? 'unknown';
    const lineInfo = element.thread.line ? `:${element.thread.line}` : '';

    const item = new vscode.TreeItem(
      `${author}: ${preview}`,
      vscode.TreeItemCollapsibleState.None,
    );
    const isResolved = element.thread.isResolved;
    item.iconPath = new vscode.ThemeIcon(
      isResolved ? 'pass' : (element.thread.isOutdated ? 'comment-draft' : 'comment-unresolved'),
    );
    item.description = lineInfo;
    item.tooltip = new vscode.MarkdownString(
      `**${author}** on \`${element.fileNode.file.filename}${lineInfo}\`\n\n${firstComment?.body ?? ''}`,
    );
    item.contextValue = isResolved
      ? 'thread-resolved'
      : (element.thread.isOutdated ? 'thread-outdated' : 'thread-unresolved');
    item.id = `thread-${element.thread.id}`;
    item.command = {
      command: 'githubReviewer.openThread',
      title: 'Open thread',
      arguments: [element],
    };
    return item;
  }

  async getChildren(element?: ReviewTreeNode): Promise<ReviewTreeNode[]> {
    if (element === undefined) {
      return this._prNodes;
    }

    if (element instanceof PRNode) {
      if (!element.loaded && this.loadPRData) {
        try {
          const { files, threads } = await this.loadPRData(element.pr);
          element.fileNodes = files
            .sort((a, b) => a.filename.localeCompare(b.filename))
            .map((file) => new FileNode(
              file,
              element,
              threads
                .filter((thread) => thread.path === file.filename)
                .sort(compareThreads),
            ));
          element.treeNodes = [];
          element.visibleFileNodes.clear();
          element.loaded = true;
          this._onDidChangeTreeData.fire(element);
        } catch {
          element.treeNodes = [];
          element.visibleFileNodes.clear();
          element.loaded = true;
        }
      }
      return this.ensureTreeNodes(element);
    }

    if (element instanceof FolderNode) {
      return sortTreeItems(element.children);
    }

    if (element instanceof FileNode) {
      const visible = this.showResolved
        ? element.threads
        : element.threads.filter((thread) => !thread.isResolved);
      return [...visible]
        .sort(compareThreads)
        .map((thread) => new ThreadNode(thread, element));
    }

    return [];
  }

  getParent(element: ReviewTreeNode): ReviewTreeNode | undefined {
    if (element instanceof PRNode) {
      return undefined;
    }
    if (element instanceof FolderNode) {
      return element.parent;
    }
    if (element instanceof FileNode) {
      return element.parent;
    }
    if (element instanceof ThreadNode) {
      return element.fileNode;
    }
    return undefined;
  }

  unresolvedCount(prNode?: PRNode): number {
    const nodes = prNode ? [prNode] : this._prNodes;
    return nodes.reduce((sum, pr) =>
      sum + pr.fileNodes.reduce(
        (fileSum, file) => fileSum + file.threads.filter((thread) => !thread.isResolved).length,
        0,
      ), 0);
  }

  setBadge(treeView: vscode.TreeView<ReviewTreeNode>): void {
    const count = this.unresolvedCount();
    treeView.badge = count > 0
      ? { value: count, tooltip: `${count} unresolved thread${count === 1 ? '' : 's'}` }
      : undefined;
  }

  getAllThreadNodes(): ThreadNode[] {
    return this._prNodes.flatMap((pr) =>
      pr.fileNodes.flatMap((file) =>
        file.threads
          .filter((thread) => !thread.isResolved)
          .map((thread) => new ThreadNode(thread, file)),
      ),
    ).sort((left, right) => {
      const pathCmp = left.thread.path.localeCompare(right.thread.path);
      if (pathCmp !== 0) {
        return pathCmp;
      }
      const leftLine = left.thread.line ?? 0;
      const rightLine = right.thread.line ?? 0;
      return leftLine - rightLine;
    });
  }

  findFileNode(relPath: string): FileNode | undefined {
    for (const prNode of this._prNodes) {
      this.ensureTreeNodes(prNode);
      const visibleFileNode = prNode.visibleFileNodes.get(relPath);
      if (visibleFileNode) {
        return visibleFileNode;
      }

      for (const fileNode of prNode.fileNodes) {
        if (fileNode.file.filename === relPath) {
          return fileNode;
        }
      }
    }
    return undefined;
  }

  private ensureTreeNodes(prNode: PRNode): (FolderNode | FileNode)[] {
    if (prNode.fileNodes.length === 0) {
      prNode.treeNodes = [];
      prNode.visibleFileNodes.clear();
      return [];
    }

    if (prNode.treeNodes.length > 0) {
      return prNode.treeNodes;
    }

    prNode.treeNodes = buildFolderTree(prNode.fileNodes, prNode);
    prNode.visibleFileNodes.clear();
    for (const fileNode of flattenTreeItems(prNode.treeNodes)) {
      prNode.visibleFileNodes.set(fileNode.file.filename, fileNode);
    }
    return prNode.treeNodes;
  }
}

function compareThreads(left: ReviewThread, right: ReviewThread): number {
  const leftLine = left.line ?? 0;
  const rightLine = right.line ?? 0;
  if (leftLine !== rightLine) {
    return leftLine - rightLine;
  }
  return left.id.localeCompare(right.id);
}

function buildFolderTree(
  fileNodes: FileNode[],
  prNode: PRNode,
): (FolderNode | FileNode)[] {
  const root: (FolderNode | FileNode)[] = [];
  const folderMap = new Map<string, FolderNode>();

  for (const fileNode of fileNodes) {
    const parts = fileNode.file.filename.split('/');
    if (parts.length === 1) {
      root.push(fileNode);
      continue;
    }

    let currentChildren = root;
    let currentParent: PRNode | FolderNode = prNode;
    let currentPath = '';

    for (let i = 0; i < parts.length - 1; i += 1) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
      let folder = folderMap.get(currentPath);
      if (!folder) {
        folder = new FolderNode(parts[i], currentPath, prNode, currentParent);
        folderMap.set(currentPath, folder);
        currentChildren.push(folder);
      }
      currentParent = folder;
      currentChildren = folder.children;
    }

    currentChildren.push(new FileNode(fileNode.file, fileNode.prNode, fileNode.threads, currentParent));
  }

  return sortTreeItems(root);
}

function sortTreeItems(items: (FolderNode | FileNode)[]): (FolderNode | FileNode)[] {
  return items.sort((a, b) => {
    if (a instanceof FolderNode && b instanceof FileNode) {
      return -1;
    }
    if (a instanceof FileNode && b instanceof FolderNode) {
      return 1;
    }

    const aName = a instanceof FolderNode ? a.name : (a.file.filename.split('/').pop() ?? '');
    const bName = b instanceof FolderNode ? b.name : (b.file.filename.split('/').pop() ?? '');
    return aName.localeCompare(bName);
  });
}

function flattenTreeItems(items: (FolderNode | FileNode)[]): FileNode[] {
  return items.flatMap((item) =>
    item instanceof FolderNode ? flattenTreeItems(item.children) : [item]);
}
