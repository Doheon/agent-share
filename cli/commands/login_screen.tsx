import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { loadConfig, saveConfig, saveAgentToken, saveAgent } from "../client.ts";
import { fetchCurrentUser } from "../../core/github/client.ts";
import { validateAgentCredentials, isBinaryInstalled, getAgentStatus } from "./init.ts";
import { GITHUB_CLIENT_ID } from "../../shared/constants.ts";
import { spawn } from "../../core/util/spawn.ts";

export interface LoginResult {
  kind: "github" | "claude" | "codex";
  label: string;
}

export interface LoginScreenProps {
  onClose: (result: LoginResult | null) => void;
}

type Step =
  | { kind: "provider"; idx: number }
  | { kind: "github"; phase: "init" }
  | { kind: "github"; phase: "waiting"; userCode: string; verificationUri: string; deviceCode: string; interval: number; expiresIn: number }
  | { kind: "github"; phase: "error"; error: string }
  | { kind: "claude"; buf: string; cursorPos: number; busy: boolean; error?: string; hasBin: boolean | null }
  | { kind: "codex"; busy: boolean; error?: string; hasBin: boolean | null };

const PROVIDERS = [
  { id: "github" as const, label: "GitHub",      desc: "authorize via browser (Device Flow)" },
  { id: "claude" as const, label: "Claude Code", desc: "paste an sk-ant-… long-lived token" },
  { id: "codex"  as const, label: "Codex",       desc: "verify ash login codex completed" },
];

type ProviderStatus = { loading: boolean; text: string; ok: boolean };
const LOADING_STATUS: ProviderStatus = { loading: true, text: "", ok: false };

export function LoginScreen({ onClose }: LoginScreenProps): React.ReactNode {
  const [step, setStep] = useState<Step>({ kind: "provider", idx: 0 });
  const mountedRef = useRef(true);
  const [statuses, setStatuses] = useState<Record<"github" | "claude" | "codex", ProviderStatus>>({
    github: LOADING_STATUS,
    claude: LOADING_STATUS,
    codex:  LOADING_STATUS,
  });

  useEffect(() => () => { mountedRef.current = false; }, []);

  // Load current login status for all providers on mount.
  useEffect(() => {
    const setStatus = (key: "github" | "claude" | "codex", s: Omit<ProviderStatus, "loading">) => {
      if (!mountedRef.current) return;
      setStatuses((prev) => ({ ...prev, [key]: { loading: false, ...s } }));
    };

    loadConfig().then(async (cfg) => {
      if (!cfg.githubToken) { setStatus("github", { text: "—", ok: false }); return; }
      fetchCurrentUser(cfg.githubToken)
        .then((u) => setStatus("github", { text: `@${u.login}`, ok: true }))
        .catch(() => setStatus("github", { text: "token invalid", ok: false }));
    }).catch(() => setStatus("github", { text: "—", ok: false }));

    getAgentStatus("claude").then((s) => {
      if (s === "valid")          setStatus("claude", { text: "✓ valid",        ok: true });
      else if (s === "expired")   setStatus("claude", { text: "⚠ expired",      ok: false });
      else                        setStatus("claude", { text: "—",              ok: false });
    }).catch(() => setStatus("claude", { text: "—", ok: false }));

    getAgentStatus("codex").then((s) => {
      if (s === "valid")          setStatus("codex", { text: "✓ valid",         ok: true });
      else if (s === "expired")   setStatus("codex", { text: "⚠ expired",       ok: false });
      else                        setStatus("codex", { text: "—",               ok: false });
    }).catch(() => setStatus("codex", { text: "—", ok: false }));
  }, []);

  // Derived stable keys for effects.
  const githubPhase      = step.kind === "github" ? step.phase : null;
  const githubDeviceCode = step.kind === "github" && step.phase === "waiting" ? step.deviceCode : null;
  const githubInterval   = step.kind === "github" && step.phase === "waiting" ? step.interval : 5;
  const githubExpiresIn  = step.kind === "github" && step.phase === "waiting" ? step.expiresIn : 900;
  const binKind          = step.kind === "claude" || step.kind === "codex" ? step.kind : null;
  const hasBin           = step.kind === "claude" || step.kind === "codex" ? step.hasBin : null;

  // Step 1: request device code from GitHub.
  useEffect(() => {
    if (githubPhase !== "init") return;
    let cancelled = false;
    fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "repo" }),
    })
      .then((r) => r.json() as Promise<Record<string, unknown>>)
      .then((data) => {
        if (cancelled || !mountedRef.current) return;
        if (!data.user_code || !data.device_code || !data.verification_uri) {
          setStep({ kind: "github", phase: "error", error: "failed to start GitHub login — check network" });
          return;
        }
        // Best-effort browser open.
        const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
        spawn([openCmd, String(data.verification_uri)], { stdout: "ignore", stderr: "ignore" }).exited.catch(() => {});
        setStep({
          kind: "github",
          phase: "waiting",
          userCode: String(data.user_code),
          verificationUri: String(data.verification_uri),
          deviceCode: String(data.device_code),
          interval: typeof data.interval === "number" ? data.interval : 5,
          expiresIn: typeof data.expires_in === "number" ? data.expires_in : 900,
        });
      })
      .catch(() => {
        if (cancelled || !mountedRef.current) return;
        setStep({ kind: "github", phase: "error", error: "network error — check connection and retry" });
      });
    return () => { cancelled = true; };
  }, [githubPhase]);

  // Step 2: poll for token while in "waiting" phase.
  useEffect(() => {
    if (!githubDeviceCode) return;
    let cancelled = false;
    // Floor poll interval at 5s so a hostile mitm-ed `interval: 0`
    // response can't induce a tight CPU loop.
    let currentMs = Math.max(githubInterval * 1000, 5000);
    // Honor the device-code expiry. GitHub typically returns
    // expires_in: 900 (15 min). Stop polling at that wall-clock cutoff
    // even if the server keeps returning authorization_pending — a
    // captive portal could otherwise keep us polling forever.
    const expiresAt = Date.now()
      + Math.min(typeof githubExpiresIn === "number" ? githubExpiresIn : 900, 1800) * 1000;
    // Track the pending timeout so cleanup can clear it. Without this
    // a cancelled effect (re-render with a new device code) leaks the
    // timer chain into the background, eventually racing with the new
    // chain.
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Schedule a follow-up poll only if we haven't been cancelled. The
    // scheduling happens after `await fetch` resolves, so we MUST guard
    // against cleanup having fired during that await — without this
    // guard a ghost setTimeout could fire after unmount.
    const reschedule = () => {
      if (cancelled || !mountedRef.current) return;
      if (Date.now() > expiresAt) {
        setStep({ kind: "github", phase: "error", error: "code expired — press enter to try again" });
        return;
      }
      timer = setTimeout(poll, currentMs);
    };

    const poll = async () => {
      timer = null;
      if (cancelled || !mountedRef.current) return;
      if (Date.now() > expiresAt) {
        setStep({ kind: "github", phase: "error", error: "code expired — press enter to try again" });
        return;
      }
      try {
        const res = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            device_code: githubDeviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });
        if (cancelled || !mountedRef.current) return;
        const data = await res.json() as Record<string, string>;
        if (data.access_token) {
          const user = await fetchCurrentUser(data.access_token);
          if (cancelled || !mountedRef.current) return;
          await saveConfig({ githubToken: data.access_token });
          onClose({ kind: "github", label: `@${user.login}` });
          return;
        }
        if (data.error === "slow_down")     currentMs += 5000;
        if (data.error === "expired_token") { setStep({ kind: "github", phase: "error", error: "code expired — press enter to try again" }); return; }
        if (data.error === "access_denied") { setStep({ kind: "github", phase: "error", error: "access denied" }); return; }
        // authorization_pending or slow_down: keep polling.
        reschedule();
      } catch {
        reschedule();
      }
    };

    timer = setTimeout(poll, currentMs);
    return () => {
      cancelled = true;
      if (timer) { clearTimeout(timer); timer = null; }
    };
  }, [githubDeviceCode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Binary check for claude/codex steps.
  useEffect(() => {
    if (!binKind || hasBin !== null) return;
    let cancelled = false;
    isBinaryInstalled(binKind).then((has) => {
      if (cancelled || !mountedRef.current) return;
      setStep((s) => s.kind === binKind ? { ...s, hasBin: has } : s);
    });
    return () => { cancelled = true; };
  }, [binKind, hasBin]);

  useInput((input, key) => {
    // Ctrl+C handled by parent chat useInput (fires first by registration order).
    if (key.ctrl && input === "c") return;

    if (step.kind === "provider") {
      if (key.upArrow)   { setStep((s) => s.kind === "provider" ? { ...s, idx: Math.max(0, s.idx - 1) } : s); return; }
      if (key.downArrow) { setStep((s) => s.kind === "provider" ? { ...s, idx: Math.min(PROVIDERS.length - 1, s.idx + 1) } : s); return; }
      if (key.escape)    { onClose(null); return; }
      if (key.return) {
        const chosen = PROVIDERS[step.idx];
        if (!chosen) return;
        if (chosen.id === "github") setStep({ kind: "github", phase: "init" });
        else if (chosen.id === "claude") setStep({ kind: "claude", buf: "", cursorPos: 0, busy: false, hasBin: null });
        else setStep({ kind: "codex", busy: false, hasBin: null });
        return;
      }
      return;
    }

    if (step.kind === "github") {
      if (key.escape) { onClose(null); return; }
      if (step.phase === "error" && key.return) {
        setStep({ kind: "github", phase: "init" });
        return;
      }
      return;
    }

    if (step.kind === "claude") {
      if (step.busy)  return;
      if (key.escape) { onClose(null); return; }
      if (step.hasBin === false) { if (key.return) onClose(null); return; }
      if (step.hasBin === null) return;
      if (key.return) {
        const token = step.buf.trim();
        if (!token) return;
        if (!token.startsWith("sk-ant-") || token.length < 20) {
          setStep((s) => s.kind === "claude" ? { ...s, error: 'invalid token — must be sk-ant-… (20+ chars)' } : s);
          return;
        }
        setStep((s) => s.kind === "claude" ? { ...s, busy: true, error: undefined } : s);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        fetch("https://api.anthropic.com/v1/models", {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${token}`,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
          },
          signal: controller.signal,
        })
          .then(async (res) => {
            clearTimeout(timer);
            if (!mountedRef.current) return;
            if (res.status === 401 || res.status === 403) {
              setStep((s) => s.kind === "claude" ? { ...s, busy: false, buf: "", error: "token rejected by Anthropic API" } : s);
              return;
            }
            await saveAgentToken(token);
            await saveAgent("claude");
            // Clear the in-memory token buffer immediately so a future
            // heap dump (e.g. crash report, --inspect debugger) cannot
            // recover the sk-ant-... value. The token is now persisted
            // to disk with mode 0600 via saveAgentToken.
            setStep((s) => s.kind === "claude" ? { ...s, buf: "" } : s);
            onClose({ kind: "claude", label: "Claude Code" });
          })
          .catch((err: unknown) => {
            clearTimeout(timer);
            if (!mountedRef.current) return;
            const isTimeout = err instanceof Error && err.name === "AbortError";
            setStep((s) => s.kind === "claude"
              ? { ...s, busy: false, buf: "", error: isTimeout
                  ? "verification timed out — check network and retry"
                  : "network error — check connection and retry" }
              : s);
          });
        return;
      }
      handleTextKey(input, key);
      return;
    }

    if (step.kind === "codex") {
      if (step.busy)  return;
      if (key.escape) { onClose(null); return; }
      if (step.hasBin === false) { if (key.return) onClose(null); return; }
      if (step.hasBin === null) return;
      if (key.return) {
        setStep((s) => s.kind === "codex" ? { ...s, busy: true, error: undefined } : s);
        validateAgentCredentials("codex")
          .then(async (valid) => {
            if (!mountedRef.current) return;
            if (valid) {
              await saveAgent("codex");
              onClose({ kind: "codex", label: "Codex" });
            } else {
              setStep((s) => s.kind === "codex"
                ? { ...s, busy: false, error: "session not found or expired — re-run: ash login codex" }
                : s);
            }
          })
          .catch(() => {
            if (!mountedRef.current) return;
            setStep((s) => s.kind === "codex"
              ? { ...s, busy: false, error: "failed to verify codex session" }
              : s);
          });
        return;
      }
      return;
    }
  });

  function handleTextKey(
    input: string,
    key: { backspace?: boolean; delete?: boolean; leftArrow?: boolean; rightArrow?: boolean; ctrl?: boolean; meta?: boolean },
  ) {
    if (key.backspace || key.delete) {
      setStep((s) => {
        if (s.kind !== "claude") return s;
        const newBuf = s.buf.slice(0, Math.max(0, s.cursorPos - 1)) + s.buf.slice(s.cursorPos);
        return { ...s, buf: newBuf, cursorPos: Math.max(0, s.cursorPos - 1) };
      });
      return;
    }
    if (key.leftArrow)  { setStep((s) => s.kind === "claude" ? { ...s, cursorPos: Math.max(0, s.cursorPos - 1) } : s); return; }
    if (key.rightArrow) { setStep((s) => s.kind === "claude" ? { ...s, cursorPos: Math.min(s.buf.length, s.cursorPos + 1) } : s); return; }
    if (input && !key.ctrl && !key.meta) {
      setStep((s) => {
        if (s.kind !== "claude") return s;
        const newBuf = s.buf.slice(0, s.cursorPos) + input + s.buf.slice(s.cursorPos);
        return { ...s, buf: newBuf, cursorPos: s.cursorPos + input.length };
      });
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  if (step.kind === "provider") {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color="#888888">{"─── login ───────────────────────────────"}</Text>
        {PROVIDERS.map((p, i) => {
          const st = statuses[p.id];
          const active = i === step.idx;
          return (
            <Box key={p.id} backgroundColor={active ? "#2a2a2a" : undefined}>
              <Text color={active ? "#ffffff" : "#888888"}>
                {`  ${active ? "●" : " "} ${p.label.padEnd(14)}  `}
              </Text>
              {st.loading
                ? <Text color="#555555">{"checking…"}</Text>
                : <Text color={st.ok ? "#7cd38a" : "#555555"}>{st.text}</Text>}
            </Box>
          );
        })}
        <Text color="#555555">{"    ↑↓ navigate · enter select · esc cancel"}</Text>
      </Box>
    );
  }

  if (step.kind === "github") {
    if (step.phase === "init") {
      return (
        <Box flexDirection="column" paddingX={2}>
          <Text color="#888888">{"─── login: GitHub ───────────────────────"}</Text>
          <Text color="#555555">{"  Requesting code from GitHub…"}</Text>
        </Box>
      );
    }
    if (step.phase === "waiting") {
      return (
        <Box flexDirection="column" paddingX={2}>
          <Text color="#888888">{"─── login: GitHub ───────────────────────"}</Text>
          <Text color="#cccccc">{"  Enter this code at:"}</Text>
          <Text color="#888888">{`  ${step.verificationUri}`}</Text>
          <Box marginTop={1} marginBottom={1} paddingLeft={2}>
            <Text color="#00c8ff" bold>{step.userCode}</Text>
          </Box>
          <Text color="#555555">{"  (browser opened automatically if possible)"}</Text>
          <Text color="#555555">{"  Waiting for authorization… · esc to cancel"}</Text>
        </Box>
      );
    }
    if (step.phase === "error") {
      return (
        <Box flexDirection="column" paddingX={2}>
          <Text color="#888888">{"─── login: GitHub ───────────────────────"}</Text>
          <Text color="#ff8888">{`  ✗ ${step.error}`}</Text>
          <Text color="#555555">{"  enter to retry · esc to cancel"}</Text>
        </Box>
      );
    }
  }

  if (step.kind === "claude") {
    if (step.hasBin === null) {
      return (
        <Box flexDirection="column" paddingX={2}>
          <Text color="#888888">{"─── login: Claude Code ──────────────────"}</Text>
          <Text color="#555555">{"  checking…"}</Text>
        </Box>
      );
    }
    if (!step.hasBin) {
      return (
        <Box flexDirection="column" paddingX={2}>
          <Text color="#888888">{"─── login: Claude Code ──────────────────"}</Text>
          <Text color="#ff8888">{"  claude CLI is not installed."}</Text>
          <Text color="#888888">{"  install:  npm install -g @anthropic-ai/claude-code"}</Text>
          <Text color="#555555">{"  enter or esc to cancel"}</Text>
        </Box>
      );
    }
    const withCursor = step.buf.slice(0, step.cursorPos) + "│" + step.buf.slice(step.cursorPos);
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color="#888888">{"─── login: Claude Code ──────────────────"}</Text>
        <Text color="#cccccc">{"  In another terminal, run:  claude setup-token"}</Text>
        <Text color="#cccccc">{"  Then paste the sk-ant-… token here:"}</Text>
        <Box paddingLeft={2}>
          <Text color="#555555">{"❯ "}</Text>
          <Text color="#ffffff">{step.buf.length === 0 && !step.busy ? "│" : withCursor}</Text>
        </Box>
        {step.error && <Text color="#ff8888">{`  ✗ ${step.error}`}</Text>}
        {step.busy
          ? <Text color="#888888">{"  verifying…"}</Text>
          : <Text color="#555555">{"  enter to confirm · esc to cancel"}</Text>}
      </Box>
    );
  }

  if (step.kind === "codex") {
    if (step.hasBin === null) {
      return (
        <Box flexDirection="column" paddingX={2}>
          <Text color="#888888">{"─── login: Codex ────────────────────────"}</Text>
          <Text color="#555555">{"  checking…"}</Text>
        </Box>
      );
    }
    if (!step.hasBin) {
      return (
        <Box flexDirection="column" paddingX={2}>
          <Text color="#888888">{"─── login: Codex ────────────────────────"}</Text>
          <Text color="#ff8888">{"  codex CLI is not installed."}</Text>
          <Text color="#888888">{"  install:  npm install -g @openai/codex"}</Text>
          <Text color="#555555">{"  enter or esc to cancel"}</Text>
        </Box>
      );
    }
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color="#888888">{"─── login: Codex ────────────────────────"}</Text>
        <Text color="#cccccc">{"  In another terminal, run:  ash login codex"}</Text>
        <Text color="#cccccc">{"  Press Enter when login completes (Esc to cancel)."}</Text>
        {step.error && <Text color="#ff8888">{`  ✗ ${step.error}`}</Text>}
        {step.busy
          ? <Text color="#888888">{"  verifying…"}</Text>
          : <Text color="#555555">{step.error ? "  enter to retry · esc to cancel" : "  enter to verify · esc to cancel"}</Text>}
      </Box>
    );
  }

  return null;
}
