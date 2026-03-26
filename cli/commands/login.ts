/**
 * ash login  — Supabase 이메일/패스워드 인증
 * ash logout — 세션 삭제
 */

import { Command } from "cliffy/command";
import { getClient, saveConfig } from "../client.ts";

async function runLogin(): Promise<void> {
  const email = prompt("이메일: ");
  const password = prompt("패스워드: ");

  if (!email || !password) {
    throw new Error("이메일과 패스워드를 입력해주세요.");
  }

  const client = await getClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    throw new Error(`로그인 실패: ${error?.message ?? "알 수 없는 오류"}`);
  }

  // public_key 등록 여부 확인 (없으면 setup 유도)
  const { data: userRow } = await client
    .from("users")
    .select("id")
    .eq("id", data.user.id)
    .single();

  console.log(`\n✅ 로그인 성공: ${data.user.email}`);

  if (!userRow) {
    console.log(`\n⚠️  프로필이 없습니다. 다음을 실행해주세요:`);
    console.log(`   ash setup`);
  }
}

async function runLogout(): Promise<void> {
  const client = await getClient();
  const { error } = await client.auth.signOut();
  if (error) throw new Error(`로그아웃 실패: ${error.message}`);
  console.log("\n✅ 로그아웃 완료");
}

async function runSignup(): Promise<void> {
  const email = prompt("이메일: ");
  const password = prompt("패스워드: ");
  const password2 = prompt("패스워드 확인: ");

  if (!email || !password) {
    throw new Error("이메일과 패스워드를 입력해주세요.");
  }

  if (password !== password2) {
    throw new Error("패스워드가 일치하지 않습니다.");
  }

  const client = await getClient();
  const { data, error } = await client.auth.signUp({ email, password });

  if (error || !data.user) {
    throw new Error(`회원가입 실패: ${error?.message ?? "알 수 없는 오류"}`);
  }

  console.log(`\n✅ 회원가입 완료: ${data.user.email}`);
  console.log(`   이메일 인증 후 ash setup 을 실행해주세요.`);
}

export const loginCommand = new Command()
  .name("login")
  .description("Supabase 계정으로 로그인")
  .action(async () => {
    try {
      await runLogin();
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });

export const logoutCommand = new Command()
  .name("logout")
  .description("로그아웃")
  .action(async () => {
    try {
      await runLogout();
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });

export const signupCommand = new Command()
  .name("signup")
  .description("새 계정 생성")
  .action(async () => {
    try {
      await runSignup();
    } catch (err) {
      console.error(`\n❌ 오류:`, (err as Error).message);
      Deno.exit(1);
    }
  });
