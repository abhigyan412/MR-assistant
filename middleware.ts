import { NextResponse, type NextRequest } from "next/server";
import { GATE_COOKIE, gateToken, safeEqual } from "./lib/demo-gate";

// Demo passcode gate — see lib/demo-gate.ts.
export async function middleware(request: NextRequest) {
  const passcode = process.env.DEMO_PASSCODE;
  if (!passcode) return NextResponse.next();

  const cookie = request.cookies.get(GATE_COOKIE)?.value ?? "";
  if (cookie && safeEqual(cookie, await gateToken(passcode))) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Enter the demo passcode first." }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/unlock";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the unlock page/endpoint and static assets.
  matcher: ["/((?!unlock|api/unlock|_next/static|_next/image|favicon.ico|icon|robots.txt).*)"],
};
