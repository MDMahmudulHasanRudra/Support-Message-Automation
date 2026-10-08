"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Card, ConfirmDialog, SectionHeader, useToast } from "@/components/ui";
import type { GroupSetupCandidate } from "@/server/actions/accounts";

/**
 * Moving a customer-facing number to a new one.
 *
 * A WhatsApp group belongs to an account, so replacing the number means the groups resync as
 * fresh rows with monitoring, AI, priority and assignment all back at their defaults. Re-picking
 * those by hand across a roster in the hundreds is not a real option, and half-finished is worse
 * than not started — so this copies the decisions across.
 *
 * The number that matters on screen is how many would actually carry. Setup can only land on a
 * group the new number is ALSO in, and a new number is in nothing until somebody adds it to each
 * group on WhatsApp itself. "0 of 1,848 would carry" is not a failure message, it is the answer:
 * the groups have to be joined first, and nothing in this dashboard can do that on its own.
 */

export interface GroupSetupTransferProps {
  targetLabel: string;
  targetPhone: string | null;
  candidates: GroupSetupCandidate[];
  onAdopt: (sourceAccountId: string) => Promise<{ error?: string; updated?: number; notShared?: number }>;
}

export function GroupSetupTransfer({ targetLabel, targetPhone, candidates, onAdopt }: GroupSetupTransferProps) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<GroupSetupCandidate | null>(null);
  const { showToast } = useToast();

  const run = (candidate: GroupSetupCandidate) => {
    setConfirming(null);
    startTransition(async () => {
      const result = await onAdopt(candidate.accountId);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      const updated = result.updated ?? 0;
      showToast({
        tone: "success",
        title: `${updated} group${updated === 1 ? "" : "s"} set up`,
        // The skipped count is the actionable half — it names groups this number still has to be
        // added to — so it is reported rather than rounded away into a tidy success message.
        description: result.notShared
          ? `${result.notShared} skipped — ${targetLabel} is not in those groups.`
          : undefined,
      });
    });
  };

  return (
    <Card>
      <SectionHeader
        title="Moving to a new number"
        description={`Copy monitoring, AI, priority tier and assigned member from your previous number onto ${targetLabel}${
          targetPhone ? ` (${targetPhone})` : ""
        }. Nothing is removed from the other account.`}
      />

      <div className="mt-4 space-y-3">
        {candidates.map((candidate) => {
          const joined = candidate.wouldCarry;
          const missing = candidate.configuredGroups - joined;

          return (
            <div
              key={candidate.accountId}
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-[color:var(--color-foreground)]">
                    {candidate.label}
                    {candidate.phoneNumber ? (
                      <span className="ml-2 font-normal text-[color:var(--color-muted-foreground)] tabular">
                        {candidate.phoneNumber}
                      </span>
                    ) : (
                      <span className="ml-2 font-normal text-[color:var(--color-muted-foreground)]">
                        logged out
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
                    {candidate.configuredGroups.toLocaleString()} group
                    {candidate.configuredGroups === 1 ? "" : "s"} configured ·{" "}
                    <span className={joined > 0 ? "text-[color:var(--color-foreground)]" : undefined}>
                      {joined.toLocaleString()} would carry
                    </span>
                  </p>
                </div>

                <Button
                  type="button"
                  disabled={joined === 0 || pending}
                  onClick={() => setConfirming(candidate)}
                >
                  {pending ? "Copying…" : "Copy setup"}
                </Button>
              </div>

              {joined === 0 ? (
                // The whole point of showing this card at all when nothing can be copied: the
                // operator is otherwise left thinking the sync is broken, when what is missing is
                // a step outside this dashboard.
                <div className="mt-3">
                  <Alert tone="warning">
                    {targetLabel} is not in any of these groups yet, so there is nothing to copy
                    onto. Add this number to the groups on WhatsApp first —{" "}
                    <strong>Add Number to Groups</strong> can do it in bulk, but only from an
                    account that is still in them, so keep the old number connected until that is
                    done. Then <strong>Resync Groups</strong> here and come back.
                  </Alert>
                </div>
              ) : missing > 0 ? (
                <p className="mt-3 text-[13px] text-[color:var(--color-muted-foreground)]">
                  {missing.toLocaleString()} configured group{missing === 1 ? " is" : "s are"} not
                  shared with this number and will be skipped. Add it to those groups and resync to
                  pick them up.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && run(confirming)}
        loading={pending}
        title={`Copy setup from ${confirming?.label ?? ""}?`}
        description={
          confirming
            ? `${confirming.wouldCarry.toLocaleString()} group${
                confirming.wouldCarry === 1 ? "" : "s"
              } on ${targetLabel} will take that account's monitoring, AI, priority and assignment settings, overwriting what they have now. ${
                confirming.label
              } is not changed. If both numbers stay in the same groups with AI on, customers get answered twice.`
            : ""
        }
        confirmLabel="Copy setup"
      />
    </Card>
  );
}
