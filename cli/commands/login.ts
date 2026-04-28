import { Command } from "commander";
import { input, select } from "@inquirer/prompts";
import { loadAgent, loadConfig, saveConfig } from "../client.ts";
import { ensureAgentLoggedIn, refreshAgentCredentials } from "./init.ts";
import { fetchCurrentUser } from "../../core/github/client.ts";
import type { AgentType } from "../../shared/types.ts";

const VALID_AGENTS: AgentType[] = ["claude", "codex"];

async function runGitHubLogin(): Promise<void> {
  const cfg = await loadConfig();
  const existing = cfg.githubToken;
  if (existing) {
    const user = await fetchCurrentUser(existing).catch(() => null);
    if (user) {
      console.log(`\n  Already logged in as @${user.login}. Re-enter token to replace.\n`);
    }
  }

  const token = (await input({ message: "GitHub personal access token (repo scope):" })).trim();
  if (!token) {
    console.error("\nerror: token cannot be empty\n");
    process.exit(1);
  }

  const user = await fetchCurrentUser(token).catch(() => null);
  if (!user) {
    console.error("\nerror: token is invalid or lacks repo scope\n");
    process.exit(1);
  }

  await saveConfig({ githubToken: token });
  console.log(`\n  Logged in as @${user.login}\n`);
}

async function runLogin(agentArg?: string): Promise<void> {
  if (agentArg === "github") {
    await runGitHubLogin();
    return;
  }

  let agent: AgentType;
  if (agentArg) {
    if (!VALID_AGENTS.includes(agentArg as AgentType)) {
      console.error(`\nerror: unknown agent "${agentArg}". Choose: claude, codex, github\n`);
      process.exit(1);
    }
    agent = agentArg as AgentType;
  } else {
    const choice = await select({
      message: "Which account to log in?",
      choices: [
        { name: "Claude Code  (claude.ai account)", value: "claude" },
        { name: "Codex        (OpenAI account)",    value: "codex"  },
        { name: "GitHub       (personal access token for mine)", value: "github" },
      ],
      default: await loadAgent(),
    });
    if (choice === "github") {
      await runGitHubLogin();
      return;
    }
    agent = choice as AgentType;
  }

  await ensureAgentLoggedIn(agent);
  await refreshAgentCredentials(agent);
  console.log(`\n  Done. Run: ash serve\n`);
}

export const loginCommand = new Command("login")
  .description("Log in to Claude Code, Codex, or GitHub")
  .argument("[agent]", "claude, codex, or github")
  .action(async (agent?: string) => {
    try { await runLogin(agent); }
    catch (err) {
      console.error(`\nerror: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });
