import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { getRuntime, type ContainerRuntime } from "./runtime.ts";
import { spawn } from "../util/spawn.ts";

const IMAGE_NAME = "agent-share-sandbox";
const IMAGE_TAG  = "latest";
const FULL_IMAGE = `${IMAGE_NAME}:${IMAGE_TAG}`;

const CONTAINERFILE = `
FROM alpine:3.19

RUN apk add --no-cache git curl bash nodejs npm && \
    apk upgrade --no-cache

# Install AI agents (versions pinned to avoid supply-chain drift; bump deliberately)
RUN npm install -g --ignore-scripts --no-fund --no-audit \
    @anthropic-ai/claude-code@1.9.1 \
    @openai/codex@0.1.2505161818

# Create workspace directory
RUN mkdir -p /workspace
WORKDIR /workspace

# Create non-root user
RUN adduser -D -u 1000 sandboxuser
USER sandboxuser

# Default git config (required for diff extraction)
RUN git config --global user.email "sandbox@agent-share" && \\
    git config --global user.name "Sandbox"

ENTRYPOINT ["/bin/sh", "-c"]
`.trim();

async function runCli(
  runtime: ContainerRuntime,
  ...args: string[]
): Promise<{ success: boolean; output: string }> {
  const proc = spawn([runtime, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, proc.stdout, proc.stderr]);
  const success = exitCode === 0;
  return { success, output: success ? stdout : stderr };
}

export async function imageExists(): Promise<boolean> {
  const runtime = await getRuntime();
  const { success } = await runCli(runtime, "image", "inspect", FULL_IMAGE);
  return success;
}

export async function buildImage(): Promise<void> {
  const runtime = await getRuntime();
  const tmpDir = await mkdtemp(join(tmpdir(), "agent-share-build-"));
  const containerfilePath = join(tmpDir, "Containerfile");

  try {
    await writeFile(containerfilePath, CONTAINERFILE);
    console.log(`Building ${FULL_IMAGE} image...`);

    const proc = spawn(
      [runtime, "build", "-t", FULL_IMAGE, "-f", containerfilePath, tmpDir],
      { stdout: "inherit", stderr: "inherit" },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`Failed to build image using ${runtime}.`);

    console.log(`${FULL_IMAGE} image build complete`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function ensureImage(): Promise<void> {
  if (!(await imageExists())) await buildImage();
}

export { FULL_IMAGE };
