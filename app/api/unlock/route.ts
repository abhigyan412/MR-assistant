import { NextResponse } from "next/server";
import { GATE_COOKIE, GATE_MAX_AGE_S, gateToken, safeEqual } from "@/lib/demo-gate";

export const dynamic = "force-dynamic";

// POST /api/unlock {code} — checks the demo passcode and sets the gate cookie.
export async function POST(request: Request) {
  const passcode = process.env.DEMO_PASSCODE;
  if (!passcode) return NextResponse.json({ ok: true }); // gate off (local dev)

  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === "string" ? body.code.trim().toLowerCase() : "";
  if (!safeEqual(code, passcode.trim().toLowerCase())) {
    // Slow down guessing a little; a real login is Phase 4.
    await new Promise((r) => setTimeout(r, 800));
    return NextResponse.json({ error: "Wrong passcode" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(GATE_COOKIE, await gateToken(passcode), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: GATE_MAX_AGE_S,
  });
  return res;
}
