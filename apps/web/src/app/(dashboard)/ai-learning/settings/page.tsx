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
            <HelpSection title="AI Engine + Auto Response are live — the rest of Master Controls are not">
              <p>
                <strong>AI Engine</strong> and <strong>Auto Response</strong> together gate the Hybrid
                AI Automation fallback layer: when the deterministic rule engine finds no match for a
                customer message in an eligible, monitored group with AI Automation enabled, the
                system asks a configured AI provider to classify it and, only above the Auto-Response
                Confidence Threshold below, draft a reply — sent through the same outbound queue every
                other reply uses. Below the threshold, or on any failure, a human is asked for help
                instead, and nothing is ever sent without passing the existing kill switch, automation
                mode, cooldown, and rate-limit checks. Once a recurring pattern becomes an approved,
                activated rule, the deterministic engine handles it and AI is never called again for
                that pattern. Every other toggle here (Learning, Screenshot Response, Chat Learning,
                Software Learning, Requirement Learning, Announcement AI) is still reserved for later
                phases and has no effect on real message handling yet.
              </p>
            </HelpSection>
            <HelpSection title="Thresholds">
              <p>
                Duplicate Similarity, Learning Confidence, Auto Approval, and Human Review are
                percentages (0–100) reserved for future AI Learning/Knowledge phases. Auto-Response
                Confidence Threshold (below, in its own section) is live today — it's the AI fallback
                layer's own reply-vs-human-fallback decision point, default 90%.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <AiSettingsForm settings={settings} />
    </div>
  );
}
