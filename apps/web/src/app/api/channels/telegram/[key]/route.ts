import { NextResponse, type NextRequest } from "next/server";
import { ingestTelegramWebhook, MAX_WEBHOOK_BYTES, readWebhookBody, type WebhookAnswer } from "@/server/channels/webhookIngest";

/**
 * A Telegram bot's webhook (OMNICHANNEL.md §7), registered by this app with `setWebhook`. Outside any
 * project: the unguessable key in the path names the connection. Telegram proves itself with the
 * secret it was given at registration, in X-Telegram-Bot-Api-Secret-Token. Updates are recorded and
 * acknowledged; the worker processes them.
 */
export const dynamic = "force-dynamic";

function answer(result: WebhookAnswer): NextResponse {
  return new NextResponse(result.body, { status: result.status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ key: string }> }): Promise<NextResponse> {
  const { key } = await params;
  const rawBody = await readWebhookBody(request, MAX_WEBHOOK_BYTES);
  if (!rawBody) return answer({ status: 413, body: "Too large" });
  try {
    return answer(await ingestTelegramWebhook({ key, rawBody, secret: request.headers.get("x-telegram-bot-api-secret-token") }));
  } catch (err) {
    // A failure to RECORD the update: 500, so Telegram retries it rather than it being lost.
    console.error("[channels] could not record a Telegram webhook", err);
    return answer({ status: 500, body: "Try again" });
  }
}
