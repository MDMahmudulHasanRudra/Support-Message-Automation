"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BookPlus, Check, RotateCcw, X } from "lucide-react";
import { Button, Dialog, Field, Input, Select, useToast } from "@/components/ui";
import { promoteSandboxAnswer, setSandboxReview } from "@/server/actions/sandbox";

/**
 * Approve / Reject / Waiting for one AI answer, plus the separate, explicit "Save to
 * Knowledge Base" step.
 *
 * Those are two distinct buttons on purpose. Approving says "the AI handled this well";
 * saving says "this is true, and the assistant may tell a customer so". A testing surface
 * is entitled to make the first judgement and not the second, which is why the promoted
 * entry lands unverified in the existing review queue rather than as live knowledge.
 */
export function SandboxReviewControls({
  turnId,
  review,
  canPromote,
  promoted,
  suggestedTitle,
}: {
  turnId: string;
  review: "WAITING" | "APPROVED" | "REJECTED";
  /** False for a handover turn — there is no drafted answer to save as knowledge. */
  canPromote: boolean;
  promoted: boolean;
  suggestedTitle: string;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [title, setTitle] = useState(suggestedTitle);
  const [category, setCategory] = useState("FAQ");

  function decide(next: "WAITING" | "APPROVED" | "REJECTED") {
    startTransition(async () => {
      const result = await setSandboxReview(turnId, next);
      if (!result.ok) {
        showToast({ tone: "danger", title: "Couldn't save that decision", description: result.error });
        return;
      }
      router.refresh();
    });
  }

  function promote() {
    startTransition(async () => {
      const result = await promoteSandboxAnswer(turnId, { title, category });
      if (!result.ok) {
        showToast({ tone: "danger", title: "Couldn't save to the knowledge base", description: result.error });
        return;
      }
      setPromoteOpen(false);
      showToast({
        tone: "success",
        title: "Saved for review",
        description: "It's in the knowledge base's pending-review queue — verify it there before the AI can use it.",
      });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {review === "WAITING" ? (
        <>
          <Button variant="secondary" size="sm" loading={isPending} onClick={() => decide("APPROVED")}>
            <Check className="size-3.5" aria-hidden />
            Approve
          </Button>
          <Button variant="secondary" size="sm" loading={isPending} onClick={() => decide("REJECTED")}>
            <X className="size-3.5" aria-hidden />
            Reject
          </Button>
        </>
      ) : (
        <Button variant="ghost" size="sm" loading={isPending} onClick={() => decide("WAITING")}>
          <RotateCcw className="size-3.5" aria-hidden />
          Undo decision
        </Button>
      )}

      {review === "APPROVED" && canPromote && !promoted ? (
        <Button variant="ghost" size="sm" onClick={() => setPromoteOpen(true)}>
          <BookPlus className="size-3.5" aria-hidden />
          Save to Knowledge Base
        </Button>
      ) : null}

      <Dialog
        open={promoteOpen}
        onClose={() => setPromoteOpen(false)}
        title="Save this answer as knowledge?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPromoteOpen(false)}>
              Cancel
            </Button>
            <Button loading={isPending} onClick={promote} disabled={title.trim().length === 0}>
              Save for review
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Title" hint="How this entry will be listed in the knowledge base.">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="FAQ">FAQ</option>
              <option value="CUSTOMER_RESPONSE">Customer response</option>
              <option value="TROUBLESHOOTING">Troubleshooting</option>
              <option value="WORKFLOW">Workflow</option>
              <option value="SOFTWARE">Software</option>
              <option value="POLICY">Policy</option>
            </Select>
          </Field>
          <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
            This saves the question and the AI&apos;s answer into the knowledge base as{" "}
            <strong>unverified</strong>. The AI cannot use it until someone verifies it in Pending
            Review — approving it here says the AI handled the conversation well, which is not the
            same as confirming the answer is factually right.
          </p>
        </div>
      </Dialog>
    </div>
  );
}
