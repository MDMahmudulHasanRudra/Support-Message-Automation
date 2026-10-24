import { NextResponse, type NextRequest } from "next/server";
import { handleMetaDataDeletion, metaDataDeletionStatus } from "@/server/channels/metaRevocation";

/**
 * Meta's Data Deletion Request URL (App Dashboard → App settings → Basic). POST: Meta forwards a
 * person's request (`signed_request`); the answer is the status URL and a confirmation code, as Meta
 * requires. GET ?code=…: the plain-text status that URL shows.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (Number(request.headers.get("content-length") ?? 0) > 16_384) return new NextResponse(null, { status: 413 });
  let signed: string | null = null;
  try {
    signed = String((await request.formData()).get("signed_request") ?? "") || null;
  } catch {
    signed = null;
  }
  try {
    const result = await handleMetaDataDeletion(signed);
    if (!result.body) return new NextResponse(null, { status: result.status });
    return NextResponse.json(result.body, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[meta] data-deletion callback failed", err);
    return new NextResponse(null, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const text = await metaDataDeletionStatus(request.nextUrl.searchParams.get("code"));
  return new NextResponse(text ?? "No data deletion request with that confirmation code.", {
    status: text ? 200 : 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
