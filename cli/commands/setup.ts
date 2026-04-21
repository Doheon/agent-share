/**
 * ash setup — environment check (runtime, sandbox image, ~/.ash/ writable).
 * No remote server in the P2P architecture; nothing to ping.
 */

import { Command } from "commander";
import { select, confirm } from "@inquirer/prompts";
import { join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { ASH_DIR } from "../ash_dir.ts";
import { imageExists, buildImage } from "../../core/sandbox/image.ts";
import { saveRuntime, type ContainerRuntime } from "../../core/sandbox/runtime.ts";
import { spawn } from "../../core/util/spawn.ts";



async function runCommand(cmd: string, args: string[]): Promise<{ success: boolean; output: string }> {
  try {
    const proc = spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    const [exit, out, err] = await Promise.all([proc.exited, proc.stdout, proc.stderr]);
    return { success: exit === 0, output: (exit === 0 ? out : err).trim() };
  } catch { return { success: false, output: "Executable not found" }; }
}

async function runCommandInherit(cmd: string, args: string[]): Promise<boolean> {
  try {
    const proc = spawn([cmd, ...args], { stdout: "inherit", stderr: "inherit" });
    return (await proc.exited) === 0;
  } catch { return false; }
}

const ok   = (l: string, d = "") => console.log(`  ✓ ${l}${d ? `  (${d})` : ""}`);
const fail = (l: string, h = "") => console.log(`  ✗ ${l}${h ? `\n     → ${h}` : ""}`);
const warn = (l: string, h = "") => console.log(`  ⚠  ${l}${h ? `\n     → ${h}` : ""}`);

const isMac = () => process.platform === "darwin";

export async function runSetup(daemon: boolean, yes = false): Promise<void> {
  console.log("\n  Checking environment...\n");
  let allOk = true;

  // git
  const git = await runCommand("git", ["--version"]);
  git.success ? ok("git", git.output) : (fail("git not installed", "Install from https://git-scm.com/downloads"), allOk = false);

  // runtime
  const [pod, doc] = await Promise.all([
    runCommand("podman", ["--version"]),
    runCommand("docker", ["--version"]),
  ]);
  let runtime: ContainerRuntime | null = null;
  if (pod.success) {
    runtime = "podman"; await saveRuntime(runtime); ok("podman", pod.output);
    if (doc.success) warn("docker also found", "podman selected (rootless preferred)");
  } else if (doc.success) {
    runtime = "docker"; await saveRuntime(runtime); ok("docker", doc.output);
  } else {
    const choice = yes ? "podman" : await select({
      message: "No container runtime found. Install?",
      choices: [{ name: "podman", value: "podman" as const }, { name: "docker", value: "docker" as const }, { name: "skip", value: "skip" as const }],
    });
    if (choice !== "skip") {
      if (isMac() && (await runCommand("brew", ["--version"])).success) {
        const c = yes || await confirm({ message: `Install ${choice} via Homebrew?` });
        if (c) {
          await runCommandInherit("brew", choice === "docker" ? ["install", "--cask", "docker"] : ["install", "podman"]);
          const check = await runCommand(choice, ["--version"]);
          if (check.success) { runtime = choice; await saveRuntime(runtime); ok(`${choice} installed`); }
          else { fail(`${choice} install failed`); allOk = false; }
        } else { fail(`${choice} not installed`); allOk = false; }
      } else {
        fail(`${choice} not installed`, `Please install ${choice} manually`);
        allOk = false;
      }
    } else {
      warn("no container runtime", "serve mode will not work");
    }
  }

  if (runtime === "podman" && isMac()) {
    const machine = await runCommand("podman", ["machine", "list", "--format", "{{.Running}}"]);
    if (machine.success && machine.output.includes("true")) {
      ok("podman machine running");
    } else if (!yes) {
      const c = await confirm({ message: "podman machine is not running. Start it now?" });
      if (c) {
        const list = await runCommand("podman", ["machine", "list", "--format", "{{.Name}}"]);
        if (!list.output.trim()) await runCommandInherit("podman", ["machine", "init"]);
        const started = await runCommandInherit("podman", ["machine", "start"]);
        started ? ok("podman machine started") : (fail("podman machine start failed"), allOk = false);
      } else {
        warn("podman machine not running");
      }
    }
  }
  if (runtime === "docker") {
    const d = await runCommand("docker", ["info"]);
    d.success ? ok("docker daemon running") : warn("docker daemon not running", "Start Docker Desktop");
  }

  // sandbox image
  if (runtime !== null) {
    if (await imageExists()) {
      ok("agent-share-sandbox image");
    } else {
      console.log("  Building sandbox image...");
      try { await buildImage(); ok("sandbox image built"); }
      catch (err) { fail("image build failed", (err as Error).message); allOk = false; }
    }
  }

  // ~/.ash writable
  try {
    await mkdir(ASH_DIR, { recursive: true });
    const t = join(ASH_DIR, ".write-test");
    await writeFile(t, "x"); await rm(t);
    ok(`${ASH_DIR} is writable`);
  } catch { fail(`${ASH_DIR} is not writable`); allOk = false; }

  console.log(allOk ? "\n✓ All environment checks passed.\n" : "\n⚠  Some items need attention.\n");
  if (daemon) warn("--daemon is not yet supported in the self-hosted architecture");
}

export const setupCommand = new Command("setup")
  .description("Check environment setup")
  .option("--daemon", "(reserved)")
  .option("-y, --yes", "Skip all confirmation prompts")
  .action(async (options) => {
    try { await runSetup(options.daemon ?? false, options.yes ?? false); }
    catch (err) { console.error(`\nerror: ${(err as Error).message}\n`); process.exit(1); }
  });
