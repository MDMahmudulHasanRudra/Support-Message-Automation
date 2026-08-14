"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog, Textarea } from "@/components/ui";
import { approveRuleProposal, rejectRuleProposal, withdrawRuleProposal } from "@/server/actions/ruleProposals";

type DialogKind = "approve" | "reject" | "withdraw" | null;

export function RuleProposalActions({ proposalId }: { proposalId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function confirmDialog() {
    startTransition(async () => {
      setError(null);
      if (dialog === "approve") {
        const result = await approveRuleProposal(proposalId);
        if (result.error) {
          setError(result.error);
          setDialog(null);
          return;
        }
      }
      if (dialog === "reject") await rejectRuleProposal(proposalId, reviewNote.trim() || null);
      if (dialog === "withdraw") await withdrawRuleProposal(proposalId);
      setDialog(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" loading={pending} onClick={() => setDialog("approve")}>
        Approve
      </Button>
      <Button variant="secondary" size="sm" loading={pending} onClick={() => setDialog("reject")}>
        Reject
      </Button>
      <Button variant="ghost" size="sm" loading={pending} onClick={() => setDialog("withdraw")}>
        Withdraw
      </Button>
      {error ? <p className="w-full text-xs text-[color:var(--color-danger)]">{error}</p> : null}

      <ConfirmDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        onConfirm={confirmDialog}
        loading={pending}
        tone={dialog === "reject" || dialog === "withdraw" ? "danger" : "primary"}
        title={
          dialog === "approve"
            ? "Approve this proposal?"
            : dialog === "reject"
              ? "Reject this proposal?"
              : "Withdraw this proposal?"
        }
        description={
          dialog === "approve"
            ? "Creates a real automation rule as a Draft — you'll still need to activate it separately from the Rules page."
            : dialog === "reject"
              ? "Closes this proposal for good. The source pattern is never automatically re-proposed."
              : "Closes this proposal without a rejection reason. The source pattern is never automatically re-proposed."
        }
        confirmLabel={dialog === "approve" ? "Approve" : dialog === "reject" ? "Reject" : "Withdraw"}
      >
        {dialog === "reject" ? (
          <Textarea
            value={reviewNote}
            onChange={(e) => setReviewNote(e.target.value)}
            placeholder="Optional reason (visible to other admins)"
            rows={3}
          />
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
