import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/demo-gate";
import { prisma } from "@/lib/prisma";
import { runAudioRetention } from "@/lib/retention";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/audio-cleanup — Vercel Cron (daily, see vercel.json) sends
// "Authorization: Bearer $CRON_SECRET". Deletes audio older than
// AUDIO_RETENTION_DAYS. Not behind the demo passcode (middleware skips it);
// the secret is the only key.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runAudioRetention(prisma));
}
