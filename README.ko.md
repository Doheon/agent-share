# ash

[English](./README.md)

> 분산형 P2P AI 코딩 에이전트 네트워크 — 유휴 자원을 공유하고 크레딧을 획득, 완전 셀프호스팅.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Runtime: Node.js](https://img.shields.io/badge/Runtime-Node.js-green)](https://nodejs.org)

---

## ash는 왜 필요한가?

Claude Code $20 플랜은 **5시간 세션 제한**이 있습니다. 그 다음 티어는 월 $100입니다.

대부분의 개발자는 AI 도구를 매일 집중적으로 사용하지는 않습니다. **ash**는 유휴 시간에 코딩 작업을 수락해서 크레딧을 벌고, 필요할 때 그 크레딧으로 AI 지원 개발을 할 수 있게 해줍니다.

---

## 동작 방식

ash는 서버가 아닌 순수 피어투피어 네트워크입니다. 작업을 제출하면:

```
나 (요청자)              Hyperswarm DHT              피어 (수락자)
      │                      │                         │
      ├─ 프롬프트 + 코드 ────►│                         │
      │   (AES-256-GCM)       │ ◄─ peer:announce ─────┤
      │                       │                        │
      │ ◄─ RSA 공개키 ────────┼───────────────────────┤
      ├─ AES 키 (RSA-OAEP)──►│ ─────────────────────►│
      │                       │                 복호화 │
      │                       │                 AI 실행 │
      │ ◄─ git diff ──────────┼───────────────────────┤
      │   (AES-256-GCM)       │     정산 이벤트        │
      └─ 크레딧 적립          │                        │
```

**핵심 속성:**

- **종단간 암호화**: 코드와 diff는 AES-256-GCM으로 암호화. 피어들은 RSA-OAEP로 키 교환. 서버는 평문을 볼 수 없음.
- **서명된 append-only 로그**: 각 피어는 `~/.ash/corestore/`에 로컬 Ed25519 서명 Hypercore를 유지. 로그는 잔액 검증을 위해 P2P로 복제됨.
- **샌드박스 실행**: 수락자들은 rootless Podman 컨테이너 (`--cap-drop=ALL`, `--read-only`)에서 AI 에이전트 실행.
- **원자적 클레임**: 한 피어만 작업을 수락 가능. 정산은 원자적 — 수락자가 작업을 완료하면 크레딧 발급.

> **보안 주의**: 수락자는 샌드박스 내에서 코드를 평문으로 읽을 수 있습니다. 회사 코드나 NDA가 적용되는 코드는 제출하지 마세요.

---

## 설치

**필요:** Node.js 18+

```bash
npm install -g @doheon/ash
ash init
```

이 명령어는 `~/.ash/`에 Ed25519 키페어, Corestore, 설정을 생성합니다.

### 소스에서 설치

```bash
git clone https://github.com/Doheon/agent-share
cd agent-share
npm install
npm install -g .
ash init
```

---

## 빠른 시작

### 신원과 AI 에이전트 설정

```bash
ash init
```

다음을 입력합니다:
- 사용자명
- 선호 AI 에이전트 (Claude Code 또는 Codex)
- 환경 점검 (Podman/Docker, git 등)
- 에이전트 로그인 (인증 안내 포함)

### AI 에이전트 로그인

```bash
ash login
```

세 가지 프로바이더를 지원합니다:

| 프로바이더 | 방식 |
|-----------|------|
| **GitHub** | OAuth Device Flow — 브라우저를 열고 인가될 때까지 폴링 |
| **Claude Code** | `claude setup-token`으로 장기 토큰(`sk-ant-…`) 생성 후 입력 |
| **Codex** | `~/.ash/codex-session`에 격리된 세션 생성 |

TUI 안에서 `/login`으로도 로그인 가능합니다.

### 요청자 — AI 코딩 작업 의뢰

```bash
# 인터랙티브 채팅 모드 (TUI)
ash

# 또는 일회성 작업 제출
ash run "내 프로젝트에 TypeScript 타입 추가"
```

코드가 패키징되어 암호화되고 P2P 네트워크에 알려집니다. 피어가 수락하면:

1. 원자적으로 작업 클레임
2. AES 키 전송 (RSA-OAEP 경유)
3. 복호화 후 AI 에이전트 실행, git diff 추출
4. diff 암호화해서 되돌려받음
5. 승인/거절; 크레딧 정산

### 수락자 — 크레딧 획득

```bash
# 최대 5개 작업 수락 (기본 모델)
ash serve -n 5

# 무한정 수락
ash serve

# 자기 작업도 포함해서 수락 (로컬 테스트용)
ash serve --allow-self
```

작업이 가능하면:
1. 원자적으로 클레임
2. AES 키 수신
3. 코드 복호화
4. 샌드박스에서 AI 에이전트 실행
5. diff 추출 및 반송
6. 정산 크레딧 수신

### GitHub 기여로 크레딧 획득

```bash
# 자동 사이클: 우선순위가 가장 높은 액션 실행
ash mine

# 한 세션에 최대 N개 액션 실행
ash mine -n 3

# 쿼리 모드: 코드베이스에서 증거를 찾아 GitHub 이슈 등록
ash mine "history 커맨드가 mint 이벤트를 표시하지 않음"
```

**Mine 크레딧 표:**

| 액션 | 크레딧 |
|------|--------|
| 이슈 구현 → PR 생성 | 6 (테스트 추가 시 +3) |
| 이슈 종료 권고 | 2 |
| PR 리뷰 → 승인 | 2 |
| PR 리뷰 → 변경 요청 | 3 |
| PR 리뷰 → 종료 권고 | 2 |
| 자기 PR 자체 개선 | 4 |
| 리뷰어 피드백 반영 | 5 |
| 새 이슈 등록 (쿼리 모드) | 4 |

TUI 안에서 `/mine` 슬래시 커맨드로도 사용 가능합니다.

### 잔액 확인

```bash
ash status
```

사용자명, 크레딧 잔액, pubkey, 각 AI 에이전트의 로그인 상태를 표시합니다.

---

## 명령어

| 명령어 | 설명 |
|--------|------|
| `ash init` | 키페어, 사용자명, AI 에이전트 선택 |
| `ash` | 인터랙티브 채팅 모드 (TUI) |
| `ash run "<프롬프트>"` | 일회성 작업 제출 |
| `ash serve [-n N]` | 작업 수락 및 크레딧 획득 |
| `ash serve --allow-self` | 자기 작업도 포함 (테스트용) |
| `ash status` | 신원, 잔액, 에이전트 로그인 상태 표시 |
| `ash set <모델>` | 모델 티어 변경 (예: `claude-sonnet`) |
| `ash login [에이전트]` | GitHub, Claude Code, Codex 로그인 |
| `ash setup` | 환경 재점검 |
| `ash mine [-n N] [쿼리]` | GitHub 기여로 크레딧 획득 |
| `ash history [pubkey]` | earn/spend/mint 이벤트 히스토리 표시 |
| `ash peers` | 연결된 피어 및 잔액 목록 |

---

## TUI 슬래시 커맨드

인터랙티브 채팅(`ash`) 안에서:

| 커맨드 | 설명 |
|--------|------|
| `/serve [N]` | 서브 모드 진입 — 최대 N개 작업 수락 (생략 시 무제한) |
| `/mine [N]` 또는 `/mine "<쿼리>"` | mine 액션 실행 또는 GitHub 이슈 등록 |
| `/model [티어]` | 모델 인터랙티브 선택 또는 직접 변경 |
| `/new` | 대화 기록 초기화, 새 대화 시작 |
| `/status` | 계정 정보 표시 |
| `/peers` | 연결된 피어 목록 |
| `/history [pubkey]` | 이벤트 히스토리 표시 |
| `/login [에이전트]` | GitHub, Claude Code, Codex 로그인 |
| `/clear` | 채팅 스크롤백 초기화 |
| `/help` | 사용 가능한 커맨드 표시 |
| `/quit` | 종료 |

---

## 정책 (Policy)

경제 파라미터는 [`shared/policy.ts`](shared/policy.ts)에 정의되어 있으며 패키지와
같이 버저닝됩니다. 값 변경은 minor 릴리스 단위입니다.

| 파라미터 | 값 | 설명 |
|---------|----|------|
| `SIGNUP_BONUS` | `100` | 신규 사용자 가입 보너스 크레딧 |
| `FEE_BPS` | `0` | 플랫폼 수수료 (basis points, 100 bps = 1%) |
| `TREASURY_PUBKEY` | `ADMIN_PUBKEY` | `FEE_BPS > 0`일 때 수수료 수령자 |
| `MODEL_CREDITS` | haiku 2 · sonnet 6 · opus 30 · codex 2 | 작업당 크레딧 |

### 신규 사용자 온보딩 (자동)

가입 보너스는 **관리자가 서명한 `MintEvent`** 로 발급됩니다. 클라이언트의
`SIGNUP_BONUS` 상수는 참조값일 뿐이며, replay는 `ADMIN_PUBKEY`가 서명한
mint만 반영하므로 클라이언트 소스를 수정해도 크레딧은 늘지 않습니다.
또한 replay는 recipient당 `reason: "signup"` mint를 **1회만** 인정하므로
watcher 버그가 생겨도 중복 지급되지 않습니다.

흐름:

1. `ash init`에서 서명된 `SignupEvent`를 유저 Hypercore에 append.
2. 유저가 네트워크에 참여하면 (`ash`, `ash run`, `ash serve`, `ash peers`
   중 아무거나) peer:info가 `ash admin watch-signups`를 돌리는 코디네이터에
   도달.
3. 코디네이터가 유저의 core를 복제하고 SignupEvent를 검증한 뒤 자기 admin
   Hypercore에 `MintEvent { reason: "signup", amount: SIGNUP_BONUS }` append.
4. 유저의 다음 `ash status`에 보너스가 반영됨.

유저가 처음 접속할 때 코디네이터가 offline이면 SignupEvent는 유저 core에
보류됨 → 다음에 코디네이터와 유저가 겹쳐 online될 때 자동 처리.

코디네이터는 아래 명령을 상시 실행합니다:

```bash
ash admin watch-signups          # shared/policy.ts의 SIGNUP_BONUS 사용
ash admin watch-signups --bonus 50   # 오버라이드
```

`~/.ash/keys/admin.ed25519`에 관리자 키페어가 있어야 동작합니다. 프로세스는
계속 떠 있으면서 새 peer가 들어올 때마다 자동 발급.

### 위조 방지

[`core/ledger/events.ts`](core/ledger/events.ts)의 balance replay는 네 가지
불변식을 강제합니다 — 크레딧 유입은 관리자 mint 또는 실제 상대방과의 거래로만
가능합니다:

1. `SpendEvent`는 log 소유자가 서명해야 함.
2. `EarnEvent`는 `counterparty_pubkey`가 서명해야 함.
3. 각 `EarnEvent`는 상대방 log에 대응되는 `SpendEvent`가 있어야 함 — "가짜
   counterparty keypair" 위조를 차단.
4. 잔고는 항상 0 이상 유지.

---

## 아키텍처

### 신원 및 로그

- **키페어**: Ed25519 at `~/.ash/keys/ed25519`
- **이벤트 로그**: 유저별 Hypercore at `~/.ash/corestore/` (append-only, Ed25519 서명, Hyperswarm으로 P2P 복제)
- **설정**: 사용자명과 모델 티어 at `~/.ash/config.json`

모든 이벤트 (작업 제출, 크레딧 획득, 정산)는 키페어로 서명되어 Hypercore에 추가됩니다. 잔액은 로그를 리플레이해서 계산합니다. 피어들은 작업 수락 전 잔액 검증을 위해 전용 `LEDGER_TOPIC`으로 서로의 core를 복제합니다.

### 피어 발견

**Hyperswarm** (DHT 기반) 사용. 고정 토픽: `sha256("ash-network-v1")`. 피어들이 자신을 알리고 작업을 대기합니다.

### 암호화

- **코드 → 수락자**: AES-256-GCM (작업당 무작위 IV)
- **AES 키 교환**: RSA-OAEP (수락자 공개키)
- **무결성**: 모든 메시지에 HMAC-SHA256

### 샌드박스

수락자들은 AI 에이전트를 rootless Podman 컨테이너에서 실행합니다:
- `--cap-drop=ALL` (권한 없음)
- `--read-only` (불변 루트 파일시스템)
- `--tmpfs /tmp` (쓰기 가능한 tmpdir만)

---

## 문제 해결

### `not initialized`

먼저 `ash init` 실행.

### 작업이 클레임되지 않음

확인할 사항:
- 최소 하나의 피어가 `ash serve` 실행 중
- 네트워크 연결 (Hyperswarm DHT 접근 가능)
- 방화벽이 UTP/UDP 허용

### 잔액이 업데이트되지 않음

1. 이벤트 히스토리 확인: `ash history`
2. 수락자가 작업 완료 확인 (샌드박스 오류 없음)
3. 정산은 원자적 — 클레임 실패시 크레딧 미발급

### 에이전트 로그인 만료

`ash login` 또는 TUI 안에서 `/login`으로 갱신.

### Podman 오류

`ash serve` 실패시:

```bash
# Podman 확인
podman run --rm alpine echo "ok"

# Docker로 폴백
export ASH_PODMAN_CMD=docker
ash serve
```

---

## 개발

로컬에서 실행:

```bash
npm run dev                 # tsx로 CLI 실행
npm run test                # 테스트 실행
npm run build               # 배포용 tarball 빌드
```

---

## 라이선스

MIT
