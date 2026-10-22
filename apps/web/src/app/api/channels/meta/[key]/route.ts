import { NextResponse, type NextRequest } from "next/server";
import { ingestMetaWebhook, MAX_WEBHOOK_BYTES, verifyMetaSubscription, type WebhookAnswer } from "@/server/channels/webhookIngest";

/**
 * Meta's webhook for Facebook Messenger and Instagram DM (OMNICHANNEL.md §7). Outside any project:
 * the unguessable key in the path names the connection, and the connection names the project.
 *
 * GET is Meta's one-time verification when the callback URL is saved in the app dashboard; POST is
 * every event, signed with the app secret. Nothing here needs a session — the signature is the
 * authentication — and nothing is processed on the request: events are recorded and acknowledged.
 */
export const dynamic = "force-dynamic";

function answer(result: WebhookAnswer): NextResponse {
  return new NextResponse(result.body, {
    status: result.status,
    headers: { "Content-Type": result.contentType ?? "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }): Promise<NextResponse> {
  const { key } = await params;
  const q = request.nextUrl.searchParams;
  return answer(await verifyMetaSubscription({ key, mode: q.get("hub.mode"), token: q.get("hub.verify_token"), challenge: q.get("hub.challenge") }));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ key: string }> }): Promise<NextResponse> {
  const { key } = await params;
  if (Number(request.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) return answer({ status: 413, body: "Too large" });
  const rawBody = Buffer.from(await request.arrayBuffer());
  if (rawBody.length > MAX_WEBHOOK_BYTES) return answer({ status: 413, body: "Too large" });
  try {
    return answer(await ingestMetaWebhook({ key, rawBody, signature: request.headers.get("x-hub-signature-256") }));
  } catch (err) {
    // A failure to RECORD the event: 500, so Meta retries it rather than it being lost.
    console.error("[channels] could not record a Meta webhook", err);
    return answer({ status: 500, body: "Try again" });
  }
}
