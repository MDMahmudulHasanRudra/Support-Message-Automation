import { requireSession } from "@/server/auth";
import { logout } from "@/server/actions/session";
import { prisma } from "@support-automation/db";
import { Sidebar } from "./Sidebar";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const settings = await prisma.automationSettings.findUnique({ where: { id: "global" } });

  return (
    <div className="flex min-h-screen bg-[var(--color-background)]">
      <Sidebar
        username={session.username}
        automationEnabled={Boolean(settings?.automationEnabled)}
        automationMode={settings?.mode ?? "SAFE_AUTO_REPLY"}
        onLogout={logout}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1560px] p-6">{children}</div>
      </main>
    </div>
  );
}
