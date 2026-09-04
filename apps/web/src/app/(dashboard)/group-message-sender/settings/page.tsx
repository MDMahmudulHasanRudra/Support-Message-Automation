/* eslint-disable react/no-unescaped-entities -- long-form Help prose reads better with real apostrophes */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Alert, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { BroadcastSettingsForm } from "./BroadcastSettingsForm";

/**
 * The throttles on bulk sending, which until now had no UI at all.
 *
 * Separated from the send wizard on purpose: these are the settings you change once, carefully,
 * and they should not sit beside the button that sends to two hundred groups.
 */
export default async function BroadcastSettingsPage() {
  await requireSession();
  const settings = await prisma.groupBroadcastSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  return (
    <div>
      <PageHeader
        title="Bulk Messaging Limits"
        description="How fast broadcasts go out, how large they can be, and how often the same group can be messaged again."
        actions={
          <HelpButton moduleTitle="Bulk Messaging Limits">
            <HelpSection title="Why these exist">
              <p>
                A broadcast sends the same message to many groups from the same WhatsApp number that
                serves every one of your customers. Sending too fast, or too many at once, is how a
                number gets banned — and a banned number takes every conversation down with it, not
                just the broadcast.
              </p>
            </HelpSection>
            <HelpSection title="What each one does">
              <p>
                The <strong>delay</strong> is a random pause between each send, so a broadcast does
                not look like a machine. The <strong>per-minute cap</strong> holds the overall pace.
                The <strong>maximum groups per broadcast</strong> is the ceiling the send wizard
                enforces before a job is even created. <strong>Retries</strong> are how many times a
                single failed group is attempted again. The <strong>repeat cooldown</strong> stops
                the same group being included in another broadcast too soon.
              </p>
            </HelpSection>
            <HelpSection title="These are limits, not targets">
              <p>
                Raising them does not make anything faster on its own — it only removes the brake.
                Values outside the safe range are clamped when you save, rather than accepted and
                then quietly ignored at send time.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <div className="mb-5">
        <Alert tone="warning">
          These protect the WhatsApp number that also serves every customer conversation. Loosen
          them only if you have a specific reason to.
        </Alert>
      </div>

      <BroadcastSettingsForm
        settings={{
          delayMinMs: settings.delayMinMs,
          delayMaxMs: settings.delayMaxMs,
          maxPerMinute: settings.maxPerMinute,
          maxPerJob: settings.maxPerJob,
          retryMaxAttempts: settings.retryMaxAttempts,
          duplicateGroupCooldownMinutes: settings.duplicateGroupCooldownMinutes,
        }}
      />
    </div>
  );
}
