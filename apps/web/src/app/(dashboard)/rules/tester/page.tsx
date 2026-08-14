/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { RuleTesterForm } from "./RuleTesterForm";

export default async function RuleTesterPage() {
  await requireSession();
  const groups = await prisma.whatsAppGroup.findMany({ select: { id: true, name: true } });

  return (
    <div>
      <PageHeader
        title="Rule Tester"
        description="Simulates a message against the current active rules. This never sends a real message or notification."
        actions={
          <HelpButton moduleTitle="Rule Tester">
            <HelpSection title="What this page is for">
              <p>
                A safe, dry-run sandbox — describe a hypothetical message and see exactly what would
                happen, without touching WhatsApp, the outbound queue, or notifications at all. Use it
                before trusting a new or edited rule with real traffic.
              </p>
            </HelpSection>
            <HelpSection title="Simulate at time">
              <p>
                Leave this blank to test against right now. Set a specific date/time to test a rule
                that has a schedule (an "only active during specific hours" condition) — e.g. set it to
                2 AM to confirm an overnight-only rule actually fires then, or set it to midday to
                confirm it correctly does nothing outside its window.
              </p>
            </HelpSection>
            <HelpSection title="Reading the result">
              <p>
                "Rules Evaluated" lists every active rule in priority order with a badge: APPLIED (this
                one won and its actions ran), MATCHED (pre-empted) (it would have matched, but a
                higher-priority rule won first), or NO MATCH — with the exact reason for each, including
                which specific condition failed if one did.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <RuleTesterForm groups={groups} />
    </div>
  );
}
