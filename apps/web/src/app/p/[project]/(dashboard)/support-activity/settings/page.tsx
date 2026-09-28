import { prisma } from "@/server/db";
import Link from "@/components/ProjectLink";

import { pageAccess } from "@/server/authorize";
import { ButtonLink, Card, HelpButton, HelpSection, PageHeader, SectionHeader, ViewOnlyNotice } from "@/components/ui";
import { SupportActivitySettingsForm } from "./SupportActivitySettingsForm";

export default async function SupportActivitySettingsPage() {
  const { canManage } = await pageAccess("support_activity.view", "support_activity.manage");
  const settings = await prisma.supportActivitySettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  return (
    <div>
      <PageHeader
        title="Support Activity Setup"
        description="Whether tracking runs, how it counts, and which messages count as support."
        actions={
          <HelpButton moduleTitle="Support Activity Settings">
            <HelpSection title="What this page is for">
              <p>
                The master enable switch and the global counting mode for Support Activity
                Tracking. To manage the actual detection logic, see{" "}
                <Link href="/support-activity/keywords" className="underline">
                  Keywords
                </Link>{" "}
                and{" "}
                <Link href="/support-activity/rules" className="underline">
                  Rules
                </Link>
                .
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      <SupportActivitySettingsForm settings={settings} />

      {/* Rules and Keywords were two more nav entries for the same job as this page: deciding what
          counts. They keep their own routes — this is where you now find them. */}
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Card>
          <SectionHeader
            title="Rules"
            description="Which messages count as support — every message, a keyword, a reply to a customer, or an @mention."
          />
          <ButtonLink href="/support-activity/rules">Manage rules</ButtonLink>
        </Card>
        <Card>
          <SectionHeader
            title="Keywords"
            description="The words a keyword rule looks for, and which of them mark a conversation finished."
          />
          <ButtonLink href="/support-activity/keywords">Manage keywords</ButtonLink>
        </Card>
      </div>
    </div>
  );
}
