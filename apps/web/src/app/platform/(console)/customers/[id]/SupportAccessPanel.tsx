"use client";

import { useRouter } from "next/navigation";
import { useActionState, useTransition } from "react";
import { Alert, Badge, Button, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { endSupportAccess, startSupportAccess } from "@/server/platform/actions/support";
import type { SupportSessionView } from "@/server/platform/support";

const DURATIONS = [15, 30, 60, 120];

/** Start an audited support session on the customer's own address; see and end the recent ones. */
export function SupportAccessPanel({ customerId, canSupport, sessions }: { customerId: string; canSupport: boolean; sessions: SupportSessionView[] }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [, startTransition] = useTransition();
  const [state, action, pending] = useActionState<{ error?: string; url?: string }, FormData>(async (_prev, fd) => {
    const r = await startSupportAccess(customerId, fd);
    if (r.url) {
      window.open(r.url, "_blank", "noopener");
      router.refresh();
    }
    return r;
  }, {});

  return (
    <div className="space-y-4">
      {canSupport ? (
        <form action={action} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
          <Field label="Reason" htmlFor="sa-reason" hint="Recorded on the platform and in the customer's own System Log.">
            <Textarea id="sa-reason" name="reason" rows={2} maxLength={500} required placeholder="e.g. Customer reports WhatsApp messages not arriving since 10:00" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="For" htmlFor="sa-minutes">
              <Select id="sa-minutes" name="minutes" defaultValue="30">
                {DURATIONS.map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Your platform password" htmlFor="sa-pass">
              <Input id="sa-pass" name="operatorPassword" type="password" autoComplete="current-password" required />
            </Field>
          </div>
          {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
          {state.url ? <Alert tone="success">Opened in a new tab. If it was blocked, start again — the link works once, for one minute.</Alert> : null}
          <div className="flex justify-end">
            <Button type="submit" loading={pending}>
              Enter workspace
            </Button>
          </div>
        </form>
      ) : (
        <Alert tone="info">Your platform account is not allowed to enter customers&apos; software.</Alert>
      )}

      {sessions.length > 0 ? (
        <ul className="divide-y divide-[var(--color-border)] text-sm">
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium">{s.operatorUsername}</span>{" "}
                <span className="text-xs text-[color:var(--color-muted-foreground)]">
                  {new Date(s.createdAt).toLocaleString()} · {s.active ? `until ${new Date(s.expiresAt).toLocaleTimeString()}` : s.endedAt ? `${(s.endReason ?? "ended").toLowerCase()}${s.endedByUsername ? ` by ${s.endedByUsername}` : ""}` : "expired"}
                  {s.ticketUsedAt ? "" : " · link not used"}
                </span>
                <span className="block text-xs text-[color:var(--color-muted-foreground)]">{s.reason}</span>
              </span>
              {s.active ? (
                <span className="flex items-center gap-2">
                  <Badge color="yellow" dot>
                    Open
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      startTransition(async () => {
                        const r = await endSupportAccess(s.id);
                        showToast({ tone: r.error ? "danger" : "success", title: r.error ? "Not done" : "Done", description: r.error ?? r.success ?? "" });
                        router.refresh();
                      })
                    }
                  >
                    End now
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
