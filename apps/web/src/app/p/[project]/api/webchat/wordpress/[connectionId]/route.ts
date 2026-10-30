import { NextResponse } from "next/server";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { prisma } from "@/server/db";
import { widgetScriptUrl } from "@/server/channels/webchat";
import { wordpressPluginFiles } from "@/server/channels/webchatWordpress";
import { buildZip } from "@/server/zip";

/** The WordPress plugin for one website chat widget, as a zip (WEBSITE_CHAT.md §WordPress). channels.manage. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  if (!(await getSession())) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const access = await checkPermission("channels.manage", "OMNICHANNEL");
  if ("denied" in access) return NextResponse.json({ error: access.denied }, { status: 403 });
  const { connectionId } = await params;
  const row = await prisma.channelConnection.findFirst({
    where: { id: connectionId, type: "WEBCHAT" },
    select: { name: true, webhookKey: true, status: true },
  });
  if (!row || row.status === "DISCONNECTED") return NextResponse.json({ error: "That widget no longer exists." }, { status: 404 });
  const scriptUrl = widgetScriptUrl();
  if (!scriptUrl) return NextResponse.json({ error: "This server's public address (NEXTAUTH_URL) is not set." }, { status: 503 });
  const zip = buildZip(wordpressPluginFiles({ scriptUrl, widgetKey: row.webhookKey, widgetName: row.name }));
  return new NextResponse(new Uint8Array(zip), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="getassist-chat.zip"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
