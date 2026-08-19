import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { SecuritySettingsForm } from "./SecuritySettingsForm";

export default async function SecuritySettingsPage() {
  const session = await requireSession();
  await requirePermission(session, "security_settings.view");

  const settings = await prisma.securitySettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  return (
    <div>
      <PageHeader
        title="Security Settings"
        description="Session lifetime, login lockout, and emergency session revocation."
        actions={
          <HelpButton moduleTitle="Security Settings">
            <HelpSection title="Session Lifetime">
              <p>
                Applies only to sessions created after you save — a session already issued keeps
                the expiry it was given when it was created, so changing this setting never
                unexpectedly logs anyone out early or extends an already-issued session.
              </p>
            </HelpSection>
            <HelpSection title="Danger Zone">
              <p>
                Force-signs out App Users from every device immediately, without waiting for
                their session to expire naturally. "Except Mine" is the safer default and cannot
                lock you out mid-action; the "Including Mine" option will redirect you to the
                login page too.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <SecuritySettingsForm settings={settings} />
    </div>
  );
}
