/**
 * Minimal GitHub REST API v3 client (no SDK dependency).
 *
 * All functions that write to GitHub (createPR, postReview, forkRepo)
 * require a personal access token with `repo` scope.
 * Read-only functions work unauthenticated but are rate-limited to 60/hour.
 */

const BASE = "https://api.github.com";

export const ASH_REPO = "Doheon/ash";

export interface GitHubUser {
  login: string;
  name: string | null;
  email: string | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: { name: string }[];
  state: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
  state: string;
  user: { login: string };
  draft: boolean;
  merged: boolean;
  changed_files?: number;
  additions?: number;
  deletions?: number;
}

export interface GitHubReview {
  id: number;
  user: { login: string };
  state: string;
  body: string;
  submitted_at: string;
  html_url: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function ghFetch(
  path: string,
  token?: string,
  opts: RequestInit & { accept?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: opts.accept ?? "application/vnd.github.v3+json",
    "User-Agent": "ash-p2p/0.1.0",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (opts.body) headers["Content-Type"] = "application/json";

  const { accept: _a, ...fetchOpts } = opts;
  return fetch(`${BASE}${path}`, { ...fetchOpts, headers: { ...headers, ...(opts.headers ?? {}) } });
}

async function jsonOrThrow<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${label}: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Auth / identity
// ---------------------------------------------------------------------------

export async function fetchCurrentUser(token: string): Promise<GitHubUser> {
  const res = await ghFetch("/user", token);
  return jsonOrThrow<GitHubUser>(res, "fetchCurrentUser");
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export async function fetchOpenIssues(
  repo = ASH_REPO,
  token?: string,
): Promise<GitHubIssue[]> {
  const res = await ghFetch(`/repos/${repo}/issues?state=open&per_page=50&direction=asc`, token);
  const all = await jsonOrThrow<(GitHubIssue & { pull_request?: unknown })[]>(res, "fetchOpenIssues");
  // GitHub's issues endpoint also returns PRs; filter those out.
  return all.filter((i) => !i.pull_request);
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export async function fetchOpenPRs(
  repo = ASH_REPO,
  token?: string,
): Promise<GitHubPR[]> {
  const res = await ghFetch(`/repos/${repo}/pulls?state=open&per_page=30`, token);
  return jsonOrThrow<GitHubPR[]>(res, "fetchOpenPRs");
}

export async function fetchPR(
  repo: string,
  prNumber: number,
  token?: string,
): Promise<GitHubPR> {
  const res = await ghFetch(`/repos/${repo}/pulls/${prNumber}`, token);
  return jsonOrThrow<GitHubPR>(res, "fetchPR");
}

export async function fetchPRDiff(
  repo: string,
  prNumber: number,
  token?: string,
): Promise<string> {
  const res = await ghFetch(`/repos/${repo}/pulls/${prNumber}`, token, {
    accept: "application/vnd.github.v3.diff",
  });
  if (!res.ok) throw new Error(`fetchPRDiff: HTTP ${res.status}`);
  return res.text();
}

export async function fetchPRReviews(
  repo: string,
  prNumber: number,
  token?: string,
): Promise<GitHubReview[]> {
  const res = await ghFetch(`/repos/${repo}/pulls/${prNumber}/reviews`, token);
  return jsonOrThrow<GitHubReview[]>(res, "fetchPRReviews");
}

export async function createPR(
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string,
  token: string,
): Promise<GitHubPR> {
  const res = await ghFetch(`/repos/${repo}/pulls`, token, {
    method: "POST",
    body: JSON.stringify({ title, body, head, base }),
  });
  return jsonOrThrow<GitHubPR>(res, "createPR");
}

export async function createPRReview(
  repo: string,
  prNumber: number,
  body: string,
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  token: string,
): Promise<GitHubReview> {
  const res = await ghFetch(`/repos/${repo}/pulls/${prNumber}/reviews`, token, {
    method: "POST",
    body: JSON.stringify({ body, event }),
  });
  return jsonOrThrow<GitHubReview>(res, "createPRReview");
}

// ---------------------------------------------------------------------------
// Forks
// ---------------------------------------------------------------------------

export interface GitHubRepo {
  full_name: string;
  html_url: string;
  clone_url: string;
}

/** Returns the user's existing fork or creates one. Polling until ready. */
export async function ensureFork(
  upstreamRepo: string,
  token: string,
): Promise<GitHubRepo> {
  const user = await fetchCurrentUser(token);
  const [, repoName] = upstreamRepo.split("/");
  const forkFullName = `${user.login}/${repoName}`;

  // Check if fork already exists.
  const checkRes = await ghFetch(`/repos/${forkFullName}`, token);
  if (checkRes.ok) {
    return jsonOrThrow<GitHubRepo>(checkRes, "ensureFork:check");
  }

  // Create fork.
  const createRes = await ghFetch(`/repos/${upstreamRepo}/forks`, token, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const fork = await jsonOrThrow<GitHubRepo>(createRes, "ensureFork:create");

  // GitHub forks are async — poll until the default branch is available.
  for (let i = 0; i < 12; i++) {
    await new Promise<void>((r) => setTimeout(r, 5_000));
    const pollRes = await ghFetch(`/repos/${fork.full_name}`, token);
    if (pollRes.ok) {
      const repo = await pollRes.json() as GitHubRepo & { default_branch: string };
      if (repo.default_branch) return repo;
    }
  }
  return fork;
}
