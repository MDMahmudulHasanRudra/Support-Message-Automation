"use client";

import { useProjectHref } from "@/components/ProjectLink";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import Link from "@/components/ProjectLink";
import { useState, useTransition } from "react";

import { BookPlus, Check, Download, ExternalLink, Pencil, RotateCcw, X } from "lucide-react";
import { Alert, Badge, Button, Dialog, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import {
  makeKnowledgeFromSandbox,
  saveSandboxEdit,
  setSandboxReview,
  type SimilarKnowledge,
} from "@/server/actions/sandbox";

type Review = "WAITING" | "APPROVED" | "REJECTED";

const CATEGORIES: Array<[string, string]> = [
  ["FAQ", "FAQ"],
  ["CUSTOMER_RESPONSE", "Customer response"],
  ["TROUBLESHOOTING", "Troubleshooting"],
  ["WORKFLOW", "Workflow"],
  ["SOFTWARE", "Software"],
  ["POLICY", "Policy"],
];

/**
 * One AI answer and everything that can be done with it: edit, verify or reject, make it knowledge,
 * export it. Each answer in a conversation carries its own state — nothing here applies to the
 * whole conversation.
 *
 * States, and the only actions offered in each (an action that no longer means anything is not
 * shown rather than shown disabled):
 *   Waiting    Edit answer · Reject · Verify answer
 *   Verified   Edit verified answer (returns it to Waiting) · Make knowledge · Export · Undo
 *   Saved      View knowledge · Export
 *   Rejected   Reopen
 * "Edited" is a badge beside any of these, never a state of its own: an edited answer is still
 * waiting for, or has passed, verification.
 *
 * The server enforces every one of these rules as well (see server/actions/sandbox.ts); the UI
 * only avoids offering what would be refused.
 */
export function SandboxAnswer({
  turnId,
  sessionId,
  question,
  aiAnswer,
  editedAnswer,
  editedByName,
  review,
  savedKnowledgeId,
  suggestedTitle,
  scope,
  canManage,
  canSaveVerified,
}: {
  turnId: string;
  sessionId: string;
  question: string;
  /** The original AI answer — null when the AI handed over without drafting one. */
  aiAnswer: string | null;
  editedAnswer: string | null;
  editedByName: string | null;
  review: Review;
  savedKnowledgeId: string | null;
  suggestedTitle: string;
  scope: string | null;
  canManage: boolean;
  /** Whether this user may save knowledge straight as verified (ai_learning.manage). */
  canSaveVerified: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const finalAnswer = editedAnswer ?? aiAnswer ?? "";
  const edited = editedAnswer !== null;
  const saved = savedKnowledgeId !== null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(finalAnswer);
  const [showOriginal, setShowOriginal] = useState(false);

  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [title, setTitle] = useState(suggestedTitle);
  const [category, setCategory] = useState("FAQ");
  const [kQuestion, setKQuestion] = useState(question);
  const [kAnswer, setKAnswer] = useState(finalAnswer);
  const [saveAsVerified, setSaveAsVerified] = useState(canSaveVerified);
  const [similar, setSimilar] = useState<SimilarKnowledge[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const fail = (title: string, description?: string) => showToast({ tone: "danger", title, description });

  function decide(next: Review) {
    startTransition(async () => {
      const result = await setSandboxReview(turnId, next);
      if (!result.ok) return fail("Couldn't save that decision", result.error);
      router.refresh();
    });
  }

  function saveEdit() {
    startTransition(async () => {
      const result = await saveSandboxEdit(turnId, draft);
      if (!result.ok) return fail("Couldn't save the answer", result.error);
      setEditing(false);
      showToast({
        tone: "success",
        title: "Answer saved",
        description: result.reverified ? "It changed after it was verified, so verify it again." : undefined,
      });
      router.refresh();
    });
  }

  function openKnowledge() {
    // Always start from what is on screen now — the final answer — never a stale copy.
    setKQuestion(question);
    setKAnswer(finalAnswer);
    setSimilar(null);
    setFormError(null);
    setKnowledgeOpen(true);
  }

  function makeKnowledge(allowDuplicate: boolean) {
    setFormError(null);
    startTransition(async () => {
      const result = await makeKnowledgeFromSandbox(turnId, {
        title,
        category,
        question: kQuestion,
        answer: kAnswer,
        saveAsVerified,
        allowDuplicate,
      });
      if (result.similar) {
        setSimilar(result.similar);
        return;
      }
      if (!result.ok) {
        setFormError(result.error ?? "Couldn't save the knowledge.");
        return;
      }
      setKnowledgeOpen(false);
      showToast({
        tone: "success",
        title: result.verified ? "Saved as verified knowledge" : "Saved for review",
        description: result.verified
          ? "The AI can use it from its next answer."
          : "It is in Pending Review — once verified there, the AI can use it.",
      });
      router.refresh();
    });
  }

  const toProject = useProjectHref();
  const exportHref = (format: "csv" | "xlsx" | "json") =>
    toProject(`/api/sandbox/export?session=${encodeURIComponent(sessionId)}&turn=${encodeURIComponent(turnId)}&format=${format}`);

  return (
    <div className="space-y-2.5">
      {/* State, at a glance. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {saved ? (
          <Badge color="cyan" dot>
            Saved to knowledge
          </Badge>
        ) : review === "APPROVED" ? (
          <Badge color="green" dot>
            Verified
          </Badge>
        ) : review === "REJECTED" ? (
          <Badge color="red" dot>
            Rejected
          </Badge>
        ) : (
          <Badge color="gray" dot>
            Waiting
          </Badge>
        )}
        {edited ? <Badge color="yellow">Edited{editedByName ? ` by ${editedByName}` : " by admin"}</Badge> : null}
      </div>

      {/* The answer — or the editor for it. */}
      {editing ? (
        <div className="max-w-[85%] space-y-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(14, Math.max(4, draft.split("\n").length + 1))}
            maxLength={8000}
            aria-label="Answer"
            autoFocus
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => { setEditing(false); setDraft(finalAnswer); }} disabled={pending}>
              Cancel
            </Button>
            <Button size="sm" loading={pending} onClick={saveEdit} disabled={draft.trim().length === 0}>
              Save changes
            </Button>
            {review === "APPROVED" ? (
              <span className="text-[11px] text-[color:var(--color-muted-foreground)]">Saving returns it to Waiting — verify it again after.</span>
            ) : null}
          </div>
        </div>
      ) : finalAnswer ? (
        <p className="max-w-[85%] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-3.5 py-2.5 text-[13px] whitespace-pre-wrap text-[color:var(--color-foreground)]">
          {finalAnswer}
        </p>
      ) : (
        <p className="text-[12px] text-[color:var(--color-muted-foreground)]">No answer yet — write one to turn this question into knowledge.</p>
      )}

      {edited && aiAnswer && !editing ? (
        <div className="max-w-[85%]">
          <button
            type="button"
            className="text-[11px] text-[color:var(--color-muted-foreground)] underline underline-offset-2 hover:text-[color:var(--color-foreground)]"
            onClick={() => setShowOriginal((open) => !open)}
          >
            {showOriginal ? "Hide the original AI answer" : "Show the original AI answer"}
          </button>
          {showOriginal ? (
            <p className="mt-1.5 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] px-3.5 py-2.5 text-[12px] whitespace-pre-wrap text-[color:var(--color-muted-foreground)]">
              {aiAnswer}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Actions for the current state only. */}
      {canManage && !editing ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {!saved && review === "WAITING" ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => { setDraft(finalAnswer); setEditing(true); }}>
                <Pencil className="size-3.5" aria-hidden />
                {finalAnswer ? "Edit answer" : "Write answer"}
              </Button>
              <Button variant="secondary" size="sm" loading={pending} onClick={() => decide("REJECTED")}>
                <X className="size-3.5" aria-hidden />
                Reject
              </Button>
              <Button size="sm" loading={pending} onClick={() => decide("APPROVED")} disabled={!finalAnswer}>
                <Check className="size-3.5" aria-hidden />
                Verify answer
              </Button>
            </>
          ) : null}

          {!saved && review === "APPROVED" ? (
            <>
              <Button size="sm" onClick={openKnowledge}>
                <BookPlus className="size-3.5" aria-hidden />
                Make knowledge
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setDraft(finalAnswer); setEditing(true); }}>
                <Pencil className="size-3.5" aria-hidden />
                Edit verified answer
              </Button>
              <Button variant="ghost" size="sm" loading={pending} onClick={() => decide("WAITING")}>
                <RotateCcw className="size-3.5" aria-hidden />
                Undo verification
              </Button>
            </>
          ) : null}

          {review === "REJECTED" ? (
            <Button variant="ghost" size="sm" loading={pending} onClick={() => decide("WAITING")}>
              <RotateCcw className="size-3.5" aria-hidden />
              Reopen
            </Button>
          ) : null}

          {saved ? (
            <Link
              href={`/ai-learning/knowledge-base/${savedKnowledgeId}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-[12px] font-medium text-[color:var(--color-foreground)] hover:bg-[var(--color-neutral-bg)]"
            >
              <ExternalLink className="size-3.5" aria-hidden />
              View knowledge
            </Link>
          ) : null}

          {review === "APPROVED" ? (
            <span className="inline-flex items-center gap-1 text-[12px] text-[color:var(--color-muted-foreground)]">
              <Download className="size-3.5" aria-hidden />
              Export
              {(["csv", "xlsx", "json"] as const).map((format) => (
                <a key={format} href={exportHref(format)} className="rounded px-1 font-medium text-[color:var(--color-foreground)] hover:bg-[var(--color-neutral-bg)]">
                  {format === "xlsx" ? "Excel" : format.toUpperCase()}
                </a>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}

      <Dialog
        open={knowledgeOpen}
        onClose={() => setKnowledgeOpen(false)}
        size="lg"
        title="Create knowledge"
        description="The question and the verified answer, as the AI will be able to use them. Both can still be changed here."
        footer={
          <>
            <Button variant="secondary" onClick={() => setKnowledgeOpen(false)}>
              Cancel
            </Button>
            {similar ? (
              <Button loading={pending} onClick={() => makeKnowledge(true)}>
                Create anyway
              </Button>
            ) : (
              <Button loading={pending} onClick={() => makeKnowledge(false)} disabled={!title.trim() || !kQuestion.trim() || !kAnswer.trim()}>
                Save knowledge
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-4">
          {similar ? (
            <Alert tone="warning" title="Possible existing knowledge found">
              <p className="mb-2">These entries may already answer the same question. Nothing has been saved yet, and nothing existing will be changed.</p>
              <ul className="space-y-1">
                {similar.map((item) => (
                  <li key={item.id}>
                    <Link className="font-medium underline underline-offset-2" href={`/ai-learning/knowledge-base/${item.id}`} target="_blank">
                      {item.question ?? item.title}
                    </Link>{" "}
                    <span className="text-[11px]">({item.humanVerified ? "verified" : "waiting for review"}{item.status !== "ACTIVE" ? `, ${item.status.toLowerCase()}` : ""})</span>
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {formError ? <Alert tone="danger">{formError}</Alert> : null}

          <Field label="Question">
            <Input value={kQuestion} onChange={(e) => { setKQuestion(e.target.value); setSimilar(null); }} />
          </Field>
          <Field label="Verified answer">
            <Textarea value={kAnswer} onChange={(e) => setKAnswer(e.target.value)} rows={6} maxLength={8000} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Title" hint="How it is listed in the knowledge base.">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Category">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Status">
            <Select
              value={saveAsVerified ? "VERIFIED" : "REVIEW"}
              onChange={(e) => setSaveAsVerified(e.target.value === "VERIFIED")}
              disabled={!canSaveVerified}
            >
              <option value="VERIFIED">Verified — the AI can use it straight away</option>
              <option value="REVIEW">Pending review — someone checks it first</option>
            </Select>
          </Field>
          <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
            {canSaveVerified
              ? "Saving as verified is the same as verifying it in the knowledge base: the AI may then state this answer to customers."
              : "Your role cannot verify knowledge, so this goes to Pending Review for someone who can."}
            {scope ? ` The AI classified this question as ${scope === "BUSINESS_SPECIFIC" ? "business specific" : "general"}.` : ""}
          </p>
        </div>
      </Dialog>
    </div>
  );
}
