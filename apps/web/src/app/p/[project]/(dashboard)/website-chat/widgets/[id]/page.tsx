import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { pageAccess } from "@/server/authorize";
import { ChannelConnectionView } from "../../../settings/channels/[id]/ConnectionView";

export const metadata = { title: "Widget" };

/** One widget's builder: the same view Settings used, now in its own module. */
export default async function WidgetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ connected?: string; warning?: string }> }) {
  await pageAccess("channels.view", "channels.manage", "OMNICHANNEL");
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const row = await prisma.channelConnection.findFirst({ where: { id, type: "WEBCHAT" }, select: { id: true } });
  if (!row) notFound();
  return <ChannelConnectionView id={id} query={query} />;
}
