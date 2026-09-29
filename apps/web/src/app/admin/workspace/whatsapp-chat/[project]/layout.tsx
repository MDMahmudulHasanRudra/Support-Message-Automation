import ChatLayout from "@/app/p/[project]/(dashboard)/chat/layout";
import { WorkspaceModuleFrame } from "../../WorkspaceModuleFrame";

/**
 * WhatsApp Chat in the Main Admin Workspace: the project tabs around the project portal's OWN chat
 * layout. Nothing of the inbox is re-implemented here; the pages beside this file re-export the
 * portal's pages, and they run in the project named by the URL (lib/workspace.ts).
 */
export default async function WorkspaceChatLayout({ children, params }: { children: React.ReactNode; params: Promise<{ project: string }> }) {
  const { project } = await params;
  return (
    <WorkspaceModuleFrame moduleKey="whatsapp-chat" slug={project}>
      <ChatLayout>{children}</ChatLayout>
    </WorkspaceModuleFrame>
  );
}
