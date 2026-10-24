import { NextResponse, type NextRequest } from "next/server";
import { ingestPlatformMetaWebhook, MAX_PLATFORM_WEBHOOK_BYTES, type WebhookAnswer } from "@/server/channels/webhookIngest";
import { secretsEqual } from "@/server/channels/connections";
import { metaPlatformConfig } from "@/server/channels/metaOAuth";

/**
 * The PLATFORM Meta app's webhook (docs/meta-integration/05): the Callback URL entered once in the
 * app's dashboard for both the Page and the Instagram objects. Outside any project and without a
 * session — the signature is the authentication. Events are recorded and acknowledged; the worker
 * processes them. While the integration is off (or misconfigured) the route does not exist.
 *
 * Manual connections keep their own per-connection route, /api/channels/meta/<key>.
 */
export const dynamic = "force-dynamic";

function answer(result: WebhookAnswer): NextResponse {
  return new NextResponse(result.body, {
    status: result.status,
    headers: { "Content-Type": result.contentType ?? "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = metaPlatformConfig();
  if (!config.ok) return answer({ status: 404, body: "Not found" });
  const q = request.nextUrl.searchParams;
  const challenge = q.get("hub.challenge");
  if (q.get("hub.mode") !== "subscribe" || !challenge || !secretsEqual(q.get("hub.verify_token"), config.config.webhookVerifyToken)) return answer({ status: 403, body: "Forbidden" });
  // Echoed verbatim; limited to what Meta sends, so this cannot reflect arbitrary text.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(challenge)) return answer({ status: 403, body: "Forbidden" });
  return answer({ status: 200, body: challenge, contentType: "text/plain" });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = metaPlatformConfig();
  if (!config.ok) return answer({ status: 404, body: "Not found" });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_PLATFORM_WEBHOOK_BYTES) return answer({ status: 413, body: "Too large" });
  const rawBody = Buffer.from(await request.arrayBuffer());
  if (rawBody.length > MAX_PLATFORM_WEBHOOK_BYTES) return answer({ status: 413, body: "Too large" });
  try {
    return answer(await ingestPlatformMetaWebhook({ rawBody, signature: request.headers.get("x-hub-signature-256"), appSecret: config.config.appSecret }));
  } catch (err) {
    // A failure to RECORD the events: 500, so Meta retries rather than the events being lost.
    console.error("[channels] could not record a platform Meta webhook", err);
    return answer({ status: 500, body: "Try again" });
  }
}
