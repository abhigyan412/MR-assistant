import { z } from "zod";
import { body, handle } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { resolveReviewItem } from "@/lib/review";

export const dynamic = "force-dynamic";

const Schema = z.object({ actorId: z.string().min(1), resolution: z.unknown() });

// POST /api/review-items/:id/resolve — one-tap answer to a review card.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const raw = await body(request);
  return handle(async () => {
    const { actorId, resolution } = Schema.parse(raw);
    return resolveReviewItem(prisma, params.id, actorId, resolution);
  });
}
