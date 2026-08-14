"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog, Select } from "@/components/ui";
import {
  escalateNow,
  markResolved,
  pauseCase,
  reassignCase,
  resetEscalation,
  resumeCase,
  stopEscalation,
} from "@/server/actions/supportEscalation";

type DialogKind = "stop" | "reset" | "resolve" | null;

export function CaseActions({
  caseId,
  status,
  assignedTeamMemberId,
  teamMembers,
}: {
  caseId: string;
  status: string;
  assignedTeamMemberId: string | null;
  teamMembers: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [reassignValue, setReassignValue] = useState(assignedTeamMemberId ?? "");

  const isTerminal = status === "HUMAN_REPLIED" || status === "RESOLVED" || status === "CANCELLED";
  const isPaused = status === "PAUSED";

  function run(action: () => Promise<void>) {
    startTransition(async () => {
      await action();
      router.refresh();
    });
  }

  function confirmDialog() {
    startTransition(async () => {
      if (dialog === "stop") await stopEscalation(caseId);
      if (dialog === "reset") await resetEscalation(caseId);
      if (dialog === "resolve") await markResolved(caseId);
      setDialog(null);
      router.refresh();
    });
  }

  if (isTerminal) {
    return <p className="text-sm text-[color:var(--color-muted-foreground)]">No actions available — this case is closed.</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!isTerminal && !isPaused ? (
        <Button variant="secondary" size="sm" loading={pending} onClick={() => run(() => pauseCase(caseId))}>
          Pause
        </Button>
      ) : null}
      {isPaused ? (
        <Button variant="secondary" size="sm" loading={pending} onClick={() => run(() => resumeCase(caseId))}>
          Resume
        </Button>
      ) : null}
      {!isTerminal && !isPaused ? (
        <Button variant="secondary" size="sm" loading={pending} onClick={() => run(() => escalateNow(caseId))}>
          Escalate Immediately
        </Button>
      ) : null}
      {!isTerminal ? (
        <>
          <Select
            value={reassignValue}
            onChange={(e) => {
              setReassignValue(e.target.value);
              run(() => reassignCase(caseId, e.target.value || null));
            }}
            className="w-44"
          >
            <option value="">Unassigned</option>
            {teamMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <Button variant="secondary" size="sm" onClick={() => setDialog("reset")}>
            Reset
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setDialog("stop")}>
            Stop Escalation
          </Button>
          <Button size="sm" onClick={() => setDialog("resolve")}>
            Mark Resolved
          </Button>
        </>
      ) : null}

      <ConfirmDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        onConfirm={confirmDialog}
        loading={pending}
        tone={dialog === "stop" ? "danger" : "primary"}
        title={
          dialog === "stop"
            ? "Stop escalation for this case?"
            : dialog === "reset"
              ? "Reset escalation back to the start?"
              : "Mark this case resolved?"
        }
        description={
          dialog === "stop"
            ? "No further notifications will be sent. This doesn't claim a human replied."
            : dialog === "reset"
              ? "Clears the escalation level and reschedules an immediate check — history is kept."
              : "Stops monitoring for good. Use this once the issue is actually handled."
        }
        confirmLabel={dialog === "stop" ? "Stop Escalation" : dialog === "reset" ? "Reset" : "Mark Resolved"}
      />
    </div>
  );
}
