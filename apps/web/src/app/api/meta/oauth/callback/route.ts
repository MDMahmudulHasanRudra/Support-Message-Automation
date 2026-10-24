import { NextResponse, type NextRequest } from "next/server";
import { completeMetaCallback } from "@/server/channels/metaOAuth";

/**
 * Where Meta sends the browser back after its dialog (docs/meta-integration/05). ONE fixed address for
 * the whole installation — the redirect URI registered in the platform's Meta app — so it works
 * whichever customer address the person started from.
 *
 * It needs no session: the single-use state names the attempt, and nothing here can connect a Page.
 * It only redeems the code and sends the browser back to the address it came from, where the same
 * person, in the same browser, has to claim the result before anything is shown or saved.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  let target: string;
  try {
    target = (await completeMetaCallback({ params: request.nextUrl.searchParams })).redirect;
  } catch (err) {
    console.error("[meta] the Facebook callback failed", err);
    target = `${request.nextUrl.origin}/open?next=${encodeURIComponent("/settings/channels?meta_error=exchange_failed")}`;
  }
  const response = NextResponse.redirect(target, 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
