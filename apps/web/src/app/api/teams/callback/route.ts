import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/server/auth";
import { handleOAuthCallback } from "@/server/teamsAuth";

export async function GET(request: NextRequest) {
  await requireSession();

  const params = request.nextUrl.searchParams;
  const result = await handleOAuthCallback(
    params.get("code"),
    params.get("state"),
    params.get("error"),
    params.get("error_description"),
  );

  const redirectUrl = new URL("/integrations/teams", request.nextUrl.origin);
  if (!result.ok) {
    redirectUrl.searchParams.set("connectError", result.error);
    if (result.cancelled) redirectUrl.searchParams.set("cancelled", "1");
  } else {
    redirectUrl.searchParams.set("justConnected", "1");
  }
  return NextResponse.redirect(redirectUrl);
}
