import { requireSession } from "@/server/auth";
import { getGrantedPermissionKeys } from "@/server/permissions";
import { logout } from "@/server/actions/session";
import { prisma } from "@support-automation/db";
import { DashboardShell } from "./DashboardShell";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const [settings, grantedKeys] = await Promise.all([
    prisma.automationSettings.findUnique({ where: { id: "global" } }),
    // For what the shell SHOWS — which links, whether the assistant. Every page and action still
    // makes its own check; this only stops the sidebar offering pages that would refuse.
    getGrantedPermissionKeys(session),
  ]);

  return (
    <DashboardShell
      username={session.username}
      automationEnabled={Boolean(settings?.automationEnabled)}
      automationMode={settings?.mode ?? "SAFE_AUTO_REPLY"}
      onLogout={logout}
      grantedKeys={grantedKeys}
    >
      {children}
    </DashboardShell>
  );
}
