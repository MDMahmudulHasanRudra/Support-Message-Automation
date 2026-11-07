import { notFound, redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { projectPath } from "@/server/projectPaths";
import { pageAccess } from "@/server/authorize";
import { ChannelConnectionView } from "./ConnectionView";

export const metadata = { title: "Messaging channel" };

export default async function ChannelConnectionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ connected?: string; warning?: string }> }) {
  await pageAccess("channels.view", "channels.manage", "OMNICHANNEL");
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const row = await prisma.channelConnection.findFirst({ where: { id }, select: { type: true } });
  if (!row) notFound();
  // A website chat widget lives in its own module (WEBSITE_CHAT.md).
  if (row.type === "WEBCHAT") redirect(await projectPath(`/website-chat/widgets/${id}${query.connected || query.warning ? "?connected=1" : ""}`));
  return <ChannelConnectionView id={id} query={query} />;
}
