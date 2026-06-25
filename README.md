# GitHub Reviewer

ADO-style unresolved PR review thread sidebar for VS Code. See every open review comment, navigate to the code, reply, and resolve — without leaving your editor.

## What it does

- **Sidebar panel** in the SCM view lists all unresolved review threads for the current branch's open PR, grouped by folder and file
- **Click a thread** to jump to that line in the file
- **Inline comment threads** appear in the gutter (skipped automatically if the GitHub Pull Requests extension is already showing them)
- **Reply** from the inline thread's built-in reply box
- **Resolve** with the ✓ button on each thread title
- **Badge** on the sidebar icon shows the unresolved thread count
- **Show in GitHub Reviewer** jumps from the Explorer or editor tab to the current file in the review tree
- Auto-detects the PR for your current branch; re-detects when you switch branches

## Requirements

- VS Code 1.85+
- A GitHub account (uses VS Code's built-in GitHub authentication — no token setup needed)
- A workspace open at the root of a git repo with `origin` pointing to github.com
- An open PR for the current branch

## Install from VSIX

```bash
# 1. Build the VSIX package
cd /path/to/GitHubReviewer
npm install
npm run package
# → produces github-reviewer-0.0.1.vsix

# 2. Install it in VS Code
code --install-extension github-reviewer-0.0.1.vsix
```

Or install via the VS Code UI: **Extensions → … → Install from VSIX…**

## Install for development (F5)

```bash
cd /path/to/GitHubReviewer
npm install
npm run build
```

Then press **F5** in VS Code to open an Extension Development Host with the extension loaded.

## Usage

1. Open a repo folder in VS Code that has an open PR on GitHub
2. The **PR Review Threads** panel appears in the SCM sidebar (Source Control view)
3. The extension auto-detects the PR for your current branch and loads unresolved threads
4. Click any thread in the sidebar to navigate to that file and line
5. Use the inline comment UI to **reply** or click **✓** to **resolve**
6. Hit the **↺ refresh** button in the panel header to reload (or switch branches to auto-reload)

If you're not signed into GitHub, the first **Refresh** will prompt you to authenticate via VS Code's built-in GitHub auth flow.

## Limitations

- github.com only (no GitHub Enterprise)
- Fetches up to 100 review threads per PR
- Read + reply + resolve only — creating new review threads requires the GitHub Pull Requests extension
- Outdated threads (from superseded commits) are shown with a ⚠ label but are otherwise treated the same
