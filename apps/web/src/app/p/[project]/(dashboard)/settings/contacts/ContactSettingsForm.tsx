"use client";

import { useActionState } from "react";
import { Alert, Button, SwitchField } from "@/components/ui";
import { rescanContactConversations, saveContactSettings, type ContactSettingsState } from "@/server/actions/contacts";

export function ContactSettingsForm({ ai, auto, aiEngineOn, canManage, progress }: { ai: boolean; auto: boolean; aiEngineOn: boolean; canManage: boolean; progress: string | null }) {
  const [state, action, pending] = useActionState<ContactSettingsState, FormData>(saveContactSettings, {});
  const [rescan, rescanAction, rescanPending] = useActionState<ContactSettingsState, FormData>(rescanContactConversations, {});
  return (
    <div className="divide-y divide-[var(--color-border)]">
      <form action={action} className="space-y-4 p-5">
        <fieldset disabled={!canManage} className="space-y-3">
          <SwitchField name="autoCreateFromChats" defaultChecked={auto} label="Collect from every conversation" description="Every conversation is read, past ones included. Numbers, emails and profile or website links customers wrote are saved to their contact, and everyone who writes in a one-to-one chat, Messenger, Instagram, Telegram or your website becomes a contact. Monitored groups are one contact each. Uses no AI. It only saves; it never sends anything." />
          <SwitchField name="aiCollectionEnabled" defaultChecked={ai} label="Check details with AI" description="For a few messages each minute, AI decides whether a number, email or link is really the customer's and can pick up their name. The rest are read without AI, so nothing waits for it. The same number is never saved twice." />
          {!aiEngineOn ? <Alert tone="warning">The AI engine is off for this installation, so details are read without AI until it is on.</Alert> : null}
        </fieldset>
        {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
        {state.success ? <Alert tone="success">{state.success}</Alert> : null}
        {canManage ? (
          <div className="flex justify-end">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : null}
      </form>
      {progress ? (
        <form action={rescanAction} className="space-y-3 p-5">
          <p className="text-sm text-[var(--color-muted-foreground)]">{progress}</p>
          {rescan.error ? <Alert tone="danger">{rescan.error}</Alert> : null}
          {rescan.success ? <Alert tone="success">{rescan.success}</Alert> : null}
          {canManage ? (
            <div className="flex justify-end">
              <Button type="submit" variant="secondary" disabled={rescanPending}>
                {rescanPending ? "Starting…" : "Scan all conversations again"}
              </Button>
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
