"use client";

import { useState, useTransition } from "react";
import { Button, SwitchField, useToast } from "@/components/ui";
import { saveInboxLifecyclePolicy } from "@/server/actions/inboxLifecycle";

export function InboxStatusForm({ reopenResolved, reopenSnoozed, canManage }: { reopenResolved: boolean; reopenSnoozed: boolean; canManage: boolean }) {
  const { showToast } = useToast();
  const [resolved, setResolved] = useState(reopenResolved);
  const [snoozed, setSnoozed] = useState(reopenSnoozed);
  const [busy, start] = useTransition();
  const dirty = resolved !== reopenResolved || snoozed !== reopenSnoozed;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveInboxLifecyclePolicy({ reopenResolved: resolved, reopenSnoozed: snoozed });
          showToast("error" in r ? { tone: "danger", title: "Nothing was saved", description: r.error } : { tone: "success", title: "Saved" });
        });
      }}
    >
      <SwitchField
        label="A customer message reopens a resolved conversation"
        description="On: it becomes Open again, so nobody misses that they wrote back. Off: it stays Resolved; the message is still stored and shown."
        checked={resolved}
        disabled={!canManage || busy}
        onChange={(e) => setResolved(e.target.checked)}
      />
      <SwitchField
        label="A customer message ends a snooze early"
        description="On: a snoozed conversation becomes Open as soon as the customer writes. Off: it waits for its snooze time."
        checked={snoozed}
        disabled={!canManage || busy}
        onChange={(e) => setSnoozed(e.target.checked)}
      />
      {canManage ? (
        <Button type="submit" disabled={busy || !dirty}>
          Save
        </Button>
      ) : null}
    </form>
  );
}
