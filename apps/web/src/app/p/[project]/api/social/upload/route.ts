import { NextResponse, type NextRequest } from "next/server";
import { SOCIAL_VIDEO_MAX_BYTES } from "@support-automation/shared";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { cleanFolder, SocialMediaError, uploadSocialAsset } from "@/server/social/media";

/**
 * Upload to the Social Studio media library (SOCIAL_STUDIO.md §Media): `social.edit` with Social Studio
 * on. A Route Handler rather than an action because a file can be large; the type is read from the
 * bytes and every limit is checked by `uploadSocialAsset`.
 */
export const dynamic = "force-dynamic";

const answer = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return answer(401, { error: "Sign in first." });
  const access = await checkPermission("social.edit", "SOCIAL_STUDIO");
  if ("denied" in access) return answer(403, { error: access.denied });
  if (Number(request.headers.get("content-length") ?? 0) > SOCIAL_VIDEO_MAX_BYTES + 1_000_000) return answer(413, { error: "The file is too large." });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return answer(400, { error: "Send the file as a form upload." });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return answer(400, { error: "No file was sent." });
  if (file.size > SOCIAL_VIDEO_MAX_BYTES) return answer(413, { error: "The file is too large." });
  try {
    const asset = await uploadSocialAsset({ bytes: Buffer.from(await file.arrayBuffer()), fileName: file.name || "file", folder: cleanFolder(form.get("folder")), username: session.username });
    return answer(201, { asset });
  } catch (err) {
    if (err instanceof SocialMediaError) return answer(400, { error: err.message });
    console.error("[social] upload failed", (err as Error).name);
    return answer(500, { error: "The file could not be saved. Try again." });
  }
}
