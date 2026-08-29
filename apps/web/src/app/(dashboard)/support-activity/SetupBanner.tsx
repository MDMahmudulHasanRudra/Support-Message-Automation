"use client";

import { Wand2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Alert, Button, useToast } from "@/components/ui";
import { enableCountEveryTeamMemberMessage } from "@/server/actions/supportRules";

/**
 * Support Activity needs three things true at once — the feature enabled, a rule that matches,
 * and the sender on the team roster. With any one missing the page just reports zeroes and
 * "no support activity detected yet", which reads as "nothing happened" rather than "nothing was
 * set up". This says which piece is missing, and fixes the one that can be fixed in a click.
 */
export function SetupBanner({
  trackingEnabled,
  activeRuleCount,
  activeMemberCount,
}: {
  trackingEnabled: boolean;
  activeRuleCount: number;
  activeMemberCount: number;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();

  const missingRules = activeRuleCount === 0;
  const missingMembers = activeMemberCount === 0;
  if (trackingEnabled && !missingRules && !missingMembers) return null;

  function enableEverything() {
    startTransition(async () => {
      const result = await enableCountEveryTeamMemberMessage();
      showToast({
        tone: "success",
        title: result.created ? "Now counting every team member message" : "Rule re-enabled",
        description: "Any message one of your team sends in a monitored group is recorded from now on.",
      });
      router.refresh();
    });
  }

  return (
    <div className="mb-6">
      <Alert
        tone="warning"
        title={
          missingRules
            ? "Nothing is being counted yet"
            : !trackingEnabled
              ? "Support Activity Tracking is switched off"
              : "No active team members"
        }
        actions={
          missingRules || !trackingEnabled ? (
            <Button size="sm" loading={pending} onClick={enableEverything}>
              <Wand2 className="size-3.5" aria-hidden />
              Count every message
            </Button>
          ) : null
        }
      >
        {missingRules ? (
          <>
            There are no support rules, so no message can match one.{" "}
            <strong>Count every message</strong> creates a single rule that records support
            whenever anyone on your team writes in a monitored group — no keywords needed. It also
            switches tracking on if it is off.
          </>
        ) : !trackingEnabled ? (
          <>Rules exist, but the master switch is off, so nothing is recorded.</>
        ) : (
          <>
            No team members are active, so the system cannot tell your staff from customers. Add
            them on Internal Team Members — you can pick them straight out of a group.
          </>
        )}
      </Alert>
    </div>
  );
}
