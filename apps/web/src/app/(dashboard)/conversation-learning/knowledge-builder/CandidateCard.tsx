"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, X } from "lucide-react";
import { Badge, Button, Field, Input, Textarea, useToast } from "@/components/ui";
import {
  approveConversationCandidate,
  rejectConversationCandidate,
  updateConversationCandidate,
} from "@/server/actions/knowledgeBuilder";

export interface CandidateRow {
  id: string;
  groupName: string;
  title: string;
  category: string;
  question: string | null;
  answer: string;
  confidence: number;
  status: "WAITING" | "APPROVED" | "REJECTED";
  promoted: boolean;
}

/**
 * One extracted Q&A, with the three decisions the spec asks for: edit it, approve it, throw it
 * away. Approving publishes it to the knowledge base as verified — the card says so in as many
 * words, because that is the moment it becomes something the assistant can tell a customer.
 */
export function CandidateCard({ candidate }: { candidate: CandidateRow }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(candidate.title);
  const [question, setQuestion] = useState(candidate.question ?? "");
  const [answer, setAnswer] = useState(candidate.answer);
  const [isPending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: boolean; error?: string }>, failTitle: string) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        showToast({ tone: "danger", title: failTitle, description: result.error });
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  const decided = candidate.status !== "WAITING";

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-2.5 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {editing ? (
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          ) : (
            <p className="text-sm font-semibold text-[color:var(--color-foreground)]">{candidate.title}</p>
          )}
          <p className="mt-1 text-[11px] text-[color:var(--color-muted-foreground)]">
            From {candidate.groupName} · {candidate.category.toLowerCase().replace(/_/g, " ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge color={candidate.confidence >= 80 ? "green" : "yellow"}>
            {candidate.confidence}% confidence
          </Badge>
          {candidate.status === "APPROVED" ? <Badge color="green" dot>Published</Badge> : null}
          {candidate.status === "REJECTED" ? <Badge color="gray">Rejected</Badge> : null}
        </div>
      </div>

      {editing ? (
        <div className="space-y-3">
          <Field label="Question" hint="What a customer would ask. Leave blank if it isn't a question.">
            <Input value={question} onChange={(e) => setQuestion(e.target.value)} />
          </Field>
          <Field label="Answer">
            <Textarea rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          </Field>
        </div>
      ) : (
        <div className="space-y-2 text-[13px]">
          {candidate.question ? (
            <p className="text-[color:var(--color-muted-foreground)]">
              <span className="font-medium text-[color:var(--color-foreground)]">Q:</span>{" "}
              {candidate.question}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap text-[color:var(--color-foreground)]">{candidate.answer}</p>
        </div>
      )}

      <div className="mt-3.5 flex flex-wrap items-center gap-1.5 border-t border-[var(--color-border)] pt-3">
        {editing ? (
          <>
            <Button
              size="sm"
              loading={isPending}
              onClick={() =>
                run(
                  () => updateConversationCandidate(candidate.id, { title, question, answer }),
                  "Couldn't save those edits",
                )
              }
            >
              Save changes
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : decided ? (
          <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
            {candidate.status === "APPROVED"
              ? "Published to the knowledge base — the assistant can use this."
              : "Kept as a record of what was turned down."}
          </p>
        ) : (
          <>
            <Button
              variant="secondary"
              size="sm"
              loading={isPending}
              onClick={() =>
                run(() => approveConversationCandidate(candidate.id), "Couldn't approve this candidate")
              }
            >
              <Check className="size-3.5" aria-hidden />
              Approve &amp; publish
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" aria-hidden />
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={isPending}
              onClick={() =>
                run(() => rejectConversationCandidate(candidate.id), "Couldn't reject this candidate")
              }
            >
              <X className="size-3.5" aria-hidden />
              Reject
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
