import { NextResponse } from "next/server";
import { requireSession } from "@/server/auth";
import { buildConnectRedirectUrl } from "@/server/teamsAuth";

/**
 * Starts the Microsoft OAuth consent flow — this app's 3rd Route Handler (after /api/health and
 * the Support Activity export endpoint), justified the same way both of those were: a real HTTP
 * redirect to login.microsoftonline.com cannot be triggered from a Server Action.
 */
export async function GET() {
  await requireSession();
  const url = await buildConnectRedirectUrl();
  return NextResponse.redirect(url);
}
