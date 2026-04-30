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
- **Sandboxed execution**: Acceptors run AI agents in rootless Podman containers (`--cap-drop=ALL`, `--read-only`).
- **Atomic claims**: Only one peer can accept a task. Settlement is atomic — credits are issued when the acceptor completes work.

> **Security note**: Acceptors can read your code in plaintext inside the sandbox. Do not submit company code or anything covered by NDA.

---

## Installation

**Requirements:** Node.js 18+, git

```bash
git clone https://github.com/Doheon/agent-share
cd agent-share
npm install
npm install -g .
ash init
```

This creates `~/.ash/` with your Ed25519 keypair, Corestore, and configuration.

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
| **GitHub** | OAuth Device Flow — opens browser, poll until authorized |
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
| `ash login [agent]` | Log in to GitHub, Claude Code, or Codex |
| `ash setup` | Re-run environment checks |
| `ash mine [-n N] [query]` | Earn credits via GitHub contributions |
| `ash history [pubkey]` | Show earn/spend/mint event history |
| `ash peers` | List connected peers and their balances |

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

- **Keypair**: Ed25519 at `~/.ash/keys/ed25519`
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

Acceptors run AI agents in a rootless Podman container with:
- `--cap-drop=ALL` (no capabilities)
- `--read-only` (immutable root filesystem)
- `--tmpfs /tmp` (writable tmpdir only)

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
