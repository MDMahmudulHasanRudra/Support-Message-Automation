"use client";

import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { useState, useTransition } from "react";

import { Check, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { Alert, Badge, Button, Card, ConfirmDialog, SectionHeader, Textarea } from "@/components/ui";
import {
  approveCommunicationStyle,
  discardCommunicationStyle,
  readStyleRebuildStatus,
  requestStyleRebuild,
  saveCommunicationStyle,
  unapproveCommunicationStyle,
} from "@/server/actions/communicationStyle";

/**
 * Reading, approving and editing the learned style.
 *
 * The guidance is shown as plain text rather than a summary or a score, because approving it means
 * taking responsibility for what it will make the assistant say — and that is not a decision
 * anyone can make from a confidence percentage.
 */
export function StyleProfileCard({
  learningEnabled,
  aiEngineEnabled,
  guidance,
  approved,
}: {
  learningEnabled: boolean;
  aiEngineEnabled: boolean;
  guidance: string | null;
  approved: boolean;
}) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(guidance ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  function rebuild() {
    setRebuilding(true);
    setMessage(null);
    void (async () => {
      try {
        const queued = await requestStyleRebuild();
        if (!queued.queued) {
          setMessage(queued.error ?? "Could not start the rebuild.");
          return;
        }
        // Reading a few hundred replies is one model call, so this settles in well under a minute
        // — but the worker may be mid-tick on something else when the command lands.
        for (let attempt = 0; attempt < 40; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const status = await readStyleRebuildStatus();
          if (status.status === "DONE") {
            setMessage(
              status.skipped === "NOT_ENOUGH_REPLIES"
                ? `Only ${status.repliesAnalyzed ?? 0} replies were available. More support conversation is needed before a style can be described.`
                : status.skipped === "NO_CLEAR_STYLE"
                  ? "The replies did not show a consistent enough style to describe."
                  : `Rebuilt from ${status.repliesAnalyzed ?? 0} replies. Read it below, then approve.`,
            );
            router.refresh();
            return;
          }
          if (status.status === "FAILED") {
            setMessage(status.error ?? "The rebuild failed.");
            return;
          }
        }
        setMessage("Still running. Reload in a moment to see the result.");
      } finally {
        setRebuilding(false);
      }
    })();
  }

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <SectionHeader
          title="How your team writes"
          description="Read this as if it were an instruction to a new colleague. If it does not sound like your team, edit it or rebuild."
        />
        {guidance ? (
          <Badge color={approved ? "green" : "yellow"} dot>
            {approved ? "Approved — in use" : "Awaiting approval"}
          </Badge>
        ) : null}
      </div>

      {message ? (
        <div className="mb-4">
          <Alert tone="info">{message}</Alert>
        </div>
      ) : null}

      {!guidance && !editing ? (
        <p className="mb-4 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          Nothing learned yet.{" "}
          {learningEnabled
            ? "Rebuild to read your team's recent replies and describe how they write."
            : "Turn on “Learn how the team writes” in AI Settings first, then rebuild."}
        </p>
      ) : null}

      {editing ? (
        <form
          action={(formData) =>
            startBusy(async () => {
              const result = await saveCommunicationStyle(formData);
              if (result.error) {
                setMessage(result.error);
                return;
              }
              setEditing(false);
              setMessage("Saved and approved — the assistant will follow this from its next reply.");
              router.refresh();
            })
          }
          className="space-y-3"
        >
          <Textarea
            name="guidance"
            rows={10}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Communication style guidance"
          />
          <div className="flex gap-2">
            <Button type="submit" loading={busy}>
              <Check className="size-3.5" aria-hidden />
              Save and approve
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDraft(guidance ?? "");
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : guidance ? (
        <pre className="mb-4 whitespace-pre-wrap rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-4 font-[family-name:var(--font-sans)] text-[13px] leading-relaxed text-[color:var(--color-foreground)]">
          {guidance}
        </pre>
      ) : null}

      {!editing ? (
        <div className="flex flex-wrap gap-2">
          {guidance && !approved ? (
            <Button
              loading={busy}
              onClick={() =>
                startBusy(async () => {
                  const result = await approveCommunicationStyle();
                  setMessage(result.error ?? "Approved — the assistant will follow this from its next reply.");
                  router.refresh();
                })
              }
            >
              <Check className="size-3.5" aria-hidden />
              Approve
            </Button>
          ) : null}

          {guidance && approved ? (
            <Button
              variant="secondary"
              loading={busy}
              onClick={() =>
                startBusy(async () => {
                  await unapproveCommunicationStyle();
                  setMessage("Withdrawn. The assistant is back to its default voice; the text is kept here.");
                  router.refresh();
                })
              }
            >
              <X className="size-3.5" aria-hidden />
              Stop using it
            </Button>
          ) : null}

          {guidance ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" aria-hidden />
              Edit
            </Button>
          ) : null}

          <Button
            variant="secondary"
            onClick={rebuild}
            loading={rebuilding}
            disabled={!aiEngineEnabled || !learningEnabled}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            {guidance ? "Rebuild from recent replies" : "Build from recent replies"}
          </Button>

          {guidance ? (
            <Button variant="ghost" onClick={() => setConfirmDiscard(true)}>
              <Trash2 className="size-3.5" aria-hidden />
              Discard
            </Button>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() =>
          startBusy(async () => {
            await discardCommunicationStyle();
            setConfirmDiscard(false);
            setDraft("");
            setMessage("Discarded. The assistant is back to its default voice.");
            router.refresh();
          })
        }
        title="Discard this style profile?"
        description="The assistant goes back to its default voice. You can build a new profile at any time."
        confirmLabel="Discard"
        loading={busy}
      />
    </Card>
  );
}
