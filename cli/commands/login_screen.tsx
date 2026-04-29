import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { saveConfig, saveAgentToken, saveAgent } from "../client.ts";
import { fetchCurrentUser } from "../../core/github/client.ts";
import { validateAgentCredentials, isBinaryInstalled } from "./init.ts";

export interface LoginResult {
  kind: "github" | "claude" | "codex";
  label: string;
}

export interface LoginScreenProps {
  onClose: (result: LoginResult | null) => void;
}

type Step =
  | { kind: "provider"; idx: number }
  | { kind: "github"; buf: string; cursorPos: number; busy: boolean; error?: string }
  | { kind: "claude"; buf: string; cursorPos: number; busy: boolean; error?: string; hasBin: boolean | null }
  | { kind: "codex"; busy: boolean; error?: string; hasBin: boolean | null };

const PROVIDERS = [
  { id: "github" as const, label: "GitHub",      desc: "add a personal access token" },
  { id: "claude" as const, label: "Claude Code", desc: "paste an sk-ant-… long-lived token" },
  { id: "codex"  as const, label: "Codex",       desc: "verify ash login codex completed" },
];

export function LoginScreen({ onClose }: LoginScreenProps): React.ReactNode {
  const [step, setStep] = useState<Step>({ kind: "provider", idx: 0 });
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  // Probe for binary installation with cleanup so stale results are dropped.
  useEffect(() => {
    if (step.kind !== "claude" && step.kind !== "codex") return;
    if (step.hasBin !== null) return;
    let cancelled = false;
    const bin = step.kind;
    isBinaryInstalled(bin).then((has) => {
      if (cancelled || !mountedRef.current) return;
      setStep((s) => s.kind === bin ? { ...s, hasBin: has } : s);
    });
    return () => { cancelled = true; };
  }, [step.kind, step.kind === "claude" || step.kind === "codex" ? step.hasBin : null]); // eslint-disable-line react-hooks/exhaustive-deps

  useInput((input, key) => {
    // Ctrl+C is handled by the parent chat useInput which fires first (registration order).
    // Do not swallow it here so the app exits cleanly.
    if (key.ctrl && input === "c") return;

    if (step.kind === "provider") {
      if (key.upArrow)   { setStep((s) => s.kind === "provider" ? { ...s, idx: Math.max(0, s.idx - 1) } : s); return; }
      if (key.downArrow) { setStep((s) => s.kind === "provider" ? { ...s, idx: Math.min(PROVIDERS.length - 1, s.idx + 1) } : s); return; }
      if (key.escape)    { onClose(null); return; }
      if (key.return) {
        const chosen = PROVIDERS[step.idx];
        if (!chosen) return;
        if (chosen.id === "github") setStep({ kind: "github", buf: "", cursorPos: 0, busy: false });
        else if (chosen.id === "claude") setStep({ kind: "claude", buf: "", cursorPos: 0, busy: false, hasBin: null });
        else setStep({ kind: "codex", busy: false, hasBin: null });
        return;
      }
      return;
    }

    if (step.kind === "github") {
      if (step.busy)  return;
      if (key.escape) { onClose(null); return; }
      if (key.return) {
        const token = step.buf.trim();
        if (!token) return;
        setStep((s) => s.kind === "github" ? { ...s, busy: true, error: undefined } : s);
        fetchCurrentUser(token)
          .then(async (user) => {
            if (!mountedRef.current) return;
            await saveConfig({ githubToken: token });
            onClose({ kind: "github", label: `@${user.login}` });
          })
          .catch(() => {
            if (!mountedRef.current) return;
            setStep((s) => s.kind === "github"
              ? { ...s, busy: false, error: "token is invalid or lacks repo scope" }
              : s);
          });
        return;
      }
      handleTextKey(input, key, "github");
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
              setStep((s) => s.kind === "claude"
                ? { ...s, busy: false, error: "token rejected by Anthropic API" }
                : s);
              return;
            }
            await saveAgentToken(token);
            await saveAgent("claude");
            onClose({ kind: "claude", label: "Claude Code" });
          })
          .catch((err: unknown) => {
            clearTimeout(timer);
            if (!mountedRef.current) return;
            const isTimeout = err instanceof Error && err.name === "AbortError";
            setStep((s) => s.kind === "claude"
              ? { ...s, busy: false, error: isTimeout
                  ? "verification timed out — check network and retry"
                  : "network error — check connection and retry" }
              : s);
          });
        return;
      }
      handleTextKey(input, key, "claude");
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
    kind: "github" | "claude",
  ) {
    if (key.backspace || key.delete) {
      setStep((s) => {
        if (s.kind !== kind) return s;
        const newBuf = s.buf.slice(0, Math.max(0, s.cursorPos - 1)) + s.buf.slice(s.cursorPos);
        return { ...s, buf: newBuf, cursorPos: Math.max(0, s.cursorPos - 1) };
      });
      return;
    }
    if (key.leftArrow)  { setStep((s) => s.kind === kind ? { ...s, cursorPos: Math.max(0, s.cursorPos - 1) } : s); return; }
    if (key.rightArrow) { setStep((s) => s.kind === kind ? { ...s, cursorPos: Math.min(s.buf.length, s.cursorPos + 1) } : s); return; }
    if (input && !key.ctrl && !key.meta) {
      setStep((s) => {
        if (s.kind !== kind) return s;
        const newBuf = s.buf.slice(0, s.cursorPos) + input + s.buf.slice(s.cursorPos);
        return { ...s, buf: newBuf, cursorPos: s.cursorPos + input.length };
      });
    }
  }

  if (step.kind === "provider") {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color="#888888">{"─── login ───────────────────────────────"}</Text>
        {PROVIDERS.map((p, i) => (
          <Box key={p.id}>
            <Text
              color={i === step.idx ? "#ffffff" : "#888888"}
              backgroundColor={i === step.idx ? "#2a2a2a" : undefined}
            >
              {`  ${i === step.idx ? "●" : " "} ${p.label.padEnd(14)}  ${p.desc}`}
            </Text>
          </Box>
        ))}
        <Text color="#555555">{"    ↑↓ navigate · enter select · esc cancel"}</Text>
      </Box>
    );
  }

  if (step.kind === "github") {
    const withCursor = step.buf.slice(0, step.cursorPos) + "│" + step.buf.slice(step.cursorPos);
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color="#888888">{"─── login: GitHub ───────────────────────"}</Text>
        <Text color="#cccccc">{"  GitHub personal access token (repo scope):"}</Text>
        <Box paddingLeft={2}>
          <Text color="#555555">{"❯ "}</Text>
          <Text color="#ffffff">{step.buf.length === 0 && !step.busy ? "│" : withCursor}</Text>
        </Box>
        {step.error && <Text color="#ff8888">{`  ✗ ${step.error}`}</Text>}
        {step.busy
          ? <Text color="#888888">{"  checking…"}</Text>
          : <Text color="#555555">{"  enter to confirm · esc to cancel"}</Text>}
      </Box>
    );
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
