# agentshare

> AI 코딩 에이전트 구독의 유휴 시간을 커뮤니티와 공유하는 오픈소스 플랫폼

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Deno](https://img.shields.io/badge/Runtime-Deno_2.x-black?logo=deno)](https://deno.com)

---

## 왜 만들었나?

Claude Code $20 플랜은 **5시간 세션 제한**이 있습니다. 다음 플랜은 $100입니다.

평일 낮에는 AI 도구를 거의 안 씁니다. 주말에는 집중해서 쓰고 싶습니다.

**agentshare**는 이 불균형을 해결합니다.

- 평일 유휴 시간에 **수락자**로 참여 → 크레딧 적립
- 주말 집중 코딩 시 적립한 크레딧으로 **타인의 유휴 시간** 사용
- 결과: $20 플랜으로 $100 플랜 수준의 유연성 확보

Claude Code에 한정되지 않습니다. opencode, 로컬 모델 등 어떤 AI 에이전트든 사용 가능합니다.

---

## 동작 방식

```
요청자                          서버 (Supabase)              수락자
  │                                  │                          │
  ├─ 코드 암호화 (AES-256-GCM) ──►  │                          │
  ├─ 업로드 + 작업 등록 ──────────►  │                          │
  │                                  │ ◄── 작업 수락 ───────────┤
  │                                  │     에스크로 처리         │
  │                                  │                          ├─ 복호화
  │                                  │                          ├─ Podman 컨테이너 실행
  │                                  │                          ├─ AI 에이전트 작업
  │                                  │                          ├─ git diff 추출
  │                                  │ ◄── diff 업로드 ─────────┤
  │ ◄── diff 수신 알림 ─────────────  │                          │
  ├─ diff 리뷰                        │                          │
  ├─ 승인 ────────────────────────►  │                          │
  │                                  ├─ 크레딧 지급 ────────────►│
```

---

## 보안

- **E2EE**: 코드는 AES-256-GCM으로 암호화 전송. 서버는 평문을 볼 수 없음
- **Podman rootless**: 에이전트는 OS 수준 격리 컨테이너에서 실행
  - `--cap-drop=ALL`: 모든 Linux capability 제거
  - `--read-only`: 컨테이너 루트 파일시스템 읽기 전용
  - `--env-host=false`: 수락자 환경변수 완전 차단
- **경로 검증**: tar 언팩 시 symlink · path traversal 즉시 거부
- **소스코드 노출 고지**: 수락자가 코드를 볼 수 있음을 명시적으로 고지

> ⚠️ **주의**: 수락자는 작업 코드를 평문으로 열람할 수 있습니다.
> 회사 코드 · NDA 대상 코드는 사용자 본인의 책임으로 판단하세요.

---

## 설치

```bash
# Deno 설치 (https://deno.com)
curl -fsSL https://deno.land/install.sh | sh

# 소스에서 바이너리 빌드
git clone https://github.com/your-org/agentshare
cd agentshare
deno task build

# 또는 릴리즈 바이너리 다운로드 (런타임 불필요)
curl -fsSL https://github.com/your-org/agentshare/releases/latest/download/ash-$(uname -s)-$(uname -m) -o ash
chmod +x ash
```

---

## 시작하기

### 1. 의존성 설치 및 초기화

```bash
ash setup
```

다음을 자동으로 확인하고 설정합니다:
- git, podman 설치 여부
- Podman rootless 및 machine 실행 여부 (macOS)
- sandbox 이미지 자동 빌드
- RSA 키쌍 생성 (`~/.agent-share/keys/`)

### 2. 수락자로 참여 (크레딧 적립)

```bash
# 평일 9시~18시에 자동으로 작업 수락
ash daemon start --schedule "mon-fri 09:00-18:00" --agent claude

# 언제나 실행
ash daemon start

# 데몬 상태 확인
ash daemon status

# 중지
ash daemon stop
```

### 3. 작업 요청 (크레딧 사용)

```bash
# 작업 등록
ash submit ./my-project --prompt "로그인 버튼 클릭 시 500 에러를 수정해줘" --credits 10

# 작업 목록 확인
ash list

# diff 수신 후 리뷰
ash review <task_id>

# 승인 (크레딧 지급)
ash approve <task_id>

# 거부 (크레딧 환불)
ash reject <task_id>
```

### 4. 잔액 및 통계

```bash
ash balance       # 크레딧 잔액
ash stats         # 개인 기여/사용 통계
ash leaderboard   # 기여자 랭킹
```

---

## 커맨드 목록

| 커맨드 | 설명 |
|--------|------|
| `signup` | 새 계정 생성 |
| `login` | 로그인 |
| `logout` | 로그아웃 |
| `setup` | 의존성 체크 및 초기화 |
| `submit <dir>` | 작업 요청 |
| `list` | 수락 가능한 작업 목록 |
| `accept <id>` | 단일 작업 수락 및 실행 |
| `daemon start/stop/status` | 데몬 모드 관리 |
| `review <id>` | diff 리뷰 |
| `approve <id>` | diff 승인 |
| `reject <id>` | diff 거부 |
| `balance` | 크레딧 잔액 |
| `stats` | 개인 통계 |
| `leaderboard` | 기여자 랭킹 |

---

## 환경변수

| 변수 | 설명 |
|------|------|
| `AGENT_SHARE_SUPABASE_URL` | Supabase 프로젝트 URL |
| `AGENT_SHARE_SUPABASE_ANON_KEY` | Supabase anon 키 |
| `ANTHROPIC_API_KEY` | Claude 에이전트 API 키 |

또는 `~/.agent-share/config.json` 파일로 설정:

```json
{
  "supabaseUrl": "https://xxx.supabase.co",
  "supabaseAnonKey": "eyJ..."
}
```

---

## 기여하기

PR과 이슈 환영합니다.

```bash
git clone https://github.com/your-org/agentshare
cd agentshare
deno task test
```

---

## 라이선스

[MIT](./LICENSE)
