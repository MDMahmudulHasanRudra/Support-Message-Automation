import { redirect } from "next/navigation";
import { requireAccess } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { getChatAccounts } from "@/server/chatInbox";
import { ChatAccountChooser } from "./ChatAccountChooser";

export const metadata = { title: "WhatsApp Chat" };

/**
 * /chat: which WhatsApp account to work in.
 *
 * There is no combined inbox. With one account there is nothing to choose, so it opens directly.
 * With several, the operator picks one — the chooser forwards to the account last used in this
 * browser when it is still one of this project's, so the choice is made once, not on every visit.
 * The account then stays in the URL (`/chat/account/<id>/…`), which every tab keeps for itself.
 */
export default async function ChatIndexPage() {
  await requireAccess("messages.view");
  const accounts = await getChatAccounts();
  if (accounts.length === 1) redirect(await projectPath(`/chat/account/${accounts[0]!.id}`));
  return <ChatAccountChooser accounts={accounts} />;
}
