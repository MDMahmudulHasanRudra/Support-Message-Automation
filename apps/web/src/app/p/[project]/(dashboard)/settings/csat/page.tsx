import { pageAccess } from "@/server/authorize";
import { Card, HelpButton, HelpSection, PageHeader, ViewOnlyNotice } from "@/components/ui";
import { loadCsatSettings } from "@/server/csat";
import { CsatSettingsForm } from "./CsatSettingsForm";

/**
 * Settings → Support → Satisfaction surveys (CSAT.md, feature CSAT_SURVEYS). Which channels ask "How did we
 * do? 1–5" when a person resolves a conversation, the question, and the per-customer cooldown. Every channel is
 * off until it is switched on here.
 */
export default async function CsatSettingsPage() {
  const { canManage } = await pageAccess("settings.view", "settings.edit", "CSAT_SURVEYS");
  const settings = await loadCsatSettings();
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Satisfaction surveys"
        description="Ask customers “How did we do? 1–5” after a conversation is resolved, and see the answers under Reports → Customer Satisfaction."
        actions={
          <HelpButton moduleTitle="Satisfaction surveys">
            <HelpSection title="When a survey is asked">
              <p>
                When somebody sets a conversation to <strong>Resolved</strong>, one survey is recorded for that resolution and asked within a
                few seconds — on a channel switched on here only. A conversation reopened before it goes out is not asked, and a survey that
                could not go out within 30 minutes is dropped rather than sent late.
              </p>
            </HelpSection>
            <HelpSection title="Never">
              <p>
                In a WhatsApp group or a Telegram group, to a team member or one of our own numbers, while automation is paused or in
                manual-only mode, outside Messenger&apos;s and Instagram&apos;s 24-hour window, or twice to one customer inside the cooldown.
                Every survey that was not asked is listed with its reason in the report.
              </p>
            </HelpSection>
            <HelpSection title="Answers">
              <p>
                Website chat visitors tap a rating in the chat. On the other channels, the customer&apos;s next message within 24 hours counts
                only if it is nothing but a rating — “5”, “৫”, “4/5”, “⭐⭐⭐⭐”. Anything else is an ordinary message and the survey stays
                unanswered. Either way the message is stored and handled as usual. An answer can never be changed afterwards.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      {!canManage ? <ViewOnlyNotice /> : null}
      <Card>
        <CsatSettingsForm initial={settings} canManage={canManage} />
      </Card>
    </div>
  );
}
