"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, CircleDashed, Copy, Stethoscope, XCircle } from "lucide-react";
import type { ChannelType } from "@support-automation/shared";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Button, ConfirmDialog, Input, Switch, useToast } from "@/components/ui";
import { disconnectChannelAction, setChannelFlagsAction, testChannelAction, type ChannelActionResult } from "@/server/actions/channelConnections";
import type { ConnectionCheck } from "@/server/channels/connections";

/** A copyable value — the webhook URL and Meta's verify token. */
export function CopyValue({ label, value, secret = false }: { label: string; value: string | null; secret?: boolean }) {
  const { showToast } = useToast();
  const [revealed, setRevealed] = useState(!secret);
  return (
    <div>
      <p className="mb-1 text-[12.5px] font-medium text-[color:var(--color-foreground)]">{label}</p>
      <div className="flex items-center gap-2">
        <code className="block min-w-0 flex-1 rounded-[var(--radius-sm)] bg-[var(--color-surface-sunken)] px-2 py-1.5 font-mono text-[12px] break-all">
          {value ? (revealed ? value : "•".repeat(Math.min(value.length, 24))) : "(set NEXTAUTH_URL on the server first — the address is built from it)"}
        </code>
        {value && secret ? (
          <Button size="sm" variant="ghost" type="button" onClick={() => setRevealed((r) => !r)}>
            {revealed ? "Hide" : "Show"}
          </Button>
        ) : null}
        {value ? (
          <Button size="sm" variant="secondary" type="button" onClick={() => void navigator.clipboard?.writeText(value).then(() => showToast({ tone: "success", title: `${label} copied.` }))}>
            <Copy className="size-3.5" aria-hidden />
            Copy
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ConnectionSwitches({
  id,
  type,
  enabled,
  aiAutomationEnabled,
  humanAgentEnabled,
  disconnected,
  canManage,
}: {
  id: string;
  type: ChannelType;
  enabled: boolean;
  aiAutomationEnabled: boolean;
  humanAgentEnabled: boolean;
  disconnected: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const set = (flags: Parameters<typeof setChannelFlagsAction>[1]) =>
    startTransition(async () => {
      const result = await setChannelFlagsAction(id, flags);
      showToast({ tone: result.error ? "danger" : "success", title: result.error ?? result.success ?? "Saved" });
      router.refresh();
    });
  const disabled = !canManage || pending || disconnected;
  const row = (label: string, hint: string, checked: boolean, onChange: (v: boolean) => void, lock = false) => (
    <label className={`flex items-start justify-between gap-4 py-3 ${disabled || lock ? "" : "cursor-pointer"}`}>
      <span>
        <span className="block text-[13px] font-medium text-[color:var(--color-foreground)]">{label}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-[color:var(--color-muted-foreground)]">{hint}</span>
      </span>
      <Switch checked={checked} disabled={disabled || lock} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
    </label>
  );
  return (
    <div className="divide-y divide-[var(--color-border)]">
      {row("Connection on", "Off: customers' messages still arrive and are shown, but nothing is sent from this connection and AI does not answer.", enabled, (v) => set({ enabled: v }))}
      {row(
        "AI may answer customers",
        "Uses the same AI Settings, knowledge base and safety rules as WhatsApp. Never in group chats, never while a person is handling the conversation, and only within the provider's reply window.",
        aiAutomationEnabled,
        (v) => set({ aiAutomationEnabled: v }),
      )}
      {type !== "TELEGRAM"
        ? row(
            "Human Agent permission approved",
            "Switch on only once Meta has approved Human Agent for your app. It lets a person (never AI) reply up to 7 days after the customer's last message instead of 24 hours.",
            humanAgentEnabled,
            (v) => set({ humanAgentEnabled: v }),
          )
        : null}
    </div>
  );
}

export function ConnectionHealth({ id, canManage }: { id: string; canManage: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<(ChannelActionResult & { checks?: ConnectionCheck[] }) | null>(null);
  return (
    <div className="space-y-3">
      <Button
        size="sm"
        variant="secondary"
        disabled={!canManage}
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            setResult(await testChannelAction(id));
            router.refresh();
          })
        }
      >
        <Stethoscope className="size-3.5" aria-hidden />
        Test connection
      </Button>
      {result?.error ? <Alert tone="danger" title={result.error} /> : null}
      {result?.checks ? (
        <ul className="space-y-1.5">
          {result.checks.map((c) => (
            <li key={c.label} className="flex items-start gap-2 text-[12.5px]">
              {c.ok === true ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-[color:var(--color-success)]" aria-label="OK" />
              ) : c.ok === false ? (
                <XCircle className="mt-0.5 size-3.5 shrink-0 text-[color:var(--color-danger)]" aria-label="Problem" />
              ) : (
                <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-[color:var(--color-subtle-foreground)]" aria-label="Unknown" />
              )}
              <span>
                <span className="font-medium text-[color:var(--color-foreground)]">{c.label}</span>
                <span className="text-[color:var(--color-muted-foreground)]"> — {c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function RenameConnection({ id, name, canManage }: { id: string; name: string; canManage: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [value, setValue] = useState(name);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await setChannelFlagsAction(id, { name: value });
          showToast({ tone: result.error ? "danger" : "success", title: result.error ?? "Renamed." });
          router.refresh();
        });
      }}
    >
      <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={80} disabled={!canManage} aria-label="Connection name" />
      <Button size="sm" variant="secondary" type="submit" disabled={!canManage || value.trim() === name || !value.trim()} loading={pending}>
        Rename
      </Button>
    </form>
  );
}

export function DisconnectConnection({ id, name, canManage }: { id: string; name: string; canManage: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  if (!canManage) return null;
  return (
    <>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}>
        Disconnect
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="danger"
        loading={pending}
        title={`Disconnect ${name}?`}
        description="The provider is told to stop sending messages here and the credentials are deleted. Every conversation and message stays in the inbox. Replies still waiting to go out are cancelled. You can reconnect later with new credentials."
        confirmLabel="Disconnect"
        onConfirm={() =>
          startTransition(async () => {
            const result = await disconnectChannelAction(id);
            setOpen(false);
            showToast({ tone: result.error ? "danger" : "success", title: result.error ?? result.success ?? "Disconnected." });
            router.refresh();
          })
        }
      />
    </>
  );
}
