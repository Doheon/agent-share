/**
 * ash mine — earn credits by contributing to the ash GitHub repo.
 *
 * Action selection priority (auto cycle):
 *
 *   pr_fix     — my open non-draft PR has no APPROVAL and either has unaddressed
 *                feedback OR no self-improvement commit yet → push fix
 *   pr_review  — an open non-draft PR by someone else has no review from me →
 *                review with one of approve | changes_requested | close_recommend
 *   pr_create  — an open issue has no linked PR and no close-rec marker comment
 *                from me → agent decides implement or close
 *   idle       — none of the above; clean exit (no autonomous issue_create)
 *
 * Query mode (skips auto cycle):
 *
 *   ash mine "<query>"  — agent inspects codebase for evidence of the issue and
 *                         either creates an issue (with verified file paths) or
 *                         rejects.
 */

import { Command } from "commander";
import { input } from "@inquirer/prompts";
import { mkdtemp, rm, access } from "node:fs/promises";
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
  fetchPRCommits,
  fetchIssueComments,
  fetchCurrentUser,
  ensureFork,
  createPR,
  createPRReview,
  createIssue,
  addIssueComment,
  addLabels,
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
// Types
// ---------------------------------------------------------------------------

export type Logger = (s: string) => void;

export interface MineContext {
  token: string;
  myPub: string;
  privKey: import("node:crypto").KeyObject;
  ghLogin: string;
  ghEmail: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MINE_CREDITS: Record<MineAction, number> = {
  pr_create: 6,
  pr_create_close_rec: 2,
  pr_review_approve: 2,
  pr_review_changes_requested: 3,
  pr_review_close_rec: 2,
  pr_fix_self: 4,
  pr_fix_feedback: 5,
  issue_create: 4,
};
const TEST_BONUS = 3;

const MINE_LABEL = "ash-mine";
const FIX_MARKER = "[ash-mine-fix]";
const CLOSE_REC_MARKER = "<!-- ash-mine:close-rec -->";

const ISSUE_CATEGORIES = [
  "security", "feature", "bug", "testing", "refactor", "dx", "performance",
] as const;

const IS_TTY = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const _a = (c: string) => IS_TTY ? `\x1b[${c}m` : "";
const R = _a("0"), B = _a("1"), D = _a("2");
const GR = _a("32"), YL = _a("33"), RD = _a("31"), CY = _a("36");

const enc = new TextEncoder();
const cliOut: Logger = (s: string) => writeSync(1, enc.encode(s));

// ---------------------------------------------------------------------------
// GitHub state → action selection
// ---------------------------------------------------------------------------

type PRCommit = Awaited<ReturnType<typeof fetchPRCommits>>[number];

type MineDecision =
  | { action: "pr_fix"; pr: GitHubPR; mode: "self" | "feedback"; feedback: GitHubReview[] }
  | { action: "pr_review"; pr: GitHubPR }
  | { action: "pr_create"; issue: GitHubIssue }
  | { action: "idle"; reason: string };

async function selectAction(token: string, myLogin: string, log: Logger): Promise<MineDecision> {
  log(`  ${D}scanning GitHub state…${R}\n`);

  const [issues, prs] = await Promise.all([
    fetchOpenIssues(ASH_REPO, token),
    fetchOpenPRs(ASH_REPO, token),
  ]);

  const nonDraftPRs = prs.filter((p) => !p.draft);
  const reviewsByPR = new Map<number, GitHubReview[]>();
  await Promise.all(nonDraftPRs.map(async (pr) => {
    const reviews = await fetchPRReviews(ASH_REPO, pr.number, token).catch(() => [] as GitHubReview[]);
    reviewsByPR.set(pr.number, reviews);
  }));

  // 1. pr_fix: my open non-draft PR with no APPROVED review and a fix trigger.
  for (const pr of nonDraftPRs) {
    if (pr.user.login !== myLogin) continue;
    const reviews = reviewsByPR.get(pr.number) ?? [];
    if (reviews.some((r) => r.state === "APPROVED")) continue;

    const commits = await fetchPRCommits(ASH_REPO, pr.number, token).catch(() => [] as PRCommit[]);
    const myCommits = commits.filter((c) => c.author?.login === myLogin);
    const selfDone = myCommits.some((c) => (c.commit.message ?? "").includes(FIX_MARKER));
    const myLastCommitDate = myCommits
      .map((c) => c.commit.author?.date)
      .filter((d): d is string => !!d)
      .sort()
      .pop();

    const feedback = reviews.filter((r) =>
      r.user.login !== myLogin &&
      (r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED") &&
      (myLastCommitDate ? r.submitted_at > myLastCommitDate : true)
    );

    if (feedback.length > 0) {
      return { action: "pr_fix", pr, mode: "feedback", feedback };
    }
    if (!selfDone) {
      return { action: "pr_fix", pr, mode: "self", feedback: [] };
    }
  }

  // 2. pr_review: a non-draft PR by someone else with no review from me.
  for (const pr of nonDraftPRs) {
    if (pr.user.login === myLogin) continue;
    const reviews = reviewsByPR.get(pr.number) ?? [];
    if (reviews.some((r) => r.user.login === myLogin)) continue;
    return { action: "pr_review", pr };
  }

  // 3. pr_create: open issue with no linked PR and no close-rec marker from me.
  const linkedIssueNums = new Set<number>();
  for (const pr of prs) {
    const text = `${pr.title} ${pr.body ?? ""}`;
    for (const m of text.matchAll(/#(\d+)/g)) {
      linkedIssueNums.add(parseInt(m[1]!, 10));
    }
  }
  for (const issue of issues) {
    if (linkedIssueNums.has(issue.number)) continue;
    const comments = await fetchIssueComments(ASH_REPO, issue.number, token).catch(() => [] as { id: number; user: { login: string }; body: string }[]);
    const skip = comments.some((c) => c.user.login === myLogin && c.body.includes(CLOSE_REC_MARKER));
    if (skip) continue;
    return { action: "pr_create", issue };
  }

  return { action: "idle", reason: "nothing to do" };
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

function buildPrCreateVerdictPrompt(issue: GitHubIssue): string {
  return [
    `You are triaging GitHub issue #${issue.number} for the 'ash' project`,
    `(a fully P2P distributed AI coding agent CLI written in TypeScript/Node.js).`,
    ``,
    `Issue: ${issue.title}`,
    `URL:   ${issue.html_url}`,
    ``,
    issue.body?.trim() ? `Description:\n${issue.body.trim()}` : "(no description provided)",
    ``,
    `Decide whether this issue should be implemented or closed.`,
    `- implement: the issue describes a real, actionable change in the current codebase.`,
    `- close:     the issue is invalid, out of scope, already done, or duplicate.`,
    ``,
    `Output format (exact — no other text):`,
    `VERDICT: implement | close`,
    `<one-line reason>`,
  ].join("\n");
}

function parsePrCreateVerdict(text: string): { verdict: "implement" | "close"; reason: string } | null {
  const m = text.match(/^VERDICT:\s*(implement|close)\s*$/m);
  if (!m) return null;
  const verdict = m[1] as "implement" | "close";
  const after = text.slice(text.indexOf(m[0]) + m[0].length).trim();
  const reason = after.split("\n")[0]?.trim() ?? "";
  return { verdict, reason };
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
    `Decide one of three verdicts:`,
    `- approve            : the PR is correct and ready to merge.`,
    `- changes_requested  : the PR has fixable issues; describe them.`,
    `- close_recommend    : the PR should be closed (wrong direction, out of scope, duplicate).`,
    ``,
    `Output format (exact — first line is the verdict, then the review body):`,
    `VERDICT: approve | changes_requested | close_recommend`,
    `<review body — plain prose, reference files/lines when relevant; for approve, 1–3 sentences is fine>`,
  ].join("\n");
}

function parseReviewVerdict(text: string): { verdict: "approve" | "changes_requested" | "close_recommend"; body: string } | null {
  const m = text.match(/^VERDICT:\s*(approve|changes_requested|close_recommend)\s*$/m);
  if (!m) return null;
  const verdict = m[1] as "approve" | "changes_requested" | "close_recommend";
  const body = text.replace(m[0], "").trim();
  if (!body) return null;
  return { verdict, body };
}

function buildFixSelfPrompt(pr: GitHubPR, diff: string): string {
  const trimmed = diff.length > 14_000 ? diff.slice(0, 14_000) + "\n...(truncated)" : diff;
  return [
    `You are reviewing your own pull request #${pr.number} in the 'ash' project`,
    `and applying improvements before others review it.`,
    ``,
    `PR:    ${pr.title}`,
    `URL:   ${pr.html_url}`,
    ``,
    pr.body?.trim() ? `Description:\n${pr.body.trim()}` : "(no description)",
    ``,
    `Current diff:\n${trimmed}`,
    ``,
    `Instructions:`,
    `- Look for real defects, missing edge cases, or cleanup opportunities in the diff.`,
    `- Apply the changes directly to the working tree.`,
    `- Keep the scope tight; do not refactor unrelated code.`,
    `- If you find nothing meaningful to improve, exit without modifying any files.`,
  ].join("\n");
}

function buildFixFeedbackPrompt(pr: GitHubPR, diff: string, feedback: GitHubReview[]): string {
  const trimmed = diff.length > 12_000 ? diff.slice(0, 12_000) + "\n...(truncated)" : diff;
  const feedbackBlock = feedback.map((r, i) =>
    `--- review ${i + 1} by @${r.user.login} (${r.state}) ---\n${(r.body ?? "").trim() || "(no body)"}`
  ).join("\n\n");
  return [
    `You are addressing reviewer feedback on pull request #${pr.number} in the 'ash' project.`,
    ``,
    `PR:   ${pr.title}`,
    `URL:  ${pr.html_url}`,
    ``,
    `Current diff:\n${trimmed}`,
    ``,
    `Reviewer feedback to address:`,
    feedbackBlock,
    ``,
    `Instructions:`,
    `- Apply the changes that address the feedback directly to the working tree.`,
    `- Stay within the scope of the original PR.`,
    `- If the feedback is unactionable, leave the working tree unchanged.`,
  ].join("\n");
}

function buildIssueQueryPrompt(query: string): string {
  const categories = ISSUE_CATEGORIES.join(" | ");
  return [
    `You are filing a GitHub issue for the 'ash' project`,
    `(a fully P2P distributed AI coding agent CLI written in TypeScript/Node.js).`,
    ``,
    `User query: ${query}`,
    ``,
    `Inspect the source files in this directory to determine whether the query`,
    `describes a real problem or improvement that exists in the current code.`,
    ``,
    `Verdict rules:`,
    `- create: you found concrete evidence in the code that supports the query.`,
    `- reject: the query is unsupported, vague, already addressed, or out of scope.`,
    ``,
    `For 'create', list every file path you cite in EVIDENCE using 'path:lineno'`,
    `relative to the repo root. Each path must exist; otherwise output 'reject'.`,
    ``,
    `Output format (exact — no other text):`,
    `VERDICT: create | reject`,
    `TITLE: <concise issue title>`,
    `LABEL: <one of: ${categories}>`,
    `EVIDENCE:`,
    `- <path/to/file.ts>:<lineno>`,
    `- <path/to/other.ts>:<lineno>`,
    `---`,
    `<markdown body: problem description, expected behavior, affected files>`,
  ].join("\n");
}

interface ParsedQueryIssue {
  verdict: "create" | "reject";
  title: string;
  label: string;
  evidence: string[];
  body: string;
}

function parseIssueQueryOutput(text: string): ParsedQueryIssue | null {
  const v = text.match(/^VERDICT:\s*(create|reject)\s*$/m);
  if (!v) return null;
  const verdict = v[1] as "create" | "reject";
  if (verdict === "reject") {
    return { verdict, title: "", label: "", evidence: [], body: "" };
  }
  const title = text.match(/^TITLE:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const label = text.match(/^LABEL:\s*(\w+)$/m)?.[1]?.trim() ?? "";
  const evIdx = text.indexOf("\nEVIDENCE:");
  const sepIdx = text.indexOf("\n---\n");
  if (evIdx < 0 || sepIdx < 0 || sepIdx < evIdx) return null;
  const evBlock = text.slice(evIdx + "\nEVIDENCE:".length, sepIdx);
  const evidence = evBlock
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter((l) => l.length > 0);
  const body = text.slice(sepIdx + 5).trim();
  if (!title || !label || !body || evidence.length === 0) return null;
  return { verdict, title, label, evidence, body };
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
  log: Logger;
}): Promise<void> {
  const { myPub, privKey, taskId, githubRef, action, amount, url, extra, log } = opts;
  const nonce = await getNextNonce(myPub);
  const selfEarn = await buildSelfSignedEarn(myPub, privKey, taskId, amount, nonce);

  log(`  ${D}broadcasting mine:claim…${R}\n`);
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
  log(`  ${GR}✓${R}  ${B}+${amount} credits${R}${extraNote}\n`);
}

// ---------------------------------------------------------------------------
// Action executors
// ---------------------------------------------------------------------------

async function doPrCreate(
  issue: GitHubIssue,
  token: string,
  myPub: string,
  privKey: import("node:crypto").KeyObject,
  ghLogin: string,
  ghEmail: string,
  log: Logger,
): Promise<boolean> {
  log(`\n  ${B}[pr_create]${R} #${issue.number} ${issue.title}\n`);
  log(`  ${D}${"─".repeat(56)}${R}\n`);

  const tmpDir = await mkdtemp(join(tmpdir(), "ash-mine-"));
  try {
    log(`  ${D}cloning Doheon/ash…${R}\n`);
    await git(["clone", "--depth=1", `https://github.com/${ASH_REPO}.git`, tmpDir]);

    log(`  ${CY}deciding implement vs close…${R}\n`);
    const { code: vcode, text: vtext } = await runAgentCapture(buildPrCreateVerdictPrompt(issue), tmpDir);
    log(`  ${D}agent exit: ${vcode}${R}\n`);
    const verdict = parsePrCreateVerdict(vtext);

    if (!verdict) {
      log(`  ${YL}⚠${R}  Could not parse verdict. Skipping.\n`);
      return false;
    }

    if (verdict.verdict === "close") {
      const body = `${CLOSE_REC_MARKER}\n${verdict.reason || "Recommend closing this issue."}\n\n---\n*Tagged: \`${MINE_LABEL}\`*`;
      const comment = await addIssueComment(ASH_REPO, issue.number, body, token);
      log(`  ${GR}✓${R}  Close recommended: ${comment.html_url}\n`);
      await earnCredits({
        myPub, privKey,
        taskId: `github:close-rec:issue:${ASH_REPO}:${issue.number}:${myPub}`,
        githubRef: `close-rec:issue:${ASH_REPO}:${issue.number}`,
        action: "pr_create_close_rec",
        amount: MINE_CREDITS.pr_create_close_rec,
        url: issue.html_url,
        log,
      });
      return true;
    }

    log(`  ${D}forking Doheon/ash…${R}\n`);
    const fork = await ensureFork(ASH_REPO, token);

    const branch = `ash-mine/issue-${issue.number}`;
    await git(["config", "user.name", ghLogin], tmpDir);
    await git(["config", "user.email", ghEmail], tmpDir);
    await git(["checkout", "-b", branch], tmpDir);

    log(`  ${CY}running agent…${R}\n`);
    const code = await runAgentInteractive(buildCreatePrompt(issue), tmpDir, (l) => log(`  ${D}${l}${R}\n`));
    log(`\n  ${D}agent exit: ${code}${R}\n`);

    const diffStat = await git(["diff", "--stat", "HEAD"], tmpDir).catch(() => "");
    if (!diffStat.trim()) {
      log(`  ${YL}⚠${R}  No changes produced. Skipping.\n`);
      return false;
    }
    log(`\n${diffStat}\n`);

    const freshPRs = await fetchOpenPRs(ASH_REPO, token);
    const alreadyLinked = freshPRs.some((p) => {
      const text = `${p.title} ${p.body ?? ""}`;
      return [...text.matchAll(/#(\d+)/g)].some((m) => parseInt(m[1]!, 10) === issue.number);
    });
    if (alreadyLinked) {
      log(`  ${YL}⚠${R}  A PR for #${issue.number} was created by another peer. Skipping.\n`);
      return false;
    }

    await git(["add", "-A"], tmpDir);
    await git(["commit", "-m", `fix: ${issue.title}\n\nResolves #${issue.number}\n\nImplemented via ash mine`], tmpDir);

    log(`  ${D}pushing…${R}\n`);
    await pushBranch(tmpDir, branch, fork.clone_url, token);

    const prBody = `Resolves #${issue.number}\n\n---\n*Implemented by [ash mine](https://github.com/Doheon/ash).*`;
    const [owner] = fork.full_name.split("/");
    const pr = await createPR(ASH_REPO, `fix: ${issue.title}`, prBody, `${owner}:${branch}`, "main", token);
    await addLabels(ASH_REPO, pr.number, [MINE_LABEL], token).catch(() => undefined);
    log(`\n  ${GR}✓${R}  PR created: ${pr.html_url}\n`);

    const testsChanged = hasTestChanges(diffStat);
    const amount = MINE_CREDITS.pr_create + (testsChanged ? TEST_BONUS : 0);
    await earnCredits({
      myPub, privKey,
      taskId: `github:pr:${ASH_REPO}:${pr.number}`,
      githubRef: `pr:${ASH_REPO}:${pr.number}`,
      action: "pr_create", amount,
      url: pr.html_url,
      extra: testsChanged ? "includes test bonus" : undefined,
      log,
    });
    return true;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function doPrReview(
  pr: GitHubPR,
  token: string,
  myPub: string,
  privKey: import("node:crypto").KeyObject,
  log: Logger,
): Promise<boolean> {
  log(`\n  ${B}[pr_review]${R} #${pr.number} ${pr.title}\n`);
  log(`  ${D}${"─".repeat(56)}${R}\n`);

  log(`  ${D}fetching diff…${R}\n`);
  const diff = await fetchPRDiff(ASH_REPO, pr.number, token);

  const tmpDir = await mkdtemp(join(tmpdir(), "ash-review-"));
  try {
    log(`  ${CY}running agent…${R}\n`);
    const { code, text } = await runAgentCapture(buildReviewPrompt(pr, diff), tmpDir);
    log(`  ${D}agent exit: ${code}${R}\n`);

    const parsed = parseReviewVerdict(text);
    if (!parsed) {
      log(`  ${RD}✗${R}  Could not parse verdict. Skipping.\n`);
      return false;
    }
    log(`  ${D}verdict: ${B}${parsed.verdict}${R}\n`);
    log(`  ${D}${parsed.body.slice(0, 160)}…${R}\n\n`);

    if (parsed.verdict === "approve") {
      const review = await createPRReview(ASH_REPO, pr.number, parsed.body, "APPROVE", token);
      log(`  ${GR}✓${R}  Approved: ${review.html_url}\n`);
      await earnCredits({
        myPub, privKey,
        taskId: `github:approve:${ASH_REPO}:${pr.number}:${review.id}`,
        githubRef: `approve:${ASH_REPO}:${pr.number}`,
        action: "pr_review_approve",
        amount: MINE_CREDITS.pr_review_approve,
        url: review.html_url,
        log,
      });
      return true;
    }

    if (parsed.verdict === "changes_requested") {
      const review = await createPRReview(ASH_REPO, pr.number, parsed.body, "REQUEST_CHANGES", token);
      log(`  ${GR}✓${R}  Changes requested: ${review.html_url}\n`);
      await earnCredits({
        myPub, privKey,
        taskId: `github:review:${ASH_REPO}:${pr.number}:${review.id}`,
        githubRef: `review:${ASH_REPO}:${pr.number}`,
        action: "pr_review_changes_requested",
        amount: MINE_CREDITS.pr_review_changes_requested,
        url: review.html_url,
        log,
      });
      return true;
    }

    // close_recommend
    const body = `${CLOSE_REC_MARKER}\n${parsed.body}\n\n---\n*Tagged: \`${MINE_LABEL}\`*`;
    const review = await createPRReview(ASH_REPO, pr.number, body, "COMMENT", token);
    log(`  ${GR}✓${R}  Close recommended: ${review.html_url}\n`);
    await earnCredits({
      myPub, privKey,
      taskId: `github:close-rec:pr:${ASH_REPO}:${pr.number}:${myPub}`,
      githubRef: `close-rec:pr:${ASH_REPO}:${pr.number}`,
      action: "pr_review_close_rec",
      amount: MINE_CREDITS.pr_review_close_rec,
      url: review.html_url,
      log,
    });
    return true;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function doPrFix(
  pr: GitHubPR,
  mode: "self" | "feedback",
  feedback: GitHubReview[],
  token: string,
  myPub: string,
  privKey: import("node:crypto").KeyObject,
  ghLogin: string,
  ghEmail: string,
  log: Logger,
): Promise<boolean> {
  log(`\n  ${B}[pr_fix:${mode}]${R} #${pr.number} ${pr.title}\n`);
  log(`  ${D}${"─".repeat(56)}${R}\n`);

  const headRepo = pr.head.repo?.full_name;
  if (!headRepo) {
    log(`  ${YL}⚠${R}  PR head repo missing (deleted fork?). Skipping.\n`);
    return false;
  }
  const headCloneUrl = `https://github.com/${headRepo}.git`;
  const branch = pr.head.ref;

  log(`  ${D}fetching diff…${R}\n`);
  const diff = await fetchPRDiff(ASH_REPO, pr.number, token);

  const tmpDir = await mkdtemp(join(tmpdir(), "ash-fix-"));
  try {
    log(`  ${D}cloning ${headRepo}#${branch}…${R}\n`);
    const authedUrl = headCloneUrl.replace("https://", `https://oauth2:${token}@`);
    await git(["clone", "--depth=20", "--branch", branch, authedUrl, tmpDir]);
    await git(["config", "user.name", ghLogin], tmpDir);
    await git(["config", "user.email", ghEmail], tmpDir);

    const prompt = mode === "feedback"
      ? buildFixFeedbackPrompt(pr, diff, feedback)
      : buildFixSelfPrompt(pr, diff);

    log(`  ${CY}running agent…${R}\n`);
    const code = await runAgentInteractive(prompt, tmpDir, (l) => log(`  ${D}${l}${R}\n`));
    log(`\n  ${D}agent exit: ${code}${R}\n`);

    const diffStat = await git(["diff", "--stat", "HEAD"], tmpDir).catch(() => "");
    if (!diffStat.trim()) {
      log(`  ${YL}⚠${R}  No changes produced. Skipping.\n`);
      return false;
    }
    log(`\n${diffStat}\n`);

    await git(["add", "-A"], tmpDir);
    const subject = mode === "feedback"
      ? `chore: ${FIX_MARKER} address review feedback`
      : `chore: ${FIX_MARKER} self-review improvements`;
    await git(["commit", "-m", subject], tmpDir);

    log(`  ${D}pushing…${R}\n`);
    await pushBranch(tmpDir, branch, headCloneUrl, token);

    const sha = await git(["rev-parse", "HEAD"], tmpDir);

    const action: MineAction = mode === "feedback" ? "pr_fix_feedback" : "pr_fix_self";
    await earnCredits({
      myPub, privKey,
      taskId: `github:fix:${ASH_REPO}:${pr.number}:${sha}`,
      githubRef: `fix:${ASH_REPO}:${pr.number}`,
      action,
      amount: MINE_CREDITS[action],
      url: pr.html_url,
      log,
    });
    return true;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function doIssueQuery(
  query: string,
  token: string,
  myPub: string,
  privKey: import("node:crypto").KeyObject,
  log: Logger,
): Promise<boolean> {
  log(`\n  ${B}[issue:query]${R} ${query}\n`);
  log(`  ${D}${"─".repeat(56)}${R}\n`);

  const tmpDir = await mkdtemp(join(tmpdir(), "ash-mine-issue-"));
  try {
    log(`  ${D}cloning Doheon/ash…${R}\n`);
    await git(["clone", "--depth=1", `https://github.com/${ASH_REPO}.git`, tmpDir]);

    log(`  ${CY}running agent…${R}\n`);
    const { code, text } = await runAgentCapture(buildIssueQueryPrompt(query), tmpDir);
    log(`  ${D}agent exit: ${code}${R}\n`);

    const parsed = parseIssueQueryOutput(text);
    if (!parsed) {
      log(`  ${YL}⚠${R}  Could not parse output. Skipping.\n`);
      return false;
    }
    if (parsed.verdict === "reject") {
      log(`  ${YL}⚠${R}  Agent rejected the query. No issue created.\n`);
      return false;
    }

    for (const ev of parsed.evidence) {
      const path = ev.split(":")[0]!;
      try {
        await access(join(tmpDir, path));
      } catch {
        log(`  ${RD}✗${R}  evidence verification failed: ${path}\n`);
        return false;
      }
    }

    const fullBody = `${parsed.body}\n\n---\n*Reported via ash mine: "${query}"*`;
    log(`  ${D}opening issue: ${B}${parsed.title}${R}\n`);
    const issue = await createIssue(ASH_REPO, parsed.title, fullBody, [parsed.label, MINE_LABEL], token);
    log(`  ${GR}✓${R}  Issue created: ${issue.html_url}\n`);

    await earnCredits({
      myPub, privKey,
      taskId: `github:issue:${ASH_REPO}:${issue.number}`,
      githubRef: `issue:${ASH_REPO}:${issue.number}`,
      action: "issue_create",
      amount: MINE_CREDITS.issue_create,
      url: issue.html_url,
      log,
    });
    return true;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Context loaders
// ---------------------------------------------------------------------------

async function loadCommonContext(): Promise<MineContext | null> {
  const cfg = await loadConfig();
  const token = cfg.githubToken ?? process.env.GITHUB_TOKEN;
  if (!token) {
    const t = await input({ message: "GitHub personal access token (repo scope):" });
    await saveConfig({ githubToken: t.trim() });
    return loadCommonContext();
  }
  if (!cfg.pubkey) throw new Error("Not initialized. Run: ash init");
  const { priv: privKey } = await loadIdentity();
  const myPub = cfg.pubkey;

  const ghUser = await fetchCurrentUser(token);
  const ghEmail = ghUser.email ?? `${ghUser.login}@users.noreply.github.com`;
  return { token, myPub, privKey, ghLogin: ghUser.login, ghEmail };
}

/**
 * Like loadCommonContext but throws instead of prompting — safe to call from TUI.
 * Returns an error string on failure, or the context on success.
 */
export async function loadMineContext(): Promise<MineContext | { error: string }> {
  const cfg = await loadConfig();
  const token = cfg.githubToken ?? process.env.GITHUB_TOKEN;
  if (!token) return { error: "no GitHub token — run: ash set github-token <PAT>" };
  if (!cfg.pubkey) return { error: "not initialized — run: ash init" };
  try {
    const { priv: privKey } = await loadIdentity();
    const ghUser = await fetchCurrentUser(token);
    const ghEmail = ghUser.email ?? `${ghUser.login}@users.noreply.github.com`;
    return { token, myPub: cfg.pubkey, privKey, ghLogin: ghUser.login, ghEmail };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Exported core runners (accept a logger — usable from TUI or CLI)
// ---------------------------------------------------------------------------

export async function runMineCore(
  ctx: MineContext,
  opts: { count: number },
  log: Logger,
): Promise<void> {
  const { token, myPub, privKey, ghLogin, ghEmail } = ctx;

  log(`\n  ${B}${CY}ash mine${R}  ${D}· up to ${opts.count} task(s)  · @${ghLogin}${R}\n\n`);

  let done = 0;
  while (done < opts.count) {
    const decision = await selectAction(token, ghLogin, log);

    if (decision.action === "idle") {
      log(`  ${YL}⚠${R}  ${decision.reason}\n\n`);
      break;
    }

    log(`  ${D}selected action: ${B}${decision.action}${R}\n`);

    try {
      let acted = false;
      if (decision.action === "pr_fix") {
        acted = await doPrFix(decision.pr, decision.mode, decision.feedback, token, myPub, privKey, ghLogin, ghEmail, log);
      } else if (decision.action === "pr_review") {
        acted = await doPrReview(decision.pr, token, myPub, privKey, log);
      } else if (decision.action === "pr_create") {
        acted = await doPrCreate(decision.issue, token, myPub, privKey, ghLogin, ghEmail, log);
      }
      if (!acted) break;
      done++;
      log(`  ${D}${"─".repeat(56)}${R}\n`);
    } catch (err) {
      log(`  ${YL}⚠${R}  ${(err as Error).message}\n`);
      break;
    }
  }

  log(`\n  ${GR}✓${R}  Done: ${done} task(s) completed\n\n`);
}

export async function runIssueQueryCore(
  ctx: MineContext,
  query: string,
  log: Logger,
): Promise<void> {
  const { token, myPub, privKey, ghLogin } = ctx;

  log(`\n  ${B}${CY}ash mine${R}  ${D}· query mode  · @${ghLogin}${R}\n`);

  try {
    await doIssueQuery(query, token, myPub, privKey, log);
  } catch (err) {
    log(`  ${YL}⚠${R}  ${(err as Error).message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Command export
// ---------------------------------------------------------------------------

export const mineCommand = new Command("mine")
  .description("Earn credits by contributing to the ash GitHub repo")
  .argument("[query]", "Specific bug or feature to propose (skips auto cycle)")
  .option("-n, --count <n>", "Number of tasks per run (auto cycle only)", (v) => parseInt(v, 10), 1)
  .action(async (query: string | undefined, options) => {
    try { await ensureInitialized(); }
    catch (err) {
      if (err instanceof NotInitializedError) {
        console.error(`\nerror: ${err.reason}\n  → ${err.hint}\n`);
        process.exit(2);
      }
      throw err;
    }
    const ctx = await loadCommonContext();
    if (!ctx) return;
    const trimmed = query?.trim();
    const run = trimmed
      ? runIssueQueryCore(ctx, trimmed, cliOut)
      : runMineCore(ctx, { count: options.count as number }, cliOut);
    await run.catch((err: Error) => {
      console.error(`\nerror: ${err.message}\n`);
      process.exit(1);
    });
    await closeLocalStore().catch(() => undefined);
  });
