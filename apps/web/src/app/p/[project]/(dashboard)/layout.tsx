import { prisma } from "@/server/db";
import { requireSession } from "@/server/auth";
import { requireProjectPage } from "@/server/authorize";
import { getGrantedPermissionKeys } from "@/server/permissions";
import { logout } from "@/server/actions/session";

import { DashboardShell } from "./DashboardShell";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  // The project step before anything else renders: a project this user cannot enter is a 404,
  // whatever the page below would have shown (MULTI_PROJECT_PLAN.md §7).
  await requireProjectPage();
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
