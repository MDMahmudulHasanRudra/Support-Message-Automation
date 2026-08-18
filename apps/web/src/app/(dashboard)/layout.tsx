import { requireSession } from "@/server/auth";
import { logout } from "@/server/actions/session";
import { prisma } from "@support-automation/db";
import { DashboardShell } from "./DashboardShell";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const settings = await prisma.automationSettings.findUnique({ where: { id: "global" } });

  return (
    <DashboardShell
      username={session.username}
      automationEnabled={Boolean(settings?.automationEnabled)}
      automationMode={settings?.mode ?? "SAFE_AUTO_REPLY"}
      onLogout={logout}
    >
      {children}
    </DashboardShell>
  );
}
