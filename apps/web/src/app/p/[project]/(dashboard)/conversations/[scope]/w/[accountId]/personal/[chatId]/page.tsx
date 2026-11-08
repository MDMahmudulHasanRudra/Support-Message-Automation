import { notFound } from "next/navigation";
import { isInboxRouteScope } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { PersonalConversationView } from "../../../../../../chat/PersonalConversationView";

export const metadata = { title: "Conversation" };

/** A WhatsApp personal chat opened in the unified inbox; see the group page beside this one. */
export default async function InboxWhatsAppPersonalPage({
  params,
  searchParams,
}: {
  params: Promise<{ scope: string; accountId: string; chatId: string }>;
  searchParams: Promise<{ contact?: string }>;
}) {
  const { session, canManage: canReply } = await pageAccess("messages.view", "messages.reply", { feature: "WHATSAPP_CHAT", sections: ["/chat"] });
  const { scope, accountId, chatId } = await params;
  if (!isInboxRouteScope(scope)) notFound();
  const { contact } = await searchParams;
  return (
    <PersonalConversationView
      session={session}
      canReply={canReply}
      accountId={accountId}
      chatId={decodeURIComponent(chatId)}
      contact={contact}
      threadPath={(a, c) => `/conversations/${scope}/w/${a}/personal/${encodeURIComponent(c)}`}
      backPath={() => `/conversations/${scope}`}
    />
  );
}
