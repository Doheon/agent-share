/**
 * ash set <model-tier> — switch the active model.
 */

import { Command } from "commander";
import { saveModelTier, loadModels } from "../client.ts";
import { ensureAgentLoggedIn } from "./init.ts";
import { ensureInitialized, NotInitializedError } from "../guard.ts";
import { modelToAgent } from "../../shared/types.ts";

export const setCommand = new Command("set")
  .description("Switch the model used by ash and ash serve")
  .argument("<model>", "model tier to activate")
  .action(async (modelArg: string) => {
    try { await ensureInitialized(); }
    catch (err) {
      if (err instanceof NotInitializedError) {
        console.error(`\nerror: ${err.reason}\n  → ${err.hint}\n`);
        process.exit(2);
      }
      throw err;
    }

    const models = await loadModels();
    const found = models.find((m) => m.tier === modelArg);
    if (!found) {
      console.error(`\nerror: unknown model "${modelArg}". Available: ${models.map((m) => m.tier).join(", ")}\n`);
      process.exit(2);
    }

    await ensureAgentLoggedIn(modelToAgent(modelArg));
    await saveModelTier(modelArg);
    console.log(`\n  model: ${modelArg}\n`);
  });
