import { NextResponse, type NextRequest } from "next/server";
import { ingestShopWebhook, MAX_SHOP_WEBHOOK_BYTES, type ShopWebhookAnswer } from "@/server/integrations/shopWebhook";

/**
 * A WooCommerce shop's or Shopify store's webhooks (COMMERCE_INTEGRATIONS.md §Webhooks). Outside any
 * project: the key in the path names the connection; the provider's HMAC signature proves the body.
 */
export const dynamic = "force-dynamic";

function answer(result: ShopWebhookAnswer): NextResponse {
  return new NextResponse(result.body, { status: result.status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ key: string }> }): Promise<NextResponse> {
  const { key } = await params;
  if (Number(request.headers.get("content-length") ?? 0) > MAX_SHOP_WEBHOOK_BYTES) return answer({ status: 413, body: "Too large" });
  const rawBody = Buffer.from(await request.arrayBuffer());
  if (rawBody.length > MAX_SHOP_WEBHOOK_BYTES) return answer({ status: 413, body: "Too large" });
  try {
    return answer(await ingestShopWebhook({ key, rawBody, headers: request.headers }));
  } catch (err) {
    // Not applied: 500, so the shop retries it.
    console.error("[shops] could not apply a webhook", (err as Error).name);
    return answer({ status: 500, body: "Try again" });
  }
}
