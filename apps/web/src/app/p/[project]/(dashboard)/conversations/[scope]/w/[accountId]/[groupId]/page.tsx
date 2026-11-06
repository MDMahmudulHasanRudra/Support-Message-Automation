import { notFound } from "next/navigation";
import { isInboxScope } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { GroupConversationView } from "../../../../../chat/GroupConversationView";

export const metadata = { title: "Conversation" };

/**
 * A WhatsApp group opened in the unified inbox: the same view, the same send path and the same checks as
 * WhatsApp Chat, beside the one list. It also needs WhatsApp Chat itself (the feature and, for a project role
 * that selects pages, that page), so the inbox never opens a thread somebody could not read there.
 */
export default async function InboxWhatsAppGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ scope: string; accountId: string; groupId: string }>;
  searchParams: Promise<{ info?: string; contact?: string }>;
}) {
  const { session, canManage: canReply } = await pageAccess("messages.view", "messages.reply", { feature: "WHATSAPP_CHAT", sections: ["/chat"] });
  const { scope, accountId, groupId } = await params;
  if (!isInboxScope(scope)) notFound();
  const { info, contact } = await searchParams;
  return (
    <GroupConversationView
      session={session}
      canReply={canReply}
      accountId={accountId}
      groupId={groupId}
      info={info}
      contact={contact}
      threadPath={(a, g) => `/conversations/${scope}/w/${a}/${g}`}
      backPath={() => `/conversations/${scope}`}
    />
  );
}
