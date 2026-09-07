import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Alert, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { ParticipantAddSettingsForm } from "./ParticipantAddSettingsForm";

/**
 * The throttles on adding people to groups, which until now had no UI at all — so `maxPerJob` sat
 * at its schema default of 100 and there was no way to move it.
 *
 * Its own page rather than a second card on Bulk Messaging Limits: these govern a different
 * operation with a different risk profile, and putting them together would invite changing one
 * while reading the other's explanation.
 */
export default async function ParticipantAddSettingsPage() {
  await requireSession();
  const settings = await prisma.groupParticipantAddSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  return (
    <div>
      <PageHeader
        title="Add-to-Groups Limits"
        description="How fast people are added to groups, and how much work one job may queue."
        actions={
          <HelpButton moduleTitle="Add-to-Groups Limits">
            <HelpSection title="Why adding is paced harder than messaging">
              <p>
                WhatsApp treats bulk &ldquo;add participant&rdquo; as a stronger ban signal than
                bulk messaging, so these limits are deliberately tighter than the broadcast ones. The
                number doing the adding is the same number serving every one of your customers, and
                a ban takes every conversation with it.
              </p>
            </HelpSection>
            <HelpSection title="Pace protects you; job size does not">
              <p>
                <strong>Adds per minute</strong> is the setting that matters, and it now applies
                across every running job rather than to each one separately. That change is what
                makes a large job safe: previously the per-job cap forced you to split 2,000 groups
                into twenty jobs, and twenty jobs each running at three per minute ran at sixty per
                minute — the cap was creating the risk it appeared to prevent.
              </p>
              <p>
                So <strong>maximum adds per job</strong> is no longer a safety control. It bounds a
                single mistake — a mis-click that selects every group — and nothing more. Raising it
                does not make anything go faster; the job simply runs for longer, on its own,
                without needing the page open.
              </p>
            </HelpSection>
            <HelpSection title="What counts as an add">
              <p>
                Every number against every group. Five people across five hundred groups is 2,500
                adds, and at three per minute that is roughly fourteen hours. The wizard shows the
                estimate before you confirm.
              </p>
              <p>
                Anyone already in a group is skipped without an add being attempted, and those
                skips are paced too — checking is itself a call to WhatsApp.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <div className="mb-4">
        <Alert tone="warning">
          The defaults here were chosen conservatively and tested. Raise the pace only with a
          specific reason — a banned number cannot be undone, and it takes every customer
          conversation down with it, not just this job.
        </Alert>
      </div>

      <ParticipantAddSettingsForm settings={settings} />
    </div>
  );
}
