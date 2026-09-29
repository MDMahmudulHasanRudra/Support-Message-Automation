import { WorkspaceModuleStart } from "../WorkspaceModuleStart";

export const metadata = { title: "WhatsApp Chat" };

export default async function WhatsAppChatWorkspace({ searchParams }: { searchParams: Promise<{ unavailable?: string }> }) {
  return <WorkspaceModuleStart moduleKey="whatsapp-chat" unavailable={Boolean((await searchParams).unavailable)} />;
}
