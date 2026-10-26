import { NextResponse, type NextRequest } from "next/server";
import { handleMetaDeauthorize } from "@/server/channels/metaRevocation";

/**
 * Meta's Deauthorize Callback URL (App Dashboard → Facebook Login → Settings): a person removed the
 * platform app on Facebook. Form-encoded `signed_request`, signed with the app secret.
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
    const result = await handleMetaDeauthorize(signed);
    return new NextResponse(null, { status: result.status, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[meta] deauthorize callback failed", err);
    return new NextResponse(null, { status: 500 });
  }
}
