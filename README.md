# ash

[한국어](./README.ko.md)

> Distributed P2P AI coding agent network — share idle compute, earn credits, fully self-hosted.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Runtime: Node.js](https://img.shields.io/badge/Runtime-Node.js-green)](https://nodejs.org)

---

## Why ash?

Claude Code's $20 plan has a **5-hour session limit**. The next tier is $100/month.

Most developers don't use AI tools heavily every day. **ash** lets you earn credits by accepting coding tasks during idle time, and spend them on AI-assisted development when you need it.

---

## How it works

ash is a peer-to-peer network, not a server. When you submit a task:

```
You (requester)             Hyperswarm DHT              Peer (acceptor)
      │                           │                          │
      ├─ Prompt + code ──────────►│                          │
      │    (AES-256-GCM)          │ ◄────── peer:announce ───┤
      │                           │                          │
      │ ◄─── RSA pubkey ──────────┼──────────────────────────┤
      ├─ AES key (RSA-OAEP) ─────►│ ────────────────────────►│
      │                           │                   decrypt │
      │                           │                   run AI  │
      │ ◄─── git diff ────────────┼──────────────────────────┤
      │     (AES-256-GCM)         │     settlement event      │
      └─ Credits updated          │                          │
```

**Key properties:**

- **End-to-end encryption**: Code and diffs encrypted with AES-256-GCM. Peers exchange keys via RSA-OAEP. Server sees nothing.
- **Signed append-only logs**: Each peer keeps a local Ed25519-signed Hypercore at `~/.ash/corestore/`. Logs are replicated peer-to-peer for balance verification.
- **Sandboxed execution**: Acceptors run AI agents in rootless Podman/Docker containers with `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `/tmp` mounted as `tmpfs noexec,nosuid`, and a non-root user.
- **Atomic claims**: Only one peer can accept a task. Settlement is atomic — credits are issued when the acceptor completes work.

> **Security note**: Acceptors can read your code in plaintext inside the sandbox. Do not submit company code or anything covered by NDA.

---

## ⚠️ v0.1 — experimental

ash is pre-1.0. The protocol, ledger format, and identity layout may change between minor versions. **Do not run on production secrets, use a throwaway machine for `ash serve`, and back up `~/.ash/` if the credits matter to you.**

Things you should know going in:

- **Credits are admin-issued.** Every credit on the network traces back to an `admin`-signed `MintEvent`. Loss or compromise of the admin keypair stops all new issuance — there is no decentralized fallback in v0.1.
- **DHT bootstrap is slow on cold starts.** First peer connection can take 30-90 seconds; balance verification can occasionally fail because a remote core hasn't replicated yet. Retry the command.
- **`ash serve` runs untrusted prompts in a sandbox; `ash mine` does not.** The mine workflow runs the AI agent on the host (not inside Podman/Docker) because it operates on a clone of the public ash repo. Don't run `ash mine` on a machine that holds anything sensitive.
- **Network exposure.** Acceptors expose the sandbox to outbound HTTPS so the agent can reach `api.anthropic.com` / OpenAI. On Docker, sandbox containers run with `--network=bridge` (`podman` uses `slirp4netns`); we map cloud-metadata DNS names (`169.254.169.254`, `host.docker.internal`, etc.) to loopback, but cannot fully firewall the bridge from inside an unprivileged container. Don't run `ash serve` on a machine with sensitive LAN neighbours or on cloud instances with broad IAM access.
- **Native dependencies.** `hypercore` and `hyperswarm` pull in `sodium-native` and `udx-native`. On platforms without prebuilt binaries (Alpine, some ARM Linux variants) you'll need a C build toolchain installed. `npm install` will tell you if a build fails.
- **Identity files are local.** `~/.ash/keys/identity.ed25519` (ledger signing) and `~/.ash/keys/rsa/` (per-task AES key exchange) live on disk. Earlier builds wrote RSA keys to `~/.agent-share/keys/`; ash migrates those automatically on first run after upgrade.

---

## Installation

**Requirements:** Node.js 18+, git, Podman or Docker (required for `ash serve`)

```bash
npm install -g @doheon/ash
ash init
```

This creates `~/.ash/` with your Ed25519 keypair, Corestore, and configuration.

### Install from source

```bash
git clone https://github.com/Doheon/agent-share
cd agent-share
npm install
npm install -g .
ash init
```

---

## Quick start

### Set up your identity and agent

```bash
ash init
```

Prompts for:
- Username
- Preferred AI agent (Claude Code or Codex)
- Environment checks (Podman/Docker, git, etc.)
- Agent login (guides you through authentication)

### Log in to AI agents

```bash
ash login
```

Supports three providers:

| Provider | Method |
|----------|--------|
| **GitHub** | Prompts for a personal access token (PAT) with `repo` scope. TUI `/login` uses OAuth Device Flow instead. |
| **Claude Code** | Run `claude setup-token` to generate a long-lived `sk-ant-…` token |
| **Codex** | Creates an isolated session at `~/.ash/codex-session` |

You can also log in from within the TUI with `/login`.

### As a requester — get AI coding work done

```bash
# Interactive chat mode (TUI)
ash

# Or submit a one-shot task
ash run "add TypeScript types to my project"
```

Your code is packaged, encrypted, and announced to the P2P network. When a peer accepts:

1. They claim the task atomically
2. You send the AES key (via RSA-OAEP)
3. They decrypt, run the AI agent, extract a git diff
4. Diff is sent back encrypted
5. You approve/reject; credits settle

### As an acceptor — earn credits

```bash
# Serve up to 5 tasks (default model)
ash serve -n 5

# Serve indefinitely
ash serve

# Serve your own tasks too (local testing)
ash serve --allow-self
```

When a task is available:
1. Claim it atomically
2. Receive the AES key
3. Decrypt the code
4. Run the AI agent in a sandbox
5. Extract and send back the diff
6. Receive settlement credits

### Earn credits via GitHub contributions

> **Note:** `ash mine` contributes to the [ash GitHub repository](https://github.com/Doheon/agent-share) itself. Improving ash earns you credits on the network.

```bash
# Auto-cycle: pick the highest-priority action and execute
ash mine

# Run up to N actions in one session
ash mine -n 3

# Query mode: file a GitHub issue if evidence is found in the codebase
ash mine "the history command doesn't show mint events"
```

**Mine credit table:**

| Action | Credits |
|--------|---------|
| Implement issue → open PR | 6 (+3 if tests added) |
| Recommend closing issue | 2 |
| Review PR → approve | 2 |
| Review PR → request changes | 3 |
| Review PR → close recommend | 2 |
| Self-improve own PR | 4 |
| Address reviewer feedback on own PR | 5 |
| File a new issue (query mode) | 4 |

`/mine` is also available as a slash command inside the TUI.

### Check balance

```bash
ash status
```

Shows your username, credit balance, pubkey, and login status for each AI agent.

---

## Commands

| Command | Purpose |
|---------|---------|
| `ash init` | Create keypair, username, agent preference |
| `ash` | Interactive chat mode (TUI) |
| `ash run "<prompt>"` | Submit a one-shot task |
| `ash serve [-n N]` | Accept tasks and earn credits |
| `ash serve --allow-self` | Include your own tasks (testing) |
| `ash status` | Show identity, balance, and agent login status |
| `ash set <model>` | Set model tier (e.g., `claude-sonnet`) |
| `ash set github-token <PAT>` | Save a GitHub personal access token |
| `ash login [agent]` | Log in to GitHub, Claude Code, or Codex |
| `ash setup` | Re-run environment checks |
| `ash mine [-n N] [query]` | Earn credits via GitHub contributions |
| `ash history [pubkey]` | Show earn/spend/mint event history |
| `ash peers` | List connected peers and their balances |
| `ash peers --forget <pubkey>` | Drop a stale ledger-key mapping (use after a peer resets their corestore) |

---

## TUI slash commands

Inside the interactive chat (`ash`):

| Command | Purpose |
|---------|---------|
| `/serve [N]` | Enter serve mode — accept up to N tasks (omit for unlimited) |
| `/mine [N]` or `/mine "<query>"` | Run mine actions or file a GitHub issue |
| `/model [tier]` | Switch model interactively or directly |
| `/new` | Clear turn history, start a fresh conversation |
| `/status` | Show account info |
| `/peers` | List connected peers |
| `/history [pubkey]` | Show event history |
| `/login [agent]` | Log in to GitHub, Claude Code, or Codex |
| `/clear` | Clear chat scrollback |
| `/help` | Show available commands |
| `/quit` | Exit |

---

## Policy

Economic parameters live in [`shared/policy.ts`](shared/policy.ts) and are versioned
with the package. Changing any value is a minor-release event.

| Parameter | Value | Notes |
|-----------|-------|-------|
| `SIGNUP_BONUS` | `100` | Credits issued to each new user on request |
| `FEE_BPS` | `0` | Platform fee in basis points (100 bps = 1%) |
| `TREASURY_PUBKEY` | `ADMIN_PUBKEY` | Receives fees when `FEE_BPS > 0` |
| `MODEL_CREDITS` | haiku 2 · sonnet 6 · opus 30 · codex 2 | Credit cost per task |

### New user onboarding (automatic)

Signup bonus is issued as an **admin-signed `MintEvent`**. The client-side
`SIGNUP_BONUS` constant is only a reference value — replay only credits mints
signed by `ADMIN_PUBKEY`, so forking the client and changing the number does
not yield credit. Replay also caps each recipient at **one** `reason:
"signup"` mint, so a buggy watcher cannot double-issue.

Flow:

1. `ash init` records a signed `SignupEvent` in the user's Hypercore.
2. When the user joins the network (any of `ash`, `ash run`, `ash serve`,
   `ash peers`), their peer:info reaches a coordinator that runs
   `ash admin watch-signups`.
3. The coordinator replicates the user's core, verifies the SignupEvent, and
   appends a `MintEvent { reason: "signup", amount: SIGNUP_BONUS }` to its
   own admin Hypercore.
4. On the user's next `ash status`, the bonus is credited.

If no coordinator is online when the user first joins, the SignupEvent stays
pending in the user's core; it will be picked up the next time a coordinator
and the user overlap on the network.

A coordinator is any machine that runs:

```bash
ash admin watch-signups          # uses SIGNUP_BONUS from shared/policy.ts
ash admin watch-signups --bonus 50   # override
```

The watcher requires the admin keypair at `~/.ash/keys/admin.ed25519`. The
process stays up indefinitely and mints signup bonuses as new peers appear.

### Forgery defense

The balance replay at [`core/ledger/events.ts`](core/ledger/events.ts)
enforces four invariants so credit can only enter the system through an
admin mint or a real counterparty transaction:

1. `SpendEvent` must be signed by the log owner.
2. `EarnEvent` must be signed by `counterparty_pubkey`.
3. Each `EarnEvent` must have a matching `SpendEvent` in the counterparty's
   log — blocks the "fake counterparty keypair" forgery.
4. Running balance must stay ≥ 0.

---

## Architecture

### Identity and logs

- **Keypair**: Ed25519 at `~/.ash/keys/identity.ed25519`
- **Event log**: Per-user Hypercore in `~/.ash/corestore/` (append-only, Ed25519-signed, replicated over Hyperswarm)
- **Config**: Username and model tier at `~/.ash/config.json`

Each event (task submission, credit earn, settlement) is signed by your keypair and appended to your Hypercore. Balance is derived by replaying the log. Peers replicate each other's cores over a dedicated `LEDGER_TOPIC` to verify balances before accepting tasks.

### Peer discovery

Uses **Hyperswarm** (DHT-based). Fixed topic: `sha256("ash-network-v1")`. Peers announce themselves and listen for tasks.

### Encryption

- **Code → acceptor**: AES-256-GCM (random IV per task)
- **AES key exchange**: RSA-OAEP (acceptor's public key)
- **Integrity**: HMAC-SHA256 on all messages

### Sandbox

Acceptors run AI agents in a rootless Podman or Docker container with:
- `--cap-drop=ALL` (no capabilities)
- `--security-opt=no-new-privileges`
- `--tmpfs /tmp:rw,noexec,nosuid,size=100m`
- non-root `sandboxuser` inside the container
- the agent token mounted read-only at `/run/secrets/agent-token`
- `--add-host` entries mapping cloud-metadata DNS names to `127.0.0.1`

---

## Troubleshooting

### `not initialized`

Run `ash init` first.

### Task not claiming

Check that:
- At least one peer is running `ash serve`
- Network connectivity (Hyperswarm DHT access)
- Firewall allows UTP/UDP

### Balance not updating

1. Check event history: `ash history`
2. Ensure the acceptor completed the task (no errors in sandbox)
3. Settlement is atomic — if claim failed, credits aren't issued

### Agent login expired

Run `ash login` or `/login` inside the TUI to refresh credentials.

### Verbose handshake logs

If peers don't connect or get destroyed silently, run with debug logs:

```bash
ASH_DEBUG_SWARM=1 ash
```

This prints handshake timeouts, signature failures, and protocol-version mismatches to stderr.

### Wire protocol incompatibility

Every peer carries `protocol_version` in `peer:hello`. Versions must match exactly — there is no compatibility window. v0.1.0 ships protocol version 2; do not mix it with any earlier internal builds.

### Podman errors

If `ash serve` fails:

```bash
# Check Podman
podman run --rm alpine echo "ok"

# Fallback to Docker
export ASH_PODMAN_CMD=docker
ash serve
```

---

## Development

Clone and run locally:

```bash
npm run dev                 # Run CLI with tsx
npm run test                # Run tests
npm run build               # Build distributable tarball
```

---

## License

MIT
