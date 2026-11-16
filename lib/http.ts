import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { NotFoundError } from "./pipeline";
import { ReviewError } from "./review";

// Shared error mapping for API routes. No auth until Phase 4: callers pass
// mrId/actorId explicitly (demo only).

export function handle(fn: () => Promise<unknown>) {
  return fn()
    .then((result) => NextResponse.json(result))
    .catch((err: unknown) => {
      if (err instanceof ZodError) return NextResponse.json({ error: "Invalid request", issues: err.issues }, { status: 400 });
      if (err instanceof NotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
      if (err instanceof ReviewError) return NextResponse.json({ error: err.message }, { status: 409 });
      console.error(err);
      return NextResponse.json({ error: err instanceof Error ? err.message : "Internal error" }, { status: 500 });
    });
}

export async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
