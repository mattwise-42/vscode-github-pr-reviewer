export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: 'LEFT' | 'RIGHT';
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanResolve: boolean;
  viewerCanReply: boolean;
  comments: ReviewComment[];
}

export interface ReviewComment {
  id: string;
  body: string;
  author: { login: string; avatarUrl: string };
  createdAt: string;
  url: string;
  line?: number | null;
  startLine?: number | null;
  originalLine?: number | null;
  originalStartLine?: number | null;
  commitOid?: string | null;
  originalCommitOid?: string | null;
}

export interface ReviewThreadAnchor {
  startLine: number | null;
  endLine: number | null;
}

export interface ReviewThreadRefCandidate extends ReviewThreadAnchor {
  ref: string;
}

export interface PullRequestInfo {
  number: number;
  nodeId: string;
  title: string;
}

export interface PRSummary {
  number: number;
  nodeId: string;
  title: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
}

export interface GitHubRepo {
  owner: string;
  repo: string;
}

const GITHUB_API_BASE_URL = (process.env.GITHUB_REVIEWER_API_URL ?? 'https://api.github.com')
  .replace(/\/+$/, '');
const GITHUB_REST_API_URL = GITHUB_API_BASE_URL;
const GITHUB_GRAPHQL_API_URL = `${GITHUB_API_BASE_URL}/graphql`;

// ponytail: first 100 threads; add cursor pagination if this becomes a problem
const GET_PR_REVIEW_THREADS_QUERY = `
query GetPRReviewThreads($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          diffSide
          viewerCanResolve
          viewerCanReply
          comments(first: 100) {
            nodes {
              id
              body
              author { login avatarUrl }
              createdAt
              url
              line
              startLine
              originalLine
              originalStartLine
              commit { oid }
              originalCommit { oid }
            }
          }
        }
      }
    }
  }
}
`;

const RESOLVE_THREAD_MUTATION = `
mutation ResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}
`;

const REPLY_TO_THREAD_MUTATION = `
mutation ReplyToThread($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: $threadId,
    body: $body
  }) {
    comment {
      id
      body
      createdAt
      author { login avatarUrl }
      url
    }
  }
}
`;

const CREATE_REVIEW_COMMENT_MUTATION = `
mutation CreateComment($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) {
    pullRequestReview { id state }
  }
}
`;

interface GitHubApiError {
  message: string;
}

interface GitHubGraphQLResponse<T> {
  data?: T | null;
  errors?: GitHubApiError[];
}

interface RestPullRequest {
  number: number;
  node_id: string;
  title: string;
}

interface RestOpenPullRequest extends RestPullRequest {
  draft: boolean;
  head: {
    ref: string;
  };
  base: {
    ref: string;
  };
}

interface GraphQLAuthor {
  login: string | null;
  avatarUrl: string | null;
}

interface GraphQLCommentNode {
  id: string;
  body: string;
  author: GraphQLAuthor | null;
  createdAt: string;
  url: string;
  line?: number | null;
  startLine?: number | null;
  originalLine?: number | null;
  originalStartLine?: number | null;
  commit?: {
    oid: string;
  } | null;
  originalCommit?: {
    oid: string;
  } | null;
}

interface GraphQLThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: 'LEFT' | 'RIGHT' | null;
  viewerCanResolve: boolean;
  viewerCanReply: boolean;
  comments: {
    nodes: Array<GraphQLCommentNode | null> | null;
  };
}

interface ReviewThreadsQueryData {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<GraphQLThreadNode | null> | null;
      };
    } | null;
  } | null;
}

interface ResolveThreadMutationData {
  resolveReviewThread: {
    thread: {
      id: string;
      isResolved: boolean;
    } | null;
  } | null;
}

interface ReplyToThreadMutationData {
  addPullRequestReviewThreadReply: {
    comment: GraphQLCommentNode | null;
  } | null;
}

interface CreateReviewCommentMutationData {
  addPullRequestReview: {
    pullRequestReview: {
      id: string;
      state: string;
    } | null;
  } | null;
}

function createHeaders(token: string, includeJsonBody = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    ...(includeJsonBody ? { 'Content-Type': 'application/json' } : {}),
  };
}

function normalizeAuthor(author: GraphQLAuthor | null | undefined): ReviewComment['author'] {
  return {
    login: author?.login ?? 'ghost',
    avatarUrl: author?.avatarUrl ?? '',
  };
}

function normalizeDiffSide(diffSide: GraphQLThreadNode['diffSide']): ReviewThread['diffSide'] {
  return diffSide === 'LEFT' ? 'LEFT' : 'RIGHT';
}

function mapComment(comment: GraphQLCommentNode): ReviewComment {
  return {
    id: comment.id,
    body: comment.body,
    author: normalizeAuthor(comment.author),
    createdAt: comment.createdAt,
    url: comment.url,
    line: comment.line ?? null,
    startLine: comment.startLine ?? null,
    originalLine: comment.originalLine ?? null,
    originalStartLine: comment.originalStartLine ?? null,
    commitOid: comment.commit?.oid ?? null,
    originalCommitOid: comment.originalCommit?.oid ?? null,
  };
}

function firstNonNull(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (value != null) {
      return value;
    }
  }

  return null;
}

function getAnchoredComment(thread: ReviewThread): ReviewComment | undefined {
  return thread.comments.find((comment) =>
    comment.line != null
    || comment.startLine != null
    || comment.originalLine != null
    || comment.originalStartLine != null,
  ) ?? thread.comments[0];
}

function normalizeAnchor(anchor: ReviewThreadAnchor): ReviewThreadAnchor {
  const endLine = anchor.endLine;
  const startLine = anchor.startLine ?? endLine;
  if (startLine == null || endLine == null) {
    return { startLine, endLine };
  }

  return startLine <= endLine
    ? { startLine, endLine }
    : { startLine: endLine, endLine: startLine };
}

export function getReviewThreadAnchor(
  thread: ReviewThread,
  options: { preferOriginal?: boolean } = {},
): ReviewThreadAnchor {
  const anchoredComment = getAnchoredComment(thread);
  const preferOriginal = options.preferOriginal ?? false;

  if (preferOriginal) {
    return normalizeAnchor({
      startLine: firstNonNull(
        anchoredComment?.originalStartLine,
        anchoredComment?.startLine,
        thread.startLine,
        anchoredComment?.originalLine,
        anchoredComment?.line,
        thread.line,
      ),
      endLine: firstNonNull(
        anchoredComment?.originalLine,
        anchoredComment?.line,
        thread.line,
        anchoredComment?.originalStartLine,
        anchoredComment?.startLine,
        thread.startLine,
      ),
    });
  }

  return normalizeAnchor({
    startLine: firstNonNull(
      thread.startLine,
      anchoredComment?.startLine,
      anchoredComment?.originalStartLine,
      thread.line,
      anchoredComment?.line,
      anchoredComment?.originalLine,
    ),
    endLine: firstNonNull(
      thread.line,
      anchoredComment?.line,
      anchoredComment?.originalLine,
      thread.startLine,
      anchoredComment?.startLine,
      anchoredComment?.originalStartLine,
    ),
  });
}

export function getReviewThreadLine(thread: ReviewThread): number | null {
  return getReviewThreadAnchor(thread).endLine;
}

export function getReviewThreadRefCandidates(
  thread: ReviewThread,
  refs: { headRefName: string; baseRefName: string },
): ReviewThreadRefCandidate[] {
  const anchoredComment = getAnchoredComment(thread);
  const currentAnchor = getReviewThreadAnchor(thread);
  const originalAnchor = getReviewThreadAnchor(thread, { preferOriginal: true });
  const candidates: ReviewThreadRefCandidate[] = [];
  const seen = new Set<string>();

  function push(ref: string | null | undefined, anchor: ReviewThreadAnchor): void {
    if (!ref || seen.has(ref)) {
      return;
    }

    seen.add(ref);
    candidates.push({ ref, ...anchor });
  }

  push(anchoredComment?.originalCommitOid, originalAnchor);
  push(anchoredComment?.commitOid, currentAnchor);
  push(refs.headRefName, currentAnchor);
  push(refs.baseRefName, originalAnchor);

  return candidates;
}

function mapThread(thread: GraphQLThreadNode): ReviewThread {
  return {
    id: thread.id,
    path: thread.path,
    line: thread.line,
    startLine: thread.startLine,
    diffSide: normalizeDiffSide(thread.diffSide),
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    viewerCanResolve: thread.viewerCanResolve,
    viewerCanReply: thread.viewerCanReply,
    comments: (thread.comments.nodes ?? []).filter(isDefined).map(mapComment),
  };
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function getGraphQLErrors<T>(responseData: GitHubGraphQLResponse<T>): GitHubApiError[] {
  const topLevelErrors = responseData.errors ?? [];
  if (topLevelErrors.length > 0) {
    return topLevelErrors;
  }

  if (
    responseData.data &&
    typeof responseData.data === 'object' &&
    'errors' in responseData.data &&
    Array.isArray((responseData.data as { errors?: GitHubApiError[] }).errors)
  ) {
    return (responseData.data as { errors?: GitHubApiError[] }).errors ?? [];
  }

  return [];
}

async function postGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(GITHUB_GRAPHQL_API_URL, {
    method: 'POST',
    headers: createHeaders(token, true),
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const responseData = (await response.json()) as GitHubGraphQLResponse<T>;
  const errors = getGraphQLErrors(responseData);
  if (errors.length > 0) {
    throw new Error(errors[0].message);
  }

  if (!responseData.data) {
    throw new Error('GitHub API error: missing data');
  }

  return responseData.data;
}

export function parseGitHubRemote(remoteUrl: string): GitHubRepo | null {
  const sshMatch = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  try {
    const url = new URL(remoteUrl);
    if (url.hostname !== 'github.com') {
      return null;
    }

    const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (segments.length !== 2) {
      return null;
    }

    const [owner, repoName] = segments;
    if (!owner || !repoName) {
      return null;
    }

    return {
      owner,
      repo: repoName.replace(/\.git$/, ''),
    };
  } catch {
    return null;
  }
}

export async function findPRForBranch(
  token: string,
  repo: GitHubRepo,
  branch: string,
): Promise<PullRequestInfo | null> {
  const url = new URL(
    `${GITHUB_REST_API_URL}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls`,
  );
  url.search = new URLSearchParams({
    head: `${repo.owner}:${branch}`,
    state: 'open',
  }).toString();

  const response = await fetch(url.toString(), {
    headers: createHeaders(token),
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const pullRequests = (await response.json()) as RestPullRequest[];
  const pullRequest = pullRequests[0];
  if (!pullRequest) {
    return null;
  }

  return {
    number: pullRequest.number,
    nodeId: pullRequest.node_id,
    title: pullRequest.title,
  };
}

export async function fetchReviewThreads(
  token: string,
  repo: GitHubRepo,
  prNumber: number,
): Promise<ReviewThread[]> {
  const data = await postGraphQL<ReviewThreadsQueryData>(token, GET_PR_REVIEW_THREADS_QUERY, {
    owner: repo.owner,
    repo: repo.repo,
    prNumber,
  });

  const threads = data.repository?.pullRequest?.reviewThreads.nodes ?? [];
  return threads.filter(isDefined).map(mapThread);
}

export async function resolveThread(token: string, threadId: string): Promise<void> {
  await postGraphQL<ResolveThreadMutationData>(token, RESOLVE_THREAD_MUTATION, {
    threadId,
  });
}

export async function replyToThread(
  token: string,
  threadId: string,
  body: string,
): Promise<ReviewComment> {
  const data = await postGraphQL<ReplyToThreadMutationData>(token, REPLY_TO_THREAD_MUTATION, {
    threadId,
    body,
  });

  const comment = data.addPullRequestReviewThreadReply?.comment;
  if (!comment) {
    throw new Error('GitHub API error: missing data');
  }

  return mapComment(comment);
}

export async function createReviewComment(
  token: string,
  prNodeId: string,
  path: string,
  line: number,
  body: string,
): Promise<void> {
  await postGraphQL<CreateReviewCommentMutationData>(token, CREATE_REVIEW_COMMENT_MUTATION, {
    input: {
      pullRequestId: prNodeId,
      event: 'COMMENT',
      threads: [{ path, line, body, side: 'RIGHT' }],
    },
  });
}

export interface PRFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  previousFilename?: string;
}

export async function fetchPRFiles(
  token: string,
  repo: GitHubRepo,
  prNumber: number,
): Promise<PRFile[]> {
  // ponytail: first 100 files; add pagination if PRs with 100+ changed files become common
  const response = await fetch(
    `${GITHUB_REST_API_URL}/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/files?per_page=100`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
  );
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  return response.json() as Promise<PRFile[]>;
}

export async function fetchOpenPRs(token: string, repo: GitHubRepo): Promise<PRSummary[]> {
  // ponytail: first 30 open PRs; add pagination if needed
  const response = await fetch(
    `${GITHUB_REST_API_URL}/repos/${repo.owner}/${repo.repo}/pulls?state=open&per_page=30`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
  );
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  const data = await response.json() as RestOpenPullRequest[];
  return data.map((pr) => ({
    number: pr.number,
    nodeId: pr.node_id,
    title: pr.title,
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    isDraft: pr.draft,
  }));
}

export async function fetchFileContent(
  token: string,
  repo: GitHubRepo,
  ref: string,
  path: string,
): Promise<string | null> {
  const response = await fetch(
    `${GITHUB_REST_API_URL}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    { headers: createHeaders(token) },
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = await response.json() as { content?: string; encoding?: string; type?: string };
  if (data.type !== 'file' || !data.content) {
    return null;
  }

  if (data.encoding !== 'base64') {
    throw new Error('GitHub API error: unsupported file encoding');
  }

  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
}
