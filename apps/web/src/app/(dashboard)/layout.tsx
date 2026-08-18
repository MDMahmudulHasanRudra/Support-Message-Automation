import { requireSession } from "@/server/auth";
import { logout } from "@/server/actions/session";
import { prisma } from "@support-automation/db";
import { Sidebar } from "./Sidebar";
import { FloatingAiChat } from "./FloatingAiChat";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const settings = await prisma.automationSettings.findUnique({ where: { id: "global" } });

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-background)]">
      <Sidebar
        username={session.username}
        automationEnabled={Boolean(settings?.automationEnabled)}
        automationMode={settings?.mode ?? "SAFE_AUTO_REPLY"}
        onLogout={logout}
      />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1560px] px-6 py-7 sm:px-8">{children}</div>
      </main>
      <FloatingAiChat />
    </div>
  );
}
