/**
 * Supabase 클라이언트 싱글톤 + 설정 관리
 * 설정 파일: ~/.agent-share/config.json
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { join } from "@std/path";

const CONFIG_PATH = join(
  Deno.env.get("HOME") ?? "~",
  ".agent-share",
  "config.json",
);

export interface AgentShareConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  userId?: string;
  accessToken?: string;
}

let _client: SupabaseClient | null = null;
let _config: AgentShareConfig | null = null;

export async function loadConfig(): Promise<AgentShareConfig> {
  if (_config) return _config;

  // 환경변수 우선
  const envUrl = Deno.env.get("AGENT_SHARE_SUPABASE_URL");
  const envKey = Deno.env.get("AGENT_SHARE_SUPABASE_ANON_KEY");

  if (envUrl && envKey) {
    _config = { supabaseUrl: envUrl, supabaseAnonKey: envKey };
    return _config;
  }

  try {
    const raw = await Deno.readTextFile(CONFIG_PATH);
    _config = JSON.parse(raw) as AgentShareConfig;
    return _config;
  } catch {
    throw new Error(
      `설정 파일을 찾을 수 없습니다: ${CONFIG_PATH}\n` +
        `ash setup 을 먼저 실행하거나 환경변수를 설정해주세요:\n` +
        `  AGENT_SHARE_SUPABASE_URL=...\n` +
        `  AGENT_SHARE_SUPABASE_ANON_KEY=...`,
    );
  }
}

export async function saveConfig(config: Partial<AgentShareConfig>): Promise<void> {
  const current = await loadConfig().catch(() => ({} as AgentShareConfig));
  const merged = { ...current, ...config };
  await Deno.mkdir(join(Deno.env.get("HOME") ?? "~", ".agent-share"), {
    recursive: true,
  });
  await Deno.writeTextFile(CONFIG_PATH, JSON.stringify(merged, null, 2), {
    mode: 0o600,
  });
  _config = merged;
}

export async function getClient(): Promise<SupabaseClient> {
  if (_client) return _client;
  const config = await loadConfig();
  _client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      storage: {
        getItem: async (key: string) => {
          try {
            const data = await Deno.readTextFile(
              join(Deno.env.get("HOME") ?? "~", ".agent-share", `${key}.json`),
            );
            return data;
          } catch {
            return null;
          }
        },
        setItem: async (key: string, value: string) => {
          await Deno.writeTextFile(
            join(Deno.env.get("HOME") ?? "~", ".agent-share", `${key}.json`),
            value,
            { mode: 0o600 },
          );
        },
        removeItem: async (key: string) => {
          try {
            await Deno.remove(
              join(Deno.env.get("HOME") ?? "~", ".agent-share", `${key}.json`),
            );
          } catch { /* 없으면 무시 */ }
        },
      },
    },
  });
  return _client;
}

export async function getCurrentUserId(): Promise<string> {
  const client = await getClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) {
    throw new Error("로그인이 필요합니다. ash login 을 실행해주세요.");
  }
  return user.id;
}
