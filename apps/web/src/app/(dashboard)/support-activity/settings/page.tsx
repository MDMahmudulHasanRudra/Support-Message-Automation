import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { SupportActivitySettingsForm } from "./SupportActivitySettingsForm";

export default async function SupportActivitySettingsPage() {
  await requireSession();
  const settings = await prisma.supportActivitySettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  return (
    <div>
      <PageHeader
        title="Support Activity Settings"
        description="Manage support keywords and rules on their own pages."
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

      <SupportActivitySettingsForm settings={settings} />
    </div>
  );
}
