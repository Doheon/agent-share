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
- **Signed append-only logs**: Each peer keeps a local Ed25519-signed event log at `~/.ash/log/`. Identity is portable across networks.
- **Sandboxed execution**: Acceptors run AI agents in rootless Podman containers (`--cap-drop=ALL`, `--read-only`).
- **Atomic claims**: Only one peer can accept a task. Settlement is atomic — credits are issued when the acceptor completes work.

> **Security note**: Acceptors can read your code in plaintext. Do not submit company code or anything covered by NDA.

---

## Installation

**Requirements:** Node.js 18+, git

```bash
git clone https://github.com/Doheon/ash
cd ash
npm install
npm install -g .
ash init
```

This creates `~/.ash/` with your Ed25519 keypair and configuration.

---

## Quick start

### Set up your identity and agent

```bash
ash init
```

Prompts for:
- Username
- Preferred AI agent (Claude, Codex)
- Environment checks (Podman/Docker, git, etc.)

### As a requester — get AI coding work done

```bash
# Interactive chat mode
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
# Serve 5 tasks (AI mode, default)
ash serve -n 5

# Serve indefinitely
ash serve

# Serve all tasks, including your own (local testing)
ash serve --allow-self
```

When a task is available:
1. Claim it atomically
2. Receive the AES key
3. Decrypt the code
4. Run the AI agent in a sandbox
5. Extract and send back the diff
6. Receive settlement credits

### Check balance

```bash
ash status
```

Shows your username, credit balance, and configured model.

---

## Commands

| Command | Purpose |
|---------|---------|
| `ash init` | Create keypair, username, agent preference |
| `ash` | Interactive chat mode (TUI) |
| `ash run "<prompt>"` | Submit a one-shot task |
| `ash serve [-n N]` | Accept tasks and earn credits |
| `ash serve --allow-self` | Include your own tasks (testing) |
| `ash status` | Show identity and balance |
| `ash set <model>` | Set model tier (e.g., `claude-sonnet`) |
| `ash login` | Refresh session (if needed) |
| `ash setup` | Re-run environment checks |
| `ash mine` | Earn credits from GitHub contributions |

---

## Policy

Economic parameters live in [`shared/policy.ts`](shared/policy.ts) and are versioned
with the package. Changing any value is a minor-release event.

| Parameter | Value | Notes |
|-----------|-------|-------|
| `SIGNUP_BONUS` | `100` | Credits issued to each new user on request |
| `FEE_BPS` | `0` | Platform fee in basis points (100 bps = 1%) |
| `TREASURY_PUBKEY` | `ADMIN_PUBKEY` | Receives fees when `FEE_BPS > 0` |
| `MODEL_CREDITS` | haiku 8 · sonnet 15 · opus 25 · codex 15 | Credit cost per task |

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
- **Event log**: Append-only JSONL at `~/.ash/log/main.jsonl` (hash-chained, signed)
- **Config**: Username and model tier at `~/.ash/config.json`

Each event (task submission, credit earn, settlement) is signed by your keypair and appended. Balance is derived by replaying the log.

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

1. Check the event log: `cat ~/.ash/log/main.jsonl | jq .`
2. Ensure the acceptor completed the task (no errors in sandbox)
3. Settlement is atomic — if claim failed, credits aren't issued

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
