import { pageAccess } from "@/server/authorize";
import { GroupConversationView } from "../../../GroupConversationView";

export const metadata = { title: "WhatsApp Chat" };

/** One account's copy of a WhatsApp group, inside WhatsApp Chat. The view is shared with the unified inbox. */
export default async function ChatConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string; groupId: string }>;
  searchParams: Promise<{ info?: string; contact?: string }>;
}) {
  // Its own check rather than relying on the chat layout's: Next does not re-render a layout on
  // navigation within it, so a layout-only check would miss a role changed mid-session.
  const { session, canManage: canReply } = await pageAccess("messages.view", "messages.reply");
  const { accountId, groupId } = await params;
  const { info, contact } = await searchParams;
  return (
    <GroupConversationView
      session={session}
      canReply={canReply}
      accountId={accountId}
      groupId={groupId}
      info={info}
      contact={contact}
      threadPath={(a, g) => `/chat/account/${a}/${g}`}
      backPath={(a) => `/chat/account/${a}`}
    />
  );
}
