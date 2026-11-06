"use client";

import { useState, useTransition } from "react";
import type { FailedReplyState } from "@support-automation/shared";
import { useProjectRouter } from "@/components/ProjectLink";
import { Button, Card, Checkbox, Field, Input, useToast } from "@/components/ui";
import { closeFailedReplies, reopenFailedReply, resolveFailedReplies, retryFailedReply, type FailedReplyItem } from "@/server/actions/failedReplies";

/** Retry / resolve / close / reopen for one failed reply. The server decides; this only asks. */
export function FailedReplyActions({
  item,
  state,
  uncertain,
  retryAllowed,
  retryReason,
  reopenable,
}: {
  item: FailedReplyItem;
  state: FailedReplyState;
  uncertain: boolean;
  retryAllowed: boolean;
  retryReason: string | null;
  /** A person resolved or closed it (a reply that was retried and sent has nothing to reopen). */
  reopenable: boolean;
}) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [note, setNote] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, startTransition] = useTransition();

  function run(label: string, fn: () => Promise<{ error?: string; done?: number }>) {
    startTransition(async () => {
      const result = await fn();
      if (result.error) {
        showToast({ tone: "danger", title: "Nothing was changed", description: result.error });
        return;
      }
      if (!result.done) {
        showToast({ tone: "info", title: "Nothing was changed", description: "It changed meanwhile. The page shows where it is now." });
      } else {
        showToast({ tone: "success", title: label });
      }
      setNote("");
      setChecked(false);
      router.refresh();
    });
  }

  if (state === "RETRYING") {
    return <Card><p className="text-[13px]">Queued to be sent again. This page follows the result.</p></Card>;
  }

  if (state !== "FAILED" && !reopenable) {
    return <Card><p className="text-[13px]">Sent after a retry. Nothing further to do.</p></Card>;
  }

  return (
    <Card>
      <h2 className="mb-2 text-[14px] font-semibold">What to do</h2>
      <Field label={state === "FAILED" ? "Note (required to close)" : "Note (optional)"}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Kept in the history with your name" />
      </Field>

      {state === "FAILED" ? (
        <div className="mt-3 space-y-2">
          {retryAllowed && uncertain ? (
            <label className="flex items-start gap-2 text-[12px]">
              <Checkbox checked={checked} onChange={() => setChecked((v) => !v)} aria-label="I checked the chat" />
              <span>I checked the chat, and the customer did not receive this message.</span>
            </label>
          ) : null}
          <Button
            className="w-full"
            disabled={busy || !retryAllowed || (uncertain && !checked)}
            onClick={() => run("Queued again", () => retryFailedReply({ ...item, confirmedUncertain: uncertain && checked, note }))}
          >
            Retry
          </Button>
          {!retryAllowed && retryReason ? <p className="text-[12px] text-[color:var(--color-muted-foreground)]">{retryReason}</p> : null}
          <Button variant="secondary" className="w-full" disabled={busy} onClick={() => run("Marked resolved", () => resolveFailedReplies({ items: [item], note }))}>
            Mark resolved
          </Button>
          <Button variant="secondary" className="w-full" disabled={busy || note.trim() === ""} onClick={() => run("Closed", () => closeFailedReplies({ items: [item], note }))}>
            Close permanently
          </Button>
        </div>
      ) : (
        <div className="mt-3">
          <Button variant="secondary" className="w-full" disabled={busy} onClick={() => run("Reopened", () => reopenFailedReply({ ...item, note }))}>
            Reopen
          </Button>
          <p className="mt-1 text-[12px] text-[color:var(--color-muted-foreground)]">
            {state === "RESOLVED" ? "Reopen only if the customer still needs this reply." : "Reopening puts it back on the list as failed."}
          </p>
        </div>
      )}
    </Card>
  );
}
