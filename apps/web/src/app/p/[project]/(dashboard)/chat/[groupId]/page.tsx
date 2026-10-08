import { notFound, redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { requireAccess } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";

/**
 * The old conversation URL, `/chat/<groupId>`, still linked from Unanswered Groups, Response Time,
 * AI Activity, Team Performance and the Team Report. A group row belongs to exactly one account, so
 * the link opens that conversation in its own account's workspace. The scoped client means another
 * project's group is simply not found.
 */
export default async function LegacyConversationRedirect({ params }: { params: Promise<{ groupId: string }> }) {
  await requireAccess("messages.view");
  const { groupId } = await params;
  const group = await prisma.whatsAppGroup.findUnique({ where: { id: groupId }, select: { id: true, accountId: true } });
  if (!group) notFound();
  redirect(await projectPath(`/chat/account/${group.accountId}/${group.id}`));
}
