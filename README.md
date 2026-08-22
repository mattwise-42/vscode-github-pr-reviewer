# GitHub PR Reviewer - VS Code Extension

<p align="center"><img src="resources/icon.png" alt="GitHub PR Reviewer logo" width="160"></p>

ADO-style unresolved PR review thread sidebar for VS Code. See every open review comment, navigate to the code, reply, and resolve — without leaving your editor.

## What it does

- **Sidebar panel** in the SCM view lists all unresolved review threads for the current branch's open PR, grouped by folder and file
- **Open Comments** view shows all comments from unresolved threads in a flat list
- **Click a thread** to open a diff from the comment version to the current PR head and mark the original line
- **Comment diff layout** can be toggled between side-by-side and inline from the diff editor's top-right action
- **Inline diffs** keep the comment preview in the diff title
- **Comment diffs** compare the code version where a comment was left with the current PR head
- **Inline comment threads** appear in the gutter (skipped automatically if the GitHub Pull Requests extension is already showing them)
- **Reply** from the inline thread's built-in reply box
- Tree-view comments open the historical diff; replies remain available in the inline thread
- **Resolve** with the ✓ button on each thread title
- **Badge** on the sidebar icon shows the unresolved thread count
- **Show in GitHub PR Reviewer** jumps from the Explorer or editor tab to the current file in the review tree
- Auto-detects the PR for your current branch; re-detects when you switch branches

## Requirements

- VS Code 1.85+
- A GitHub account (uses VS Code's built-in GitHub authentication — no token setup needed)
- A workspace open at the root of a git repo with `origin` pointing to github.com
- An open PR for the current branch

## Install the latest release from GitHub

On macOS or Linux, make sure the VS Code CLI (`code`) and `curl` are available in your `PATH`, then run:

```bash
curl -fsSL https://raw.githubusercontent.com/mattwise-42/vscode-github-pr-reviewer/main/install-latest.sh | bash
```

The installer finds the latest [GitHub release](https://github.com/mattwise-42/vscode-github-pr-reviewer/releases/latest), downloads its VSIX to a temporary directory, installs it, and removes the temporary file.

To install a downloaded VSIX manually, use the VS Code UI: **Extensions -> ... -> Install from VSIX...**

## Build and install a VSIX locally

```bash
# 1. Build the VSIX package
cd /path/to/GitHubReviewer
npm install
npm run package
# -> produces github-pr-reviewer-<version>.vsix

# 2. Install it in VS Code
code --install-extension github-pr-reviewer-<version>.vsix
```

Or install the local file from the VS Code UI: **Extensions -> ... -> Install from VSIX...**

## Install for development (F5)

```bash
cd /path/to/GitHubReviewer
npm install
npm run build
```

Then press **F5** in VS Code to open an Extension Development Host with the extension loaded.

For diagnostics, open **View → Output** and select **GitHub PR Reviewer**.

## Test

Run the unit tests:

```bash
npm test
```

Run the Playwright end-to-end tests:

```bash
npm run test:e2e
```

The end-to-end suite launches an isolated VS Code Extension Development Host and uses a local mock GitHub API. It does not need GitHub credentials or change the user's VS Code profile. Use `npm run test:e2e:headed` to keep the test window visible.

## Usage

1. Open a repo folder in VS Code that has an open PR on GitHub
2. The **PR Review Threads** panel appears in the SCM sidebar (Source Control view)
3. The extension auto-detects the PR for your current branch and loads unresolved threads
4. Click any thread in the sidebar to open the historical/current diff and locate the original comment line
5. Use the inline comment UI to **reply** or click **✓** to **resolve**
6. Use **Toggle Inline/Side-by-Side Diff** in the diff editor's top-right actions to change the layout
7. Hit the **↺ refresh** button in the panel header to reload (or switch branches to auto-reload)

If you're not signed into GitHub, the first **Refresh** will prompt you to authenticate via VS Code's built-in GitHub auth flow.

## Limitations

- github.com only (no GitHub Enterprise)
- Fetches up to 100 review threads per PR
- Read + reply + resolve only — creating new review threads requires the GitHub Pull Requests extension
- Outdated threads (from superseded commits) are shown with a ⚠ label but are otherwise treated the same
