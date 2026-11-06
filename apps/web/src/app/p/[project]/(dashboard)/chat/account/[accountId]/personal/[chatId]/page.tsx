import { pageAccess } from "@/server/authorize";
import { PersonalConversationView } from "../../../../PersonalConversationView";

export const metadata = { title: "WhatsApp Chat" };

/** One personal (1:1) chat of one account, inside WhatsApp Chat. The view is shared with the unified inbox. */
export default async function PersonalChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string; chatId: string }>;
  searchParams: Promise<{ contact?: string }>;
}) {
  // Its own check rather than relying on the chat layout's (see the group conversation page).
  const { session, canManage: canReply } = await pageAccess("messages.view", "messages.reply");
  const { accountId, chatId } = await params;
  const { contact } = await searchParams;
  return (
    <PersonalConversationView
      session={session}
      canReply={canReply}
      accountId={accountId}
      chatId={decodeURIComponent(chatId)}
      contact={contact}
      threadPath={(a, c) => `/chat/account/${a}/personal/${encodeURIComponent(c)}`}
      backPath={(a) => `/chat/account/${a}?type=personal`}
    />
  );
}
