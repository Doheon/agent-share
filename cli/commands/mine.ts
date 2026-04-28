/**
 * ash mine — automatically earn credits by contributing to the ash GitHub repo.
 *
 * Scans the current state of Doheon/ash and selects the highest-priority action:
 *
 *   pr_approve    — a PR I reviewed earlier has no approval yet → approve it
 *   pr_review     — an open PR has no review from me yet → review it
 *   pr_create     — an open issue has no PR yet → implement it → create PR
 *   issue_create  — no unclaimed issues → analyze codebase → open a new issue
 *
 * Credit rewards:
 *   pr_create    6 cr  (+3 if test files changed)
 *   pr_review    3 cr
 *   pr_approve   2 cr
 *   issue_create 4 cr
 */

import { Command } from "commander";
import { input } from "@inquirer/prompts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";

import { loadConfig, loadIdentity, saveConfig } from "../client.ts";
import { appendLocalEvent, closeLocalStore, getNextNonce } from "../p2p_state.ts";
import { ensureInitialized, NotInitializedError } from "../guard.ts";
import { signEd25519 } from "../../core/crypto/ed25519.ts";
import { canonicalStringify } from "../../shared/canonical.ts";
import {
  fetchOpenIssues,
  fetchOpenPRs,
  fetchPRDiff,
  fetchPRReviews,
  fetchCurrentUser,
  ensureFork,
  createPR,
  createPRReview,
  createIssue,
  ASH_REPO,
  type GitHubIssue,
  type GitHubPR,
  type GitHubReview,
} from "../../core/github/client.ts";
import { AshSwarm } from "../../core/p2p/swarm.ts";
import type { MineAction } from "../../core/p2p/messages.ts";
import type { EarnEvent } from "../../shared/events.ts";
import { spawn } from "../../core/util/spawn.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Mine rewards reflect the Claude Code (sonnet-tier) session cost for each action.
//   pr_create   : full agent session — implements + commits code  → 1 sonnet task
//   issue_create: full codebase analysis session                  → ~0.7 sonnet task
//   pr_review   : lighter session — diff pre-embedded in prompt   → ~0.5 sonnet task
//   pr_approve  : brief text generation only                      → 1 haiku task
const MINE_CREDITS: Record<MineAction, number> = {
  pr_create: 6,
  pr_review: 3,
  pr_approve: 2,
  issue_create: 4,
};
const TEST_BONUS = 3;

const ISSUE_CATEGORIES = [
  "security", "feature", "bug", "testing", "refactor", "dx", "performance",
] as const;

const IS_TTY = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const _a = (c: string) => IS_TTY ? `\x1b[${c}m` : "";
const R = _a("0"), B = _a("1"), D = _a("2");
const GR = _a("32"), YL = _a("33"), RD = _a("31"), CY = _a("36");

const enc = new TextEncoder();
const out = (s: string) => writeSync(1, enc.encode(s));

// ---------------------------------------------------------------------------
// GitHub state → action selection
// ---------------------------------------------------------------------------

type MineDecision =
  | { action: "pr_approve"; pr: GitHubPR; myReview: GitHubReview }
  | { action: "pr_review"; pr: GitHubPR }
  | { action: "pr_create"; issue: GitHubIssue }
  | { action: "issue_create"; existingIssues: GitHubIssue[] }
  | { action: "idle"; reason: string };

/**
 * Scans GitHub state and returns the best action to take.
 *
 * Priority:
 *   1. pr_approve    — I already reviewed a PR that has no approval yet
 *   2. pr_review     — an open non-draft PR has no review from me
 *   3. pr_create     — an open issue has no linked PR
 *   4. issue_create  — no unclaimed issues; analyze codebase and open a new one
 */
async function selectAction(token: string, myLogin: string): Promise<MineDecision> {
  out(`  ${D}scanning GitHub state…${R}\n`);

  const [issues, prs] = await Promise.all([
    fetchOpenIssues(ASH_REPO, token),
    fetchOpenPRs(ASH_REPO, token),
  ]);

  const reviewablePRs = prs.filter((p) => !p.draft && p.user.login !== myLogin);

  // Fetch reviews for all reviewable PRs in parallel.
  const reviewsByPR = await Promise.all(
    reviewablePRs.map(async (pr) => ({
      pr,
      reviews: await fetchPRReviews(ASH_REPO, pr.number, token).catch(() => [] as GitHubReview[]),
    })),
  );

  // 1. pr_approve: I reviewed a PR that still has no approval.
  for (const { pr, reviews } of reviewsByPR) {
    const myReview = reviews.find(
      (r) => r.user.login === myLogin &&
        (r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED")
    );
    const hasApproval = reviews.some((r) => r.state === "APPROVED");
    if (myReview && !hasApproval) {
      return { action: "pr_approve", pr, myReview };
    }
  }

  // 2. pr_review: an open PR has no review from me.
  for (const { pr, reviews } of reviewsByPR) {
    const iReviewed = reviews.some((r) => r.user.login === myLogin);
    if (!iReviewed) {
      return { action: "pr_review", pr };
    }
  }

  // 3. pr_create: an open issue has no linked PR.
  // A PR is considered "linked" if its body or title mentions #<issue_number>.
  const linkedIssueNums = new Set<number>();
  for (const pr of prs) {
    const text = `${pr.title} ${pr.body ?? ""}`;
    for (const m of text.matchAll(/#(\d+)/g)) {
      linkedIssueNums.add(parseInt(m[1]!, 10));
    }
  }
  const unclaimedIssue = issues.find((i) => !linkedIssueNums.has(i.number));
  if (unclaimedIssue) {
    return { action: "pr_create", issue: unclaimedIssue };
  }

  // 4. issue_create: no unclaimed issues — analyze codebase and open a new one.
  return { action: "issue_create", existingIssues: issues };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildCreatePrompt(issue: GitHubIssue): string {
  return [
    `You are implementing GitHub issue #${issue.number} in the 'ash' project`,
    `(a fully P2P distributed AI coding agent CLI written in TypeScript/Node.js).`,
    ``,
    `Issue: ${issue.title}`,
    `URL:   ${issue.html_url}`,
    ``,
    issue.body?.trim() ? `Description:\n${issue.body.trim()}` : "(no description provided)",
    ``,
    `Instructions:`,
    `- Read relevant source files to understand the codebase before making changes.`,
    `- Implement the changes needed to resolve this issue completely.`,
    `- Follow the existing code style (TypeScript, no unnecessary comments, English only).`,
    `- Add or update *_test.ts files when the change involves non-trivial logic.`,
    `- Do not create README or documentation files unless the issue explicitly asks.`,
    `- Do not add features beyond what the issue asks for.`,
  ].join("\n");
}

function buildReviewPrompt(pr: GitHubPR, diff: string): string {
  const trimmed = diff.length > 14_000 ? diff.slice(0, 14_000) + "\n...(truncated)" : diff;
  return [
    `You are reviewing pull request #${pr.number} for the 'ash' project`,
    `(a P2P distributed AI coding agent CLI in TypeScript/Node.js).`,
    ``,
    `PR:     ${pr.title}`,
    `URL:    ${pr.html_url}`,
    `Author: ${pr.user.login}`,
    ``,
    pr.body?.trim() ? `Description:\n${pr.body.trim()}` : "(no description)",
    ``,
    `Diff:\n${trimmed}`,
    ``,
    `Write a thorough, constructive code review. Focus on:`,
    `- Logic bugs and correctness`,
    `- Security vulnerabilities (path traversal, injection, crypto misuse)`,
    `- TypeScript type safety`,
    `- Consistency with the existing codebase style`,
    `- Missing edge cases or error handling`,
    ``,
    `Format: plain prose paragraphs, no markdown headers.`,
    `Reference specific file names or line numbers when relevant.`,
    `Output ONLY the review text — it will be posted directly as a GitHub comment.`,
  ].join("\n");
}

function buildApprovePrompt(pr: GitHubPR, diff: string, myReview: GitHubReview): string {
  const trimmed = diff.length > 10_000 ? diff.slice(0, 10_000) + "\n...(truncated)" : diff;
  return [
    `You previously reviewed pull request #${pr.number} for the 'ash' project.`,
    ``,
    `PR:     ${pr.title}`,
    `URL:    ${pr.html_url}`,
    `Author: ${pr.user.login}`,
    ``,
    `Your earlier review comment:`,
    myReview.body?.trim() || "(no body)",
    ``,
    `Current diff:\n${trimmed}`,
    ``,
    `The author has addressed the feedback. Write a brief approval message`,
    `(1–3 sentences) acknowledging what was fixed and confirming the PR is ready to merge.`,
    `Output ONLY the approval message text — it will be posted as a GitHub APPROVE review.`,
  ].join("\n");
}

function buildIssuePrompt(existingIssues: GitHubIssue[]): string {
  const issueList = existingIssues.length > 0
    ? existingIssues.map((i, idx) => `  ${idx + 1}. #${i.number} ${i.title}`).join("\n")
    : "  (none)";
  const categories = ISSUE_CATEGORIES.join(" | ");
  return [
    `You are creating a GitHub issue for the 'ash' project`,
    `(a fully P2P distributed AI coding agent CLI written in TypeScript/Node.js).`,
    ``,
    `Existing open issues (do not duplicate):`,
    issueList,
    ``,
    `Categories: ${categories}`,
    ``,
    `Instructions:`,
    `- Read the source files in this directory to understand the current state.`,
    `- Pick the category with fewest existing issues where you found a real gap.`,
    `- Write ONE specific, actionable issue that a single PR can resolve.`,
    `- Only report problems or improvements you actually observed in the code.`,
    `- Do not invent problems.`,
    ``,
    `Output format (exact — no other text before or after):`,
    `TITLE: <concise issue title>`,
    `LABEL: <one of: ${categories}>`,
    `---`,
    `<markdown body: problem description, expected behavior, affected files>`,
  ].join("\n");
}

function parseIssueOutput(text: string): { title: string; label: string; body: string } | null {
  const title = text.match(/^TITLE:\s*(.+)$/m)?.[1]?.trim();
  const label = text.match(/^LABEL:\s*(\w+)$/m)?.[1]?.trim();
  const sep = text.indexOf("\n---\n");
  const body = sep >= 0 ? text.slice(sep + 5).trim() : "";
  if (!title || !label || !body) return null;
  return { title, label, body };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function git(args: string[], cwd?: string): Promise<string> {
  const proc = spawn(["git", ...args], { stdout: "pipe", stderr: "pipe", cwd });
  const [code, stdout, stderr] = await Promise.all([proc.exited, proc.stdout, proc.stderr]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim() || stdout.trim()}`);
  return stdout.trim();
}

async function pushBranch(repoDir: string, branch: string, cloneUrl: string, token: string): Promise<void> {
  const authedUrl = cloneUrl.replace("https://", `https://oauth2:${token}@`);
  await git(["push", authedUrl, `${branch}:${branch}`], repoDir);
}

function hasTestChanges(stat: string): boolean {
  return /_test\.ts|\.test\.ts/.test(stat);
}

// ---------------------------------------------------------------------------
// Agent runner (captures stdout as result text)
// ---------------------------------------------------------------------------

async function runAgentCapture(prompt: string, cwd: string): Promise<{ code: number; text: string }> {
  const proc = spawn(
    ["claude", "-p", prompt, "--dangerously-skip-permissions"],
    { stdout: "pipe", stderr: "pipe", cwd },
  );
  const [code, stdout] = await Promise.all([proc.exited, proc.stdout, proc.stderr]);
  return { code, text: stdout.trim() };
}

async function runAgentInteractive(prompt: string, cwd: string, onLine: (l: string) => void): Promise<number> {
  const proc = spawn(
    ["claude", "-p", prompt, "--dangerously-skip-permissions"],
    { stdout: "pipe", stderr: "pipe", cwd, onLine: (_s, l) => onLine(l) },
  );
  const [code] = await Promise.all([proc.exited, proc.stdout, proc.stderr]);
  return code;
}

// ---------------------------------------------------------------------------
// Credit/EarnEvent helpers
// ---------------------------------------------------------------------------

async function buildSelfSignedEarn(
  pubkey: string,
  privKey: import("node:crypto").KeyObject,
  taskId: string,
  amount: number,
  nonce: number,
): Promise<EarnEvent> {
  const now = new Date().toISOString();
  // Include claimant_pubkey to match the cosign payload format used by serve.ts.
  const taskSigPayload = canonicalStringify({ task_id: taskId, amount, claimant_pubkey: pubkey, action: "earn" });
  const counterpartyTaskSig = signEd25519(taskSigPayload, privKey);
  const partial: Omit<EarnEvent, "signature"> = {
    type: "earn",
    nonce,
    timestamp: now,
    amount,
    task_id: taskId,
    counterparty_pubkey: pubkey,
    counterparty_task_signature: counterpartyTaskSig,
  };
  const sig = signEd25519(canonicalStringify(partial), privKey);
  return { ...partial, signature: sig };
}

async function broadcastAndCollectCosign(opts: {
  claimId: string;
  claimantPubkey: string;
  privKey: import("node:crypto").KeyObject;
  nonce: number;
  taskId: string;
  githubRef: string;
  action: MineAction;
  amount: number;
  prUrl: string;
  fallbackEarn: EarnEvent;
}): Promise<EarnEvent> {
  const { claimId, claimantPubkey, privKey, nonce, taskId, githubRef, action, amount, prUrl, fallbackEarn } = opts;

  return new Promise<EarnEvent>((resolve) => {
    const swarm = new AshSwarm();
    let resolved = false;

    const finish = (earn: EarnEvent) => {
      if (resolved) return;
      resolved = true;
      swarm.destroy().catch(() => undefined);
      resolve(earn);
    };

    const timer = setTimeout(() => finish(fallbackEarn), 8_000);

    swarm.join(privKey, claimantPubkey).then(() => {
      swarm.onMessage((_peer, msg) => {
        if (msg.type !== "mine:cosign" || msg.claim_id !== claimId) return;
        clearTimeout(timer);
        const now = new Date().toISOString();
        const partial: Omit<EarnEvent, "signature"> = {
          type: "earn",
          nonce,
          timestamp: now,
          amount,
          task_id: taskId,
          counterparty_pubkey: msg.cosigner_pubkey,
          counterparty_task_signature: msg.cosigner_task_signature,
        };
        const sig = signEd25519(canonicalStringify(partial), privKey);
        finish({ ...partial, signature: sig });
      });

      swarm.broadcast({
        type: "mine:claim",
        claim_id: claimId,
        claimant_pubkey: claimantPubkey,
        claimant_next_nonce: nonce,
        github_ref: githubRef,
        task_id: taskId,
        action,
        amount,
        pr_url: prUrl,
        timestamp: new Date().toISOString(),
      });
    }).catch(() => finish(fallbackEarn));
  });
}

async function earnCredits(opts: {
  myPub: string;
  privKey: import("node:crypto").KeyObject;
  taskId: string;
  githubRef: string;
  action: MineAction;
  amount: number;
  url: string;
  extra?: string;
}): Promise<void> {
  const { myPub, privKey, taskId, githubRef, action, amount, url, extra } = opts;
  const nonce = await getNextNonce(myPub);
  const selfEarn = await buildSelfSignedEarn(myPub, privKey, taskId, amount, nonce);

  out(`  ${D}broadcasting mine:claim…${R}\n`);
  const earnEvent = await broadcastAndCollectCosign({
    claimId: randomUUID(),
    claimantPubkey: myPub,
    privKey,
    nonce,
    taskId,
    githubRef,
    action,
    amount,
    prUrl: url,
    fallbackEarn: selfEarn,
  });

  await appendLocalEvent(myPub, earnEvent);
  const extraNote = extra ? `  (${extra})` : "";
  out(`  ${GR}✓${R}  ${B}+${amount} credits${R}${extraNote}\n`);
}

// ---------------------------------------------------------------------------
// Action executors
// ---------------------------------------------------------------------------

async function doPrCreate(issue: GitHubIssue, token: string, myPub: string, privKey: import("node:crypto").KeyObject, ghLogin: string, ghEmail: string): Promise<boolean> {
  out(`\n  ${B}[implement]${R} #${issue.number} ${issue.title}\n`);
  out(`  ${D}${"─".repeat(56)}${R}\n`);

  out(`  ${D}forking Doheon/ash…${R}\n`);
  const fork = await ensureFork(ASH_REPO, token);

  const branch = `ash-mine/issue-${issue.number}`;
  const tmpDir = await mkdtemp(join(tmpdir(), "ash-mine-"));

  try {
    out(`  ${D}cloning…${R}\n`);
    const authedUrl = fork.clone_url.replace("https://", `https://oauth2:${token}@`);
    await git(["clone", "--depth=1", authedUrl, tmpDir]);
    await git(["config", "user.name", ghLogin], tmpDir);
    await git(["config", "user.email", ghEmail], tmpDir);
    await git(["checkout", "-b", branch], tmpDir);

    out(`  ${CY}running agent…${R}\n`);
    const code = await runAgentInteractive(buildCreatePrompt(issue), tmpDir, (l) => out(`  ${D}${l}${R}\n`));
    out(`\n  ${D}agent exit: ${code}${R}\n`);

    const diffStat = await git(["diff", "--stat", "HEAD"], tmpDir).catch(() => "");
    if (!diffStat.trim()) {
      out(`  ${YL}⚠${R}  No changes produced. Skipping.\n`);
      return false;
    }
    out(`\n${diffStat}\n`);

    // Race-condition guard: re-check GitHub in case another peer created a PR while agent was running.
    const freshPRs = await fetchOpenPRs(ASH_REPO, token);
    const alreadyLinked = freshPRs.some((p) => {
      const text = `${p.title} ${p.body ?? ""}`;
      return [...text.matchAll(/#(\d+)/g)].some((m) => parseInt(m[1]!, 10) === issue.number);
    });
    if (alreadyLinked) {
      out(`  ${YL}⚠${R}  A PR for #${issue.number} was created by another peer. Skipping.\n`);
      return false;
    }

    await git(["add", "-A"], tmpDir);
    await git(["commit", "-m", `fix: ${issue.title}\n\nResolves #${issue.number}\n\nImplemented via ash mine`], tmpDir);

    out(`  ${D}pushing…${R}\n`);
    await pushBranch(tmpDir, branch, fork.clone_url, token);

    const prBody = `Resolves #${issue.number}\n\n---\n*Implemented by [ash mine](https://github.com/Doheon/ash).*`;
    const [owner] = fork.full_name.split("/");
    const pr = await createPR(ASH_REPO, `fix: ${issue.title}`, prBody, `${owner}:${branch}`, "main", token);
    out(`\n  ${GR}✓${R}  PR created: ${pr.html_url}\n`);

    const testsChanged = hasTestChanges(diffStat);
    const amount = MINE_CREDITS.pr_create + (testsChanged ? TEST_BONUS : 0);
    await earnCredits({
      myPub, privKey,
      taskId: `github:pr:${ASH_REPO}:${pr.number}`,
      githubRef: `pr:${ASH_REPO}:${pr.number}`,
      action: "pr_create", amount,
      url: pr.html_url,
      extra: testsChanged ? "includes test bonus" : undefined,
    });
    return true;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function doPrReview(pr: GitHubPR, token: string, myPub: string, privKey: import("node:crypto").KeyObject): Promise<boolean> {
  out(`\n  ${B}[review]${R} #${pr.number} ${pr.title}\n`);
  out(`  ${D}${"─".repeat(56)}${R}\n`);

  out(`  ${D}fetching diff…${R}\n`);
  const diff = await fetchPRDiff(ASH_REPO, pr.number, token);

  const tmpDir = await mkdtemp(join(tmpdir(), "ash-review-"));
  try {
    out(`  ${CY}running agent…${R}\n`);
    const { code, text: reviewText } = await runAgentCapture(buildReviewPrompt(pr, diff), tmpDir);
    out(`  ${D}agent exit: ${code}${R}\n`);

    if (!reviewText) {
      out(`  ${RD}✗${R}  No review text produced. Skipping.\n`);
      return false;
    }
    out(`\n  ${D}${reviewText.slice(0, 160)}…${R}\n\n`);

    const review = await createPRReview(ASH_REPO, pr.number, reviewText, "COMMENT", token);
    out(`  ${GR}✓${R}  Review posted: ${review.html_url}\n`);

    await earnCredits({
      myPub, privKey,
      taskId: `github:review:${ASH_REPO}:${pr.number}:${review.id}`,
      githubRef: `review:${ASH_REPO}:${pr.number}`,
      action: "pr_review", amount: MINE_CREDITS.pr_review, url: review.html_url,
    });
    return true;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function doPrApprove(pr: GitHubPR, myReview: GitHubReview, token: string, myPub: string, privKey: import("node:crypto").KeyObject): Promise<boolean> {
  out(`\n  ${B}[approve]${R} #${pr.number} ${pr.title}\n`);
  out(`  ${D}${"─".repeat(56)}${R}\n`);

  const diff = await fetchPRDiff(ASH_REPO, pr.number, token);

  const tmpDir = await mkdtemp(join(tmpdir(), "ash-approve-"));
  try {
    out(`  ${CY}running agent…${R}\n`);
    const { code, text: approveText } = await runAgentCapture(buildApprovePrompt(pr, diff, myReview), tmpDir);
    out(`  ${D}agent exit: ${code}${R}\n`);

    const body = approveText || "Changes look good. Approving.";
    const review = await createPRReview(ASH_REPO, pr.number, body, "APPROVE", token);
    out(`  ${GR}✓${R}  Approved: ${review.html_url}\n`);

    await earnCredits({
      myPub, privKey,
      taskId: `github:approve:${ASH_REPO}:${pr.number}:${review.id}`,
      githubRef: `approve:${ASH_REPO}:${pr.number}`,
      action: "pr_approve", amount: MINE_CREDITS.pr_approve, url: review.html_url,
    });
    return true;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function doIssueCreate(existingIssues: GitHubIssue[], token: string, myPub: string, privKey: import("node:crypto").KeyObject): Promise<boolean> {
  out(`\n  ${B}[issue]${R} analyzing codebase to find a new issue to open\n`);
  out(`  ${D}${"─".repeat(56)}${R}\n`);

  const tmpDir = await mkdtemp(join(tmpdir(), "ash-mine-issue-"));
  try {
    out(`  ${D}cloning Doheon/ash…${R}\n`);
    await git(["clone", "--depth=1", `https://github.com/${ASH_REPO}.git`, tmpDir]);

    out(`  ${CY}running agent…${R}\n`);
    const { code, text } = await runAgentCapture(buildIssuePrompt(existingIssues), tmpDir);
    out(`  ${D}agent exit: ${code}${R}\n`);

    const parsed = parseIssueOutput(text);
    if (!parsed) {
      out(`  ${YL}⚠${R}  Could not parse issue output. Skipping.\n`);
      return false;
    }

    const { title, label, body } = parsed;
    out(`  ${D}opening issue: ${B}${title}${R}\n`);
    const issue = await createIssue(ASH_REPO, title, body, [label], token);
    out(`  ${GR}✓${R}  Issue created: ${issue.html_url}\n`);

    await earnCredits({
      myPub, privKey,
      taskId: `github:issue:${ASH_REPO}:${issue.number}`,
      githubRef: `issue:${ASH_REPO}:${issue.number}`,
      action: "issue_create", amount: MINE_CREDITS.issue_create, url: issue.html_url,
    });
    return true;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function runMine(opts: { count: number }): Promise<void> {
  const cfg = await loadConfig();
  const token = cfg.githubToken ?? process.env.GITHUB_TOKEN;
  if (!token) {
    const t = await input({ message: "GitHub personal access token (repo scope):" });
    await saveConfig({ githubToken: t.trim() });
    return runMine(opts);
  }

  if (!cfg.pubkey) throw new Error("Not initialized. Run: ash init");
  const { priv: privKey } = await loadIdentity();
  const myPub = cfg.pubkey;

  const ghUser = await fetchCurrentUser(token);
  const ghEmail = ghUser.email ?? `${ghUser.login}@users.noreply.github.com`;

  out(`\n  ${B}${CY}ash mine${R}  ${D}· up to ${opts.count} task(s)  · @${ghUser.login}${R}\n\n`);

  let done = 0;
  while (done < opts.count) {
    const decision = await selectAction(token, ghUser.login);

    if (decision.action === "idle") {
      out(`  ${YL}⚠${R}  ${decision.reason}\n\n`);
      break;
    }

    out(`  ${D}selected action: ${B}${decision.action}${R}\n`);

    try {
      let acted = false;
      if (decision.action === "pr_create") {
        acted = await doPrCreate(decision.issue, token, myPub, privKey, ghUser.login, ghEmail);
      } else if (decision.action === "pr_review") {
        acted = await doPrReview(decision.pr, token, myPub, privKey);
      } else if (decision.action === "pr_approve") {
        acted = await doPrApprove(decision.pr, decision.myReview, token, myPub, privKey);
      } else if (decision.action === "issue_create") {
        acted = await doIssueCreate(decision.existingIssues, token, myPub, privKey);
        // issue_create is a fallback action — stop after one attempt per run
        // regardless of -n, to avoid issue spam.
        if (acted) done++;
        break;
      }
      if (!acted) break;
      done++;
      out(`  ${D}${"─".repeat(56)}${R}\n`);
    } catch (err) {
      out(`  ${YL}⚠${R}  ${(err as Error).message}\n`);
      break;
    }
  }

  out(`\n  ${GR}✓${R}  Done: ${done} task(s) completed\n\n`);
  await closeLocalStore().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Command export
// ---------------------------------------------------------------------------

export const mineCommand = new Command("mine")
  .description("Earn credits by contributing to the ash GitHub repo (auto-selects best action)")
  .option("-n, --count <n>", "Number of tasks to perform in one run", (v) => parseInt(v, 10), 1)
  .action(async (options) => {
    try { await ensureInitialized(); }
    catch (err) {
      if (err instanceof NotInitializedError) {
        console.error(`\nerror: ${err.reason}\n  → ${err.hint}\n`);
        process.exit(2);
      }
      throw err;
    }
    await runMine({ count: options.count as number }).catch((err) => {
      console.error(`\nerror: ${(err as Error).message}\n`);
      process.exit(1);
    });
  });
