# GitHub PR Reviewer - Functional Specification

## Overview
GitHub PR Reviewer is a VS Code extension that provides an ADO-style sidebar for viewing, navigating, and managing unresolved GitHub pull request review threads directly within the editor.

## Primary Functions

### 1. **Thread Discovery \u0026 Display**
- Auto-detects open PR for current branch by querying GitHub API
- Fetches up to 100 unresolved review threads per PR (GraphQL API)
- Displays threads grouped by folder and file in SCM sidebar
- Shows thread count badge on extension icon
- Supports "Show Resolved Threads" toggle

### 2. **Navigation**
- Click any thread \u2192 jumps to that line in the local file
- Thread anchors use best available location (startLine, endLine, originalLine)
- Handles deleted/renamed files with GitHub link fallback
- Provides "Next Unresolved Thread" and "Previous Unresolved Thread" navigation
- "Show in GitHub Reviewer" command jumps to current file in tree view

### 3. **Thread Interaction**
- **Reply**: Inline reply box for each thread (bypasses GitHub PR extension)
- **Resolve**: \u2713 button resolves threads locally and updates GitHub
- Context menus for right-click actions (reply, resolve, open original)
- Real-time sync of local changes with GitHub state

### 4. **File Handling**
- Remote file display when workspace doesn't contain the PR version
- File change detection via `setChangedFiles()` for commenting eligibility
- Multi-ref candidate support (current branch, base branch, anchored commit)
- Smart fallback to GitHub when local file not found

## User Experience Features

### 1. **Auto-Detection**
- Detects PR for current branch automatically
- Re-detects on branch switches (via Git API)
- Handles unauthenticated state gracefully

### 2. **Visual Indicators**
- Badge showing unresolved thread count
- \u26a0 indicator for outdated threads (from superseded commits)
- Thread context in editor gutter (when GitHub PRs extension not active)
- Tree view with file structure and thread counts

### 3. **Commands & Shortcuts**
```
githubReviewer.refresh                     // Reload all data
githubReviewer.nextThread                  // Navigate to next unresolved thread
githubReviewer.prevThread                  // Navigate to previous unresolved thread
showInTreeView (file context menu)        // Jump to current file in tree view
resolveThread (inline + right-click)       // Mark thread as resolved
replyToThread (inline + right-click)       // Reply to thread
openOriginalComment                       // Open GitHub comment directly
expand/collapsePullRequest                 // Tree view control
showResolved/hideResolved                  // Toggle resolved threads display
```

## Technical Architecture

### 1. **Layered Architecture**
```
VS Code Integration Layer → Data Management Layer → External APIs
❯ CommentsController (inline comments)
❯ ReviewTreeProvider (tree structure)
❯ GitHub API Client (github.ts)
     ← GraphQL mutations (resolve, reply, create)
     ← REST endpoints (files, PRs)
```

### 2. **Core Data Structures**
- `ReviewThread`: Thread data model with comments, state, metadata
- `PRSummary`: Pull request summary for tree navigation
- Tree nodes: PR \u2192 Folder \u2192 File \u2192 Thread \u2192 Comment hierarchy

### 3. **Authentication & Security**
- Uses VS Code's built-in GitHub authentication
- No manual token setup required
- Secure session management with expiration

## Integration Points

### VS Code APIs Utilized:
- `vscode.comments.createCommentController` - Inline comment system
- `vscode.window.createTreeView` - Hierarchical display
- `vscode.authentication.getSession` - GitHub authentication
- `vscode.workspace.registerTextDocumentContentProvider` - Remote file viewer
- Command registration and context menus
- Extension activation events

## Performance Characteristics

### 1. **API Limits**
- Fetches up to 100 review threads per PR (ponytail approach)
- Pagination ready for future enhancement
- Efficient caching of thread data in memory

### 2. **Memory Management**
- Lazy loading of PR data (load on expand)
- Garbage collection of disposed VS Code elements
- Reference tracking for thread \u2192 comment relationships

## Error Handling & Resilience

### 1. **API Failures**
- Graceful degradation when GitHub API unavailable
- User feedback with actionable error messages
- Local state preservation during network issues

### 2. **Data Issues**
- Handles missing files, deleted branches, renamed paths
- Validates thread anchors before navigation attempts
- Continues operation with partial data when possible

## Testing Considerations (Future Enhancement)

Current Implementation Status:
- [X] Core thread discovery and display functionality implemented
- [X] Inline comment system integration complete  
- [X] Thread resolution and reply operations working
- [X] Navigation between threads operational
- [ ] Comprehensive test suite needed
- [ ] Performance testing for large PRs
- [ ] Error recovery validation tests

## Roadmap & Future Enhancements

### 1. **Immediate Enhancements**
- Add comprehensive error logging and reporting
- Implement thread filtering (by author, file path)
- Add keyboard navigation shortcuts
- Create settings panel for customization

### 2. **Advanced Features**
- Full GitHub Enterprise support (when possible)
- Pagination for PRs with >100 threads
- Rich markdown formatting in comments
- Thread linking and cross-referencing
- Batch operations (resolve multiple threads)

## Accessibility & Internationalization

The extension supports:
- Keyboard-only navigation throughout the UI
- Screen reader compatibility for VS Code's accessibility APIs
- Standard text encoding (UTF-8) for comment content
- Proper localization-ready architecture

## Dependencies & Requirements

### Required:
- VS Code 1.85+
- GitHub account (authentication via VS Code)
- Workspace at root of git repo with origin pointing to github.com
- Open PR for current branch

### Optional Enhancements:
- Additional authentication providers
- External editor support beyond VS Code
- Integration with other GitHub tools and services