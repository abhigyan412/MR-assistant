import { handle } from "@/lib/http";
import { createProvider } from "@/lib/llm";
import { retryMessage } from "@/lib/pipeline";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // the LLM call runs inside the request

// POST /api/messages/:id/retry — re-process a FAILED note, or one stuck in
// processing (request dropped). Uses the stored note text; never duplicates.
export function POST(_request: Request, { params }: { params: { id: string } }) {
  return handle(() => retryMessage(prisma, createProvider(), params.id));
}
