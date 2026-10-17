import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";

/**
 * A client's profile photo (CLIENTS_V3.md §6). Session → project access → `clients.view` (and the
 * CLIENT_CENTER feature, which `checkPermission` applies) → the row through the project-scoped client,
 * so another project's client id is a 404. The bytes were type-sniffed and metadata-stripped on upload;
 * they are served with that type, `nosniff` and a sandboxing CSP, privately cached for a short time and
 * keyed by `?v=` (the client's photoUpdatedAt) so a new photo shows at once.
 */
export const dynamic = "force-dynamic";

const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; sandbox",
} as const;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return new NextResponse("Sign in to view this picture.", { status: 401, headers: { "Cache-Control": "no-store" } });
  const access = await checkPermission("clients.view");
  if ("denied" in access) return new NextResponse(access.denied, { status: 403, headers: { "Cache-Control": "no-store" } });
  const { id } = await params;
  const photo = await prisma.clientPhoto.findFirst({ where: { clientId: id }, select: { mimeType: true, bytes: true, updatedAt: true } });
  if (!photo) return new NextResponse("No photo", { status: 404, headers: { "Cache-Control": "no-store" } });
  const etag = `"client-photo-${id}-${photo.updatedAt.getTime()}"`;
  if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  const body = new Uint8Array(photo.bytes);
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": photo.mimeType, "Content-Length": String(body.byteLength), "Cache-Control": "private, max-age=300", ETag: etag, ...HEADERS },
  });
}
