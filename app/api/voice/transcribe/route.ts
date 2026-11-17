import { NextResponse } from "next/server";
import { putAudioSegment } from "@/lib/audio";
import { loadMrContext } from "@/lib/context";
import { keytermsFor } from "@/lib/keyterms";
import { prisma } from "@/lib/prisma";
import { SarvamError, transcribe } from "@/lib/sarvam";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BYTES = 3 * 1024 * 1024; // a 25 s segment at ~24 kbps is ~80 KB; Vercel's body cap is 4.5 MB
const MAX_SEGMENTS = 8; // 8 x 25 s > the 2-minute recording cap

// POST /api/voice/transcribe (multipart: audio, messageId, segment, mrId)
// One recorded segment -> stored audio + raw transcript. The message id was
// created on the device when recording started, so a retried segment
// overwrites the same object (idempotent). The note itself is submitted
// separately (POST /api/messages) after the MR has seen/edited the text.
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }
  const audio = form.get("audio");
  const messageId = String(form.get("messageId") ?? "");
  const segment = Number(form.get("segment"));
  const mrId = String(form.get("mrId") ?? "");

  if (!(audio instanceof Blob) || audio.size === 0) return NextResponse.json({ error: "Missing audio" }, { status: 400 });
  if (audio.size > MAX_BYTES) return NextResponse.json({ error: "Recording segment too large" }, { status: 413 });
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(messageId)) return NextResponse.json({ error: "Invalid messageId" }, { status: 400 });
  if (!Number.isInteger(segment) || segment < 0 || segment >= MAX_SEGMENTS) return NextResponse.json({ error: "Invalid segment" }, { status: 400 });

  const mr = mrId ? await prisma.user.findUnique({ where: { id: mrId } }) : null;
  if (!mr || mr.role !== "MR") return NextResponse.json({ error: "Unknown MR" }, { status: 404 });

  const bytes = new Uint8Array(await audio.arrayBuffer());
  const mime = audio.type || "audio/webm";
  const ctx = await loadMrContext(prisma, mr.companyId, mr.id);

  try {
    // Store and transcribe in parallel; a storage failure must not lose the transcript.
    const [stored, result] = await Promise.all([
      putAudioSegment(messageId, segment, bytes, mime).catch((err: unknown) => {
        console.error("audio store failed", err);
        return null;
      }),
      transcribe(bytes, mime, keytermsFor(ctx)),
    ]);
    return NextResponse.json({
      segment,
      transcript: result.transcript,
      languageCode: result.languageCode,
      model: result.model,
      stored: stored !== null,
    });
  } catch (err) {
    if (err instanceof SarvamError) return NextResponse.json({ error: err.message }, { status: 502 });
    console.error(err);
    return NextResponse.json({ error: "Transcription failed" }, { status: 500 });
  }
}
