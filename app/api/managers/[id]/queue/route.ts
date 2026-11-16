import { handle } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { managerQueue } from "@/lib/views";

export const dynamic = "force-dynamic";

// GET /api/managers/:id/queue — adverse events, doctors to approve, MR items left open.
export function GET(_request: Request, { params }: { params: { id: string } }) {
  return handle(() => managerQueue(prisma, params.id));
}
