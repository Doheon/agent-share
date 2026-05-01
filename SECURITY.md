# Security Policy

## Supported Versions

ash is pre-1.0. Only the latest `0.1.x` minor receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✓         |
| < 0.1   | ✗         |

## Reporting a Vulnerability

Please report security issues privately — **do not open a public GitHub issue**.

- Email: andh9696@gmail.com
- Subject prefix: `[ash security]`

Include:
- Version (`ash --version`)
- Reproduction steps or proof-of-concept
- Impact assessment (what an attacker gains)
- Suggested fix if you have one

You should expect a first response within 7 days. We will coordinate a release window before any public disclosure.

## Known v0.1 Risks

ash ships with a deliberate set of `experimental` caveats — please read these before deploying:

- **Admin-key dependency.** All credit issuance traces back to a single admin Ed25519 key hardcoded in `shared/constants.ts#ADMIN_PUBKEY`. Loss or compromise of that key halts new credit issuance globally; there is no decentralized recovery in v0.1.
- **`ash mine` runs unsandboxed.** mine invokes Claude Code or Codex directly on your host with `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`. A prompt injection in a malicious PR/issue body could read or modify any file you can. Do not run `ash mine` on a machine with sensitive files.
- **Acceptor sandbox network.** `ash serve` containerizes the agent (`--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--tmpfs /tmp:noexec,nosuid`, non-root user). On Docker (default on macOS / Windows) the bridge network can reach the host LAN and IP-only metadata endpoints (`169.254.169.254`). Podman rootless on Linux is recommended for `serve`.
- **Acceptors see code in plaintext inside the sandbox.** Encryption protects code in transit, not from the acceptor running it. Do not submit company code or NDA-covered material via `ash`.
- **Crash-after-spend can lose one task's credit.** If a requester crashes after their `SpendEvent` is appended locally but before `earn:cosign` reaches the acceptor, the acceptor's work goes uncompensated for that task. v0.1 documents this; v0.2 will add a 3-message commit to make settlement atomic.

## Out of Scope

- DoS via spam on the public Hyperswarm topic (rate-limited but not eliminated).
- Sybil credit accumulation during the launch period while `ash admin watch-signups` is running (intentional bootstrap; admin can stop it at any time).
- Vulnerabilities in upstream dependencies (`hypercore`, `hyperswarm`, `ink`, etc.) — please report those to their respective maintainers.
