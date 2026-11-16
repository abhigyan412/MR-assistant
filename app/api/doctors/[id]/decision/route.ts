import { z } from "zod";
import { body, handle } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { decideDoctor } from "@/lib/review";

export const dynamic = "force-dynamic";

const Schema = z.object({ actorId: z.string().min(1), approve: z.boolean() });

// POST /api/doctors/:id/decision — manager approves/rejects an MR-added doctor.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const raw = await body(request);
  return handle(async () => {
    const { actorId, approve } = Schema.parse(raw);
    return decideDoctor(prisma, params.id, actorId, approve);
  });
}
