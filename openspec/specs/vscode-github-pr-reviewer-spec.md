# OpenSpec: GitHub PR Reviewer Extension

## Overview
This OpenSpec captures the essential structure and design of the VS Code extension that provides an ADO-style unresolved PR review thread sidebar for GitHub. The extension brings JIRA's style comment management to GitHub Pull Requests within the editor workspace.

## Project Context
- **Repository**: mattwise-42/vscode-github-pr-reviewer
- **Type**: VS Code Extension (language: TypeScript)
- **Version**: 0.0.1 (early development)
- **Primary Purpose**: Consolidate unresolved PR review threads in SCM view for better developer workflow

## Current Architecture Analysis

### Core Files Structure
```
src/
├── extension.ts        # Main activation, command handlers, coordination
├── github.ts           # GitHub API integration (GraphQL queries/mutations)
├── review-tree.ts      # Tree node types and VS Code tree provider
└── comments.ts         # Inline comment controller and widget integration
```

### Key Components

#### 1. Data Models (github.ts)
- `ReviewThread`: Main thread representation with comments, metadata
- `ReviewComment`: Individual comment entity with author info
- `PRSummary`: Pull request metadata for identification
- GraphQL response types and transformation utilities

#### 2. Tree Structure (review-tree.ts) 
- **Node Types**: PRNode, FolderNode, FileNode, ThreadNode, CommentNode
- **Provider**: ReviewTreeProvider implementing VS Code tree data provider
- **Relationships**: Hierarchical organization by PR → Folder → File → Threads
- **Utilities**: buildFolderTree(), sortTreeItems(), flattenTreeItems()

#### 3. Comments System (comments.ts)
- **Controller**: CommentsController managing VS Code comment integration
- **Widgets**: Inline comment display with GitHub navigation
- **Sync**: Bidirectional sync between GitHub data and VS Code comments
- **Management**: Thread creation, updates, disposal

#### 4. Extension Host (extension.ts)
- **Activation**: Extension entry point and lifecycle management
- **Commands**: All user-facing actions (refresh, navigate, resolve, reply)
- **Context**: Branch/PR detection and state synchronization
- **Navigation**: File and thread jumping capabilities

### Integration Points with VS Code APIs

#### Comments API
```typescript
vscode.comments.createCommentController('github-pr-reviewer', 'GitHub Review Threads')
vscode.comments.registerCommentProvider('github-pr-reviewer', treeProvider)
```

#### Commands (via package.json)
- `githubReviewer.refresh`: Reload thread data
- `githubReviewer.showInTreeView`: Navigate to context item
- `githubReviewer.nextThread/prevThread`: Sequential navigation
- `githubReviewer.resolveThread` / `replyToThread`: Inline actions
- Additional navigation and expansion commands

#### SCM Integration
- **Panel**: Source Control view (SCM) for the review tree
- **Icon**: Badge showing unresolved thread count
- **Context**: PR-specific context in editor/title menus

### GitHub API Layer

#### Data Fetching Strategy
- **Primary**: GitHub GraphQL API for comprehensive thread data
- **GraphQL Queries**: Review threads, comments, file anchors
- **GraphQL Mutations**: Thread resolution and reply creation
- **REST Fallback**: If needed for edge cases

#### Error Handling & Recovery
- **Network Issues**: Graceful degradation with retry logic
- **Authentication**: VS Code built-in GitHub OAuth integration
- **Invalid PR Reference**: Clear error messages and recovery paths
- **Data Validation**: Type safety throughout transformation pipeline

### User Experience Flow

1. **Initial Load**: Auto-detects current branch's open PR, fetches threads
2. **Display**: Groups by directory structure in SCM sidebar
3. **Interaction**: Click → Navigate to file/line → Inline comment system
4. **Modification**: Reply via inline widget or ✓ button for resolution
5. **Navigation**: Context menu and keyboard shortcuts for efficient workflow
6. **Refresh**: Auto-updates on branch switch, manual refresh available

### Current Capabilities

✅ Thread Display: Unresolved threads grouped by file/folder structure
✅ Navigation: Click to jump to file/line in editor  
✅ Comment Interaction: Inline reply and resolution via ✓ button
✅ PR Detection: Automatic detection of current branch's PR
✅ Auto-refresh: Re-detects PR when switching branches
✅ Integration: Native VS Code comments UI with custom styling
✅ Context Menus: Right-click actions on threads and files
✅ Status Badge: Icon shows unresolved thread count

### Current Limitations / Known Issues

- **Repo Restriction**: GitHub.com only (no GitHub Enterprise)
- **Thread Creation**: Only replies/resolves via extension; creation requires GitHub PR browser
- **Capacity Limit**: Fetches up to 100 review threads per PR
- **Outdated Threads**: ⚠ Warning label for superseded commit threads
- **No Multi-PR Support**: Currently focused on single repository PR context

### Non-Functional Requirements

- **Performance**: <2s initial load, efficient virtual scrolling
- **Integration**: Native VS Code experience with familiar keyboard shortcuts
- **Scalability**: Handles typical repository sizes efficiently
- **Reliability**: Clear error states and recovery mechanisms
- **Security**: Respects VS Code authentication flows, minimal data storage

## Implementation Plan (Based on Spec)

### Phase 1: Foundation
- [ ] Core GitHub API integration with proper error handling
- [ ] Basic thread fetching and display in tree view
- [ ] File navigation functionality
- [ ] Thread resolution via native comment UI

### Phase 2: UX Enhancements
- [ ] Advanced tree structure (PR → Folder → File grouping)
- [ ] Search/filter capabilities across threads
- [ ] Keyboard navigation shortcuts
- [ ] Batch operations for multiple thread handling

### Phase 3: Advanced Features
- [ ] Improved auto-refresh and PR detection logic
- [ ] Settings customization options
- [ ] Performance optimizations and caching strategies
- [ ] Enhanced error recovery and user feedback

## Design Decisions Captured

This OpenSpec documents the architectural decisions made so far:
1. **API Strategy**: GraphQL-first approach for comprehensive thread data
2. **UI Integration**: Native VS Code comments for seamless experience
3. **Data Model**: Hierarchical tree structure matching developer mental models
4. **Auth Handling**: Delegation to VS Code's built-in GitHub authentication
5. **Refresh Strategy**: Auto-detection on branch switching, manual refresh option

## Open Questions / Next Steps

1. **Repository Scoping**: Should extension support multiple repositories simultaneously?
2. **Feature Gap Analysis**: Which GitHub PR Review extension features can be emulated?
3. **User Journey Mapping**: How does this tool fit in the complete review workflow?
4. **Performance Benchmarking**: What are realistic thread counts for typical use cases?
5. **Deployment Strategy**: VS Code Marketplace packaging and distribution

## Files and Responsibilities

- **github.ts**: API integration, data fetching, GraphQL operations
- **review-tree.ts**: Tree structure logic, VS Code tree provider implementation  
- **comments.ts**: Inline comment widget creation and management
- **extension.ts**: Coordination, command registration, lifecycle management

## Testing Considerations

Given the current maturity (v0.0.1), testing should focus on:
- API response error handling
- Navigation edge cases (file not found, invalid line numbers)
- Comment state synchronization between GitHub and VS Code
- Performance with realistic thread counts (>100 threads)
- Authentication flow scenarios

This OpenSpec captures the current architectural vision and provides a foundation for systematic implementation of the GitHub PR Reviewer extension.