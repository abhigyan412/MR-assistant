// Demo passcode gate (NOT user auth — that's Phase 4). When DEMO_PASSCODE is
// set (the Vercel deployment), every page and API call needs a cookie that
// proves the passcode was entered once on this device. Unset = gate off
// (local development). Runs in the Edge runtime (middleware): Web Crypto only.

export const GATE_COOKIE = "demo_gate";
export const GATE_MAX_AGE_S = 30 * 24 * 60 * 60; // re-enter monthly

/** Cookie value: a hash, so the passcode itself never sits in the browser. */
export async function gateToken(passcode: string): Promise<string> {
  const data = new TextEncoder().encode(`mr-assistant-demo:${passcode}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
