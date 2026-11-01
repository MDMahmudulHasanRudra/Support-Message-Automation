import { globalPrisma } from "@/server/db";
import { getSession } from "@/server/auth";

/**
 * A person's profile photo (ACCOUNT_SELF_SERVICE.md). Only to a signed-in person of the SAME customer (or the
 * person themselves): a photo is personal data, so it is never public and never cached by a shared cache.
 * The type is the one sniffed at upload; every response carries `nosniff` and a sandboxing CSP.
 */
export const dynamic = "force-dynamic";

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }): Promise<Response> {
  const session = await getSession();
  if (!session) return NOT_FOUND();
  const { userId } = await params;
  const row = await globalPrisma.userAvatar.findUnique({
    where: { userId },
    select: { bytes: true, mimeType: true, version: true, user: { select: { customerId: true } } },
  });
  if (!row) return NOT_FOUND();
  if (userId !== session.userId && (row.user.customerId ?? null) !== (session.tenant ?? null)) return NOT_FOUND();

  const etag = `"avatar-${userId}-${row.version}"`;
  const requested = new URL(request.url).searchParams.get("v");
  const cacheControl = requested === String(row.version) ? "private, max-age=86400" : "private, no-cache";
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl } });
  const body = new Uint8Array(row.bytes);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": row.mimeType,
      "Content-Length": String(body.byteLength),
      "Cache-Control": cacheControl,
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
