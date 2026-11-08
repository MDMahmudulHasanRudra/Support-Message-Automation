"use client";

import { useState, useTransition } from "react";
import { Mail } from "lucide-react";
import Link from "@/components/ProjectLink";
import { useProjectRouter } from "@/components/ProjectLink";
import { Alert, Button, Dialog, Field, Select, useToast } from "@/components/ui";
import { addStandardRenewalReminder, prepareMessageBatch } from "@/server/actions/clientMessages";

/**
 * Prepares the reminder email for everybody on today's list. It sends nothing: the batch waits on Client Messages for
 * a different person to read and approve, exactly like any other bulk email, and clients with no address, no consent
 * or who opted out are skipped there with the reason.
 */
export function ReminderBatchButton({
  recipients,
  templates,
}: {
  recipients: Array<{ clientId: string; subscriptionId: string; offerId: string | null }>;
  templates: Array<{ id: string; name: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [chosenId, setTemplateId] = useState<string | null>(null);
  // The list refreshes after the standard reminder is added, and the state above stays.
  const templateId = chosenId && templates.some((t) => t.id === chosenId) ? chosenId : (templates[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useProjectRouter();
  const { showToast } = useToast();
  const count = recipients.length;

  return (
    <>
      <Button
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Mail className="size-4" aria-hidden />
        Email all {count}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Prepare a reminder email for ${count} client${count === 1 ? "" : "s"}`}>
        {templates.length === 0 ? (
          <div className="space-y-4">
            <p className="text-sm">
              You need a reminder email to send. Start with the standard one: it names the client, the service and the end
              date. You can change the wording any time in{" "}
              <Link href="/clients/templates" className="link">
                Templates
              </Link>
              .
            </p>
            {error ? <Alert tone="danger">{error}</Alert> : null}
            <div className="flex justify-end">
              <Button
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await addStandardRenewalReminder();
                    if (result.error) {
                      setError(result.error);
                      return;
                    }
                    setError(null);
                    if (result.templateId) setTemplateId(result.templateId);
                    router.refresh();
                  })
                }
              >
                {pending ? "Adding…" : "Add the standard reminder"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="Template">
              <Select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
              Nothing is sent yet. Another person reads the batch on Client Messages and approves it. Clients with no email
              address, no recorded consent or who opted out are left out, with the reason shown there.
            </p>
            {error ? <Alert tone="danger">{error}</Alert> : null}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={pending || !templateId}
                onClick={() =>
                  startTransition(async () => {
                    const result = await prepareMessageBatch(
                      templateId,
                      recipients.map((r) => ({ clientId: r.clientId, context: { subscriptionId: r.subscriptionId, offerId: r.offerId ?? undefined } })),
                    );
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    setOpen(false);
                    showToast({ tone: "success", title: "Waiting for approval", description: result.message });
                    router.push("/clients/messages");
                  })
                }
              >
                {pending ? "Preparing…" : "Prepare for approval"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
