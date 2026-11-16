import { handle } from "@/lib/http";
import { evaluateMessage } from "@/lib/pipeline";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// POST /api/messages/:id/recheck — re-run the deterministic checks (e.g. after
// an admin logged a missing sample receipt). No LLM call.
export function POST(_request: Request, { params }: { params: { id: string } }) {
  return handle(() => evaluateMessage(prisma, params.id));
}
