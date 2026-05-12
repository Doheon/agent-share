export async function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([promise, new Promise<void>((r) => setTimeout(r, ms))]);
}
