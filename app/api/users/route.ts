import { handle } from "@/lib/http";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/users — people for the demo pickers (MR / manager / admin).
export function GET() {
  return handle(async () =>
    prisma.user.findMany({
      orderBy: [{ role: "asc" }, { name: "asc" }],
      select: { id: true, name: true, role: true, territory: { select: { name: true } } },
    })
  );
}
