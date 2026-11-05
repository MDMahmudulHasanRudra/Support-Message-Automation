import { NextResponse, type NextRequest } from "next/server";
import { summariseCspReports } from "@/server/cspReports";

/**
 * Where browsers report what the Report-Only Content-Security-Policy WOULD have blocked (next.config.ts).
 * Nothing is blocked yet; these reports are how the policy is checked before it is enforced.
 *
 * Public by necessity (browsers send no session), so it trusts nothing: bodies over 16 KB are refused
 * unread, only the directive, the blocked origin and the page path are kept, and each distinct one is
 * written once per 10 minutes (cspReports.ts). Always 204, so a probe learns nothing.
 */
const MAX_BYTES = 16 * 1024;

export async function POST(request: NextRequest) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) return new NextResponse(null, { status: 204 });
  const body = await request.text();
  if (body.length <= MAX_BYTES) {
    for (const line of summariseCspReports(body)) console.warn(line);
  }
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
