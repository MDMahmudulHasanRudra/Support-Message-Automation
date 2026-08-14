/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { AiSettingsForm } from "./AiSettingsForm";

export default async function AiSettingsPage() {
  await requireSession();
  const settings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });

  return (
    <div>
      <PageHeader
        title="AI Settings"
        description="Master controls and learning thresholds for the AI Learning module."
        actions={
          <HelpButton moduleTitle="AI Settings">
            <HelpSection title="Every switch here defaults OFF, and none of them do anything yet">
              <p>
                Master Controls (AI Engine, Learning, Auto Response, Screenshot Response, Chat Learning,
                Software Learning, Requirement Learning, Announcement AI) and the four Learning
                Thresholds (Duplicate Similarity, Learning Confidence, Auto Approval, Human Review) are
                all inert right now — flipping any of these on has no effect on real message handling.
                They're here so later phases have somewhere to read configuration from once they ship.
              </p>
            </HelpSection>
            <HelpSection title="Thresholds, for when they do matter">
              <p>
                All four are percentages (0–100), meant for future duplicate/confidence checks:
                Duplicate Similarity (at/above this, treat as a duplicate), Learning Confidence (below
                this, needs human review), Auto Approval (at/above this, can skip human approval if
                enabled), Human Review (below this, reject or require manual review).
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <AiSettingsForm settings={settings} />
    </div>
  );
}
