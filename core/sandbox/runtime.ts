import { loadConfig, saveConfig } from "../../cli/client.ts";
import { spawn } from "../util/spawn.ts";

export type ContainerRuntime = "podman" | "docker";

async function isInstalled(cmd: string): Promise<boolean> {
  try {
    const proc = spawn([cmd, "--version"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function detectAvailable(): Promise<{ podman: boolean; docker: boolean }> {
  const [podman, docker] = await Promise.all([isInstalled("podman"), isInstalled("docker")]);
  return { podman, docker };
}

export async function loadRuntime(): Promise<ContainerRuntime | null> {
  const config = await loadConfig();
  return config.runtime ?? null;
}

export async function saveRuntime(runtime: ContainerRuntime): Promise<void> {
  await saveConfig({ runtime });
}

export async function getRuntime(): Promise<ContainerRuntime> {
  const saved = await loadRuntime();
  if (saved) return saved;
  const { podman, docker } = await detectAvailable();
  if (podman) return "podman";
  if (docker) return "docker";
  throw new Error("No container runtime found. Run: ash setup");
}
