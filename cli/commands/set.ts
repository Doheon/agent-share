/**
 * ash set <key> [value] — update a local config value.
 *
 *   ash set <model-tier>          switch the active model
 *   ash set github-token <token>  save a GitHub PAT (repo scope)
 */

import { Command } from "commander";
import { input } from "@inquirer/prompts";
import { loadModels, saveModelTier, saveConfig } from "../client.ts";
import { ensureAgentLoggedIn } from "./init.ts";
import { ensureInitialized, NotInitializedError } from "../guard.ts";
import { modelToAgent } from "../../shared/types.ts";
import { fetchCurrentUser } from "../../core/github/client.ts";

async function setGithubToken(token?: string): Promise<void> {
  const raw = token ?? (await input({ message: "GitHub personal access token (repo scope):" })).trim();
  if (!raw) {
    console.error("\nerror: token cannot be empty\n");
    process.exit(1);
  }
  const user = await fetchCurrentUser(raw).catch(() => null);
  if (!user) {
    console.error("\nerror: token is invalid or lacks repo scope\n");
    process.exit(1);
  }
  await saveConfig({ githubToken: raw });
  console.log(`\n  GitHub: logged in as @${user.login}\n`);
}

export const setCommand = new Command("set")
  .description("Update a local config value (model tier or github-token)")
  .argument("<key>", "model tier (e.g. claude-sonnet) or 'github-token'")
  .argument("[value]", "value when key is 'github-token'")
  .action(async (key: string, value: string | undefined) => {
    if (key === "github-token") {
      await setGithubToken(value).catch((err: Error) => {
        console.error(`\nerror: ${err.message}\n`);
        process.exit(1);
      });
      return;
    }

    try { await ensureInitialized(); }
    catch (err) {
      if (err instanceof NotInitializedError) {
        console.error(`\nerror: ${err.reason}\n  → ${err.hint}\n`);
        process.exit(2);
      }
      throw err;
    }

    const models = await loadModels();
    const found = models.find((m) => m.tier === key);
    if (!found) {
      const tiers = models.map((m) => m.tier).join(", ");
      console.error(`\nerror: unknown key "${key}". Use a model tier (${tiers}) or 'github-token'\n`);
      process.exit(2);
    }

    await ensureAgentLoggedIn(modelToAgent(key));
    await saveModelTier(key);
    console.log(`\n  model: ${key}\n`);
  });
