import { z } from "zod";
import { body, handle } from "@/lib/http";
import { createProvider } from "@/lib/llm";
import { processNote } from "@/lib/pipeline";
import { prisma } from "@/lib/prisma";
import { listMessages } from "@/lib/views";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // the LLM call runs inside the request

const PostSchema = z.object({
  messageId: z.string().min(8).max(128), // generated on the device when the note was started
  mrId: z.string().min(1),
  text: z.string().trim().min(1).max(4000),
  recordedAt: z.string().datetime({ offset: true }).optional(),
  transcript: z.string().max(8000).optional(), // raw speech-to-text output, never edited
  audio: z
    .object({
      mime: z.string().max(100),
      segments: z.number().int().min(1).max(8),
      durationMs: z.number().int().min(0).max(10 * 60_000),
      sttModel: z.string().max(50),
    })
    .optional(),
});

// POST /api/messages — submit a note. Idempotent on messageId.
export async function POST(request: Request) {
  const raw = await body(request);
  return handle(async () => {
    const input = PostSchema.parse(raw);
    return processNote(prisma, createProvider(), {
      messageId: input.messageId,
      mrId: input.mrId,
      text: input.text,
      transcript: input.transcript ?? null,
      audio: input.audio ?? null,
      recordedAt: input.recordedAt ? new Date(input.recordedAt) : new Date(),
      channel: input.transcript ? "WEB_VOICE" : "WEB_TEXT",
    });
  });
}

// GET /api/messages?mrId= — the MR's recent notes with status and review cards.
export function GET(request: Request) {
  const mrId = new URL(request.url).searchParams.get("mrId");
  return handle(async () => listMessages(prisma, z.string().min(1).parse(mrId)));
}
