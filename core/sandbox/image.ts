/**
 * agent-share-sandbox Podman 이미지 빌드 및 검증
 * 이미지: Alpine 기반 최소 이미지 (git + 에이전트 바이너리만 포함)
 */

const IMAGE_NAME = "agent-share-sandbox";
const IMAGE_TAG = "latest";
const FULL_IMAGE = `${IMAGE_NAME}:${IMAGE_TAG}`;

const CONTAINERFILE = `
FROM alpine:3.19

RUN apk add --no-cache git curl bash

# 작업 디렉토리 생성
RUN mkdir -p /workspace
WORKDIR /workspace

# 비root 사용자 생성
RUN adduser -D -u 1000 sandboxuser
USER sandboxuser

# 기본 git 설정 (diff 추출용)
RUN git config --global user.email "sandbox@agent-share" && \\
    git config --global user.name "Sandbox"

ENTRYPOINT ["/bin/sh", "-c"]
`.trim();

async function podman(...args: string[]): Promise<{ success: boolean; output: string }> {
  const cmd = new Deno.Command("podman", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { success, stdout, stderr } = await cmd.output();
  const output = new TextDecoder().decode(success ? stdout : stderr);
  return { success, output };
}

/** 이미지가 로컬에 존재하는지 확인 */
export async function imageExists(): Promise<boolean> {
  const { success } = await podman("image", "inspect", FULL_IMAGE);
  return success;
}

/** Containerfile로 이미지 빌드 */
export async function buildImage(): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "agent-share-build-" });
  const containerfilePath = `${tmpDir}/Containerfile`;

  try {
    await Deno.writeTextFile(containerfilePath, CONTAINERFILE);
    console.log(`🔨 ${FULL_IMAGE} 이미지를 빌드합니다...`);

    const cmd = new Deno.Command("podman", {
      args: ["build", "-t", FULL_IMAGE, "-f", containerfilePath, tmpDir],
      stdout: "inherit",
      stderr: "inherit",
    });

    const { success } = await cmd.output();
    if (!success) {
      throw new Error("Podman 이미지 빌드에 실패했습니다.");
    }

    console.log(`✅ ${FULL_IMAGE} 이미지 빌드 완료`);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

/** 이미지가 없으면 자동 빌드 */
export async function ensureImage(): Promise<void> {
  if (!(await imageExists())) {
    await buildImage();
  }
}

export { FULL_IMAGE };
