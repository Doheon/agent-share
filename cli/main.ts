/**
 * ash CLI entry point — pure P2P, no remote server.
 */

import { program, Command } from "commander";
import { serveCommand } from "./commands/serve.ts";
import { initCommand } from "./commands/init.ts";
import { loginCommand } from "./commands/login.ts";
import { setCommand } from "./commands/set.ts";
import { setupCommand } from "./commands/setup.ts";
import { mineCommand } from "./commands/mine.ts";
import { runCommand } from "./commands/run.ts";
import { adminCommand } from "./commands/admin.ts";
import { historyCommand } from "./commands/history.ts";
import { peersCommand } from "./commands/peers.ts";
import { hasIdentity, loadConfig, loadModelTier } from "./client.ts";
import { ensureInitialized, NotInitializedError } from "./guard.ts";
import { getLocalBalance, closeLocalStore } from "./p2p_state.ts";
import { CLIENT_VERSION } from "../shared/protocol.ts";
import { getAgentStatus, type AgentStatus } from "./commands/init.ts";
import { modelToAgent } from "../shared/types.ts";
import { warnIfUpdateAvailable } from "./update.ts";

function exitNotInitialized(err: NotInitializedError): never {
  console.error(`\nerror: ${err.reason}\n  → ${err.hint}\n`);
  process.exit(2);
}

program
  .name("ash")
  .version(CLIENT_VERSION)
  .description("Distributed AI coding agent network (peer-to-peer)")
  .option("--model <tier>", "Model tier for this session (overrides saved config)")
  .action(async (options: { model?: string }) => {
    try { await ensureInitialized(); }
    catch (err) {
      if (err instanceof NotInitializedError) exitNotInitialized(err);
      throw err;
    }
    const { runChat } = await import("./commands/chat.tsx");
    await runChat({ model: options.model });
  });

program.addCommand(initCommand);
program.addCommand(loginCommand);
program.addCommand(serveCommand);
program.addCommand(setCommand);
program.addCommand(setupCommand);
program.addCommand(mineCommand);
program.addCommand(runCommand);
program.addCommand(adminCommand);
program.addCommand(historyCommand);
program.addCommand(peersCommand);

program.addCommand(
  new Command("status")
    .description("Show local identity and credit balance")
    .action(async () => {
      try {
        if (!(await hasIdentity())) {
          console.log("\n  not initialized.  Run: ash init\n");
          return;
        }
        const cfg = await loadConfig();
        if (!cfg.pubkey || !cfg.username) {
          console.log("\n  identity exists but no username.  Run: ash init\n");
          return;
        }
        const balance = await getLocalBalance(cfg.pubkey);
        const modelTier = await loadModelTier();
        // Probe only the agent the user actually configured. Probing both
        // unconditionally sent stale tokens to whichever provider the
        // user hadn't logged into.
        const configuredAgent = cfg.agent ?? modelToAgent(modelTier);
        const probedStatus = await getAgentStatus(configuredAgent);
        const statusLabel = (s: AgentStatus) =>
          s === "valid"          ? "✓ ready" :
          s === "expired"        ? "✗ token expired   (run: ash login)" :
                                   "— not configured  (run: ash login)";
        const agentLabel = configuredAgent === "codex" ? "codex" : "claude code";
        console.log(
          `\n  ${cfg.username}  ·  ${balance.balance} credits  ·  ${modelTier}\n` +
          `  pubkey: ${cfg.pubkey}\n\n` +
          `  agent (${agentLabel}):  ${statusLabel(probedStatus)}\n`,
        );
      } catch (err) {
        console.error(`\nerror: ${(err as Error).message}\n`);
        process.exit(1);
      } finally {
        await closeLocalStore().catch(() => undefined);
      }
    }),
);

await warnIfUpdateAvailable();
await program.parseAsync();
