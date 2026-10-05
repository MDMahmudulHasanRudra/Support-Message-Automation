"use client";

import { isFinishedOperationState, type WhatsAppOperation, type WhatsAppOperationKind } from "@support-automation/shared";
import { Card } from "@/components/ui";
import { OperationSummary } from "./OperationSummary";
import { ClearOperationButton } from "./ClearOperationButton";
import { useWhatsAppOperations, useWithoutCleared } from "./operationsStore";

/**
 * A module page's running jobs of one kind, kept live by the same poll as the job indicator. The
 * server renders `initial`, so returning to the page shows the job where it is straight away, with
 * no empty flash before the first poll.
 */
export function CurrentOperations({
  kind,
  projectSlug,
  initial,
}: {
  kind: WhatsAppOperationKind;
  projectSlug: string;
  initial: WhatsAppOperation[];
}) {
  const { ops, loaded } = useWhatsAppOperations(projectSlug);
  // The server already leaves out what this person cleared; this also covers the click before the
  // next poll, on the server-rendered list too, so the card and the indicator disappear together.
  const fromServer = useWithoutCleared(initial);
  const running = (loaded ? ops : fromServer).filter((op) => op.kind === kind && !isFinishedOperationState(op.state));
  if (running.length === 0) return null;
  return (
    <section className="mb-6 flex flex-col gap-4" aria-label="Current operations">
      <h2 className="text-sm font-semibold text-[color:var(--color-foreground)]">Current operation{running.length === 1 ? "" : "s"}</h2>
      {running.map((op) => (
        <Card key={op.id} className="p-5">
          <OperationSummary op={op} actions={<ClearOperationButton op={op} />} />
        </Card>
      ))}
    </section>
  );
}
