import type { ConversationRef } from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import { loadWorkspace } from "@/server/inboxWorkspace";
import { WorkspacePanel } from "./WorkspacePanel";

/**
 * The inbox workspace side panel for one conversation (INBOX_WORKSPACE.md): Details (priority, tags,
 * Team), internal Notes and the AI Copilot. Renders nothing unless the project has
 * INBOX_COLLABORATION or AI_COPILOT on and the viewer may read the conversation — so dropping it into
 * a page changes nothing for a project that has not switched it on.
 */
export async function ConversationWorkspace({ conversation }: { conversation: ConversationRef }) {
  const session = await requireSession();
  const data = await loadWorkspace(session, conversation);
  if (!data) return null;
  return <WorkspacePanel data={data} />;
}
