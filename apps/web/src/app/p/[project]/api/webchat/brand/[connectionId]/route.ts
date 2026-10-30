import { NextResponse } from "next/server";
import { WEBCHAT_BRAND_MAX_BYTES } from "@support-automation/shared";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { addWidgetAsset, WebchatError } from "@/server/channels/webchat";
import { logSystemEvent } from "@/server/logSystemEvent";

/**
 * Uploads a brand image for a website chat widget (Website Chat V3): a logo, a launcher icon, or a team member's
 * photo. channels.manage. A Route Handler because it carries a file. The type comes from the bytes (JPEG / PNG /
 * WebP, never SVG), 512 KB at most. A team photo needs the member's display name and an explicit confirmation that
 * the person agreed to be shown on the website — recorded with who confirmed it and when (and in the System Log).
 */
export const dynamic = "force-dynamic";

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  if (!(await getSession())) return json({ error: "Sign in first." }, 401);
  const access = await checkPermission("channels.manage", "OMNICHANNEL");
  if ("denied" in access) return json({ error: access.denied }, 403);
  if (Number(request.headers.get("content-length") ?? 0) > WEBCHAT_BRAND_MAX_BYTES + 32_000) return json({ error: "Images for the widget can be at most 512 KB." }, 413);
  const { connectionId } = await params;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "The image could not be read. Try again." }, 400);
  }
  const file = form.get("file");
  const kind = String(form.get("kind") ?? "");
  if (!(file instanceof File)) return json({ error: "Choose an image first." }, 400);
  if (kind !== "LOGO" && kind !== "ICON" && kind !== "AVATAR") return json({ error: "Unknown image kind." }, 400);
  try {
    const result = await addWidgetAsset(connectionId, {
      kind,
      bytes: Buffer.from(await file.arrayBuffer()),
      username: access.session.username,
      name: String(form.get("name") ?? ""),
      consent: form.get("consent") === "yes",
    });
    await logSystemEvent(
      "INFO",
      "channels",
      kind === "AVATAR" ? "Website chat team photo added with the person's consent confirmed" : "Website chat image added",
      { kind, ...(kind === "AVATAR" ? { name: String(form.get("name") ?? "").slice(0, 40) } : {}) },
      { actorUserId: access.session.userId, targetType: "ChannelConnection", targetId: connectionId },
    );
    return json({ ok: true, assetId: result.assetId }, 201);
  } catch (err) {
    if (err instanceof WebchatError) return json({ error: err.message }, err.status);
    console.error("[webchat] brand upload failed", (err as Error).name);
    return json({ error: "Something went wrong on the server. The image was not saved." }, 500);
  }
}
