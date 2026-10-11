import { redirect } from "next/navigation";
import { requireAccess } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";

/** `/conversations` opens the unified inbox on every channel together. */
export default async function ConversationsIndex() {
  await requireAccess("messages.view", "OMNICHANNEL");
  redirect(await projectPath("/conversations/all"));
}
