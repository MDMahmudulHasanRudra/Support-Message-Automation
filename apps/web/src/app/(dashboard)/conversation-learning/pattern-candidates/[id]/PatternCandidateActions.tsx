"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog } from "@/components/ui";
import { createRuleProposal } from "@/server/actions/ruleProposals";

export function PatternCandidateActions({ candidateId }: { candidateId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    startTransition(async () => {
      const result = await createRuleProposal(candidateId);
      setOpen(false);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.push(`/conversation-learning/rule-proposals/${result.id}`);
    });
  }

  return (
    <>
      <Button size="sm" loading={pending} onClick={() => setOpen(true)}>
        Create Proposal
      </Button>
      {error ? <p className="mt-2 text-xs text-[color:var(--color-danger)]">{error}</p> : null}
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={confirm}
        loading={pending}
        title="Create a rule proposal from this pattern?"
        description="Drafts a proposed automation rule from this pattern's suggested keywords and reply. It stays fully inactive until a human reviews and approves it, and even then requires a separate activation step on the Rules page."
        confirmLabel="Create Proposal"
      />
    </>
  );
}
