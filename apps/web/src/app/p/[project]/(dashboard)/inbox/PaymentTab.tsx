"use client";

import { useState, useTransition } from "react";
import { Reply } from "lucide-react";
import type { ConversationRef } from "@support-automation/shared";
import { Alert, Badge, Button, Field, Input, Select, useToast } from "@/components/ui";
import Link, { useProjectRouter } from "@/components/ProjectLink";
import { fillComposer } from "@/lib/composerBridge";
import { CopyButton } from "@/components/contacts/contactDisplay";
import { createPaymentLink } from "@/server/actions/paymentLinks";
import type { ConversationPayments } from "@/server/payments/core";

const STATUS_COLOR: Record<string, "gray" | "green" | "blue" | "yellow"> = { OPEN: "blue", PAID: "green", CANCELLED: "gray", EXPIRED: "gray" };
const STATUS_LABEL: Record<string, string> = { OPEN: "Waiting", PAID: "Paid", CANCELLED: "Cancelled", EXPIRED: "Expired" };

/** Beside a chat: make a payment link and drop it in the reply box. A person presses send. */
export function PaymentTab({ conversation, card }: { conversation: ConversationRef; card: ConversationPayments }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [dueId, setDueId] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Shown when this conversation has no reply box to put the link in (closed, or outside the provider's reply window).
  const [toCopy, setToCopy] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const chooseDue = (id: string) => {
    setDueId(id);
    const due = card.dues.find((d) => d.id === id);
    if (due) {
      setAmount(due.remaining);
      setDescription(due.label);
    }
  };

  const place = (text: string, label: string) => {
    if (fillComposer(text)) {
      setToCopy(null);
      showToast({ tone: "success", title: `${label} is in your reply` });
    } else {
      setToCopy(text);
    }
  };

  const create = () =>
    start(async () => {
      const r = await createPaymentLink({ amount, description, conversation, clientDueId: dueId || undefined });
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setError(null);
      setAmount("");
      setDescription("");
      setDueId("");
      place(r.message, r.label);
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-3.5 p-4">
      {!card.ready ? (
        <Alert tone="warning">
          Set up a payment account first:{" "}
          <Link href="/settings/payment-gateways" className="underline">
            Payment accounts
          </Link>
        </Alert>
      ) : card.canCreate ? (
        <>
          {card.dues.length ? (
            <Field label="For an invoice (optional)">
              <Select value={dueId} onChange={(e) => chooseDue(e.target.value)}>
                <option value="">No invoice</option>
                {card.dues.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label} ({d.amount})
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Amount (BDT)">
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="1500" />
          </Field>
          <Field label="What it is for (optional)">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
          </Field>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Button onClick={create} disabled={pending || !amount.trim()}>
            {pending ? "Creating…" : "Create and put in my reply"}
          </Button>
        </>
      ) : null}

      {toCopy ? (
        <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3">
          <p className="mb-1 text-[12.5px] font-medium">There is no reply box here. Copy it instead:</p>
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-all text-[12.5px]">{toCopy}</p>
            <CopyButton value={toCopy} label="link" />
          </div>
        </div>
      ) : null}

      {card.links.length ? (
        <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
          {card.links.map((l) => (
            <li key={l.id} className="py-2">
              <div className="flex items-center justify-between gap-2">
                <Link href={`/payments/${l.id}`} className="tabular min-w-0 truncate text-[13px] font-medium hover:underline">
                  {l.label} · {l.amount}
                </Link>
                <Badge color={l.needsAttention ? "yellow" : (STATUS_COLOR[l.status] ?? "gray")}>{l.needsAttention ? "Check" : (STATUS_LABEL[l.status] ?? l.status)}</Badge>
              </div>
              {l.description ? <p className="truncate text-[12.5px] text-[color:var(--color-muted-foreground)]">{l.description}</p> : null}
              {l.url ? (
                <button type="button" onClick={() => place(l.url!, l.label)} className="link mt-0.5 inline-flex items-center gap-1 text-[12.5px]">
                  <Reply className="size-3.5" aria-hidden />
                  Put the link in my reply
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
