/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { AiSettingsForm } from "./AiSettingsForm";

export default async function AiSettingsPage() {
  await requireSession();
  const [settings, groups] = await Promise.all([
    prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.whatsAppGroup.findMany({
      where: { isActive: true },
      select: { whatsappGroupId: true, name: true, isMonitored: true },
      orderBy: { name: "asc" },
    }),
  ]);

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
                that pattern. Learning is live — it gates the optional AI
                re-scoring step in Conversation Learning. Screenshot Response, Chat Learning,
                Software Learning, Requirement Learning and Announcement AI are saved but read by
                nothing at runtime, so changing them has no effect in either position. In
                particular there is no image understanding anywhere in this system: a photo
                arrives as the text "[Image]", and the AI now hands those to a person rather than
                answering a screenshot it cannot see.
              </p>
            </HelpSection>
            <HelpSection title="Thresholds">
              <p>
                Human Review is live: a Conversation Learning pattern scoring below
                it is never surfaced for review, so setting it high quietly stops patterns
                appearing. Duplicate Similarity, Learning Confidence and Auto Approval are saved
                but read by nothing — the live auto-approval bar is on Conversation Learning →
                Settings, not here. Auto-Response
                Confidence Threshold (below, in its own section) is live today — it's the AI fallback
                layer's own reply-vs-human-fallback decision point, default 90%.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <AiSettingsForm settings={settings} groups={groups} />
    </div>
  );
}
