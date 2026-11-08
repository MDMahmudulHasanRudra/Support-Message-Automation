"use client";

import { useActionState } from "react";
import { Alert, Button, SwitchField } from "@/components/ui";
import { saveContactSettings, type ContactSettingsState } from "@/server/actions/contacts";

export function ContactSettingsForm({ ai, auto, aiEngineOn, canManage }: { ai: boolean; auto: boolean; aiEngineOn: boolean; canManage: boolean }) {
  const [state, action, pending] = useActionState<ContactSettingsState, FormData>(saveContactSettings, {});
  return (
    <form action={action} className="space-y-4 p-5">
      <fieldset disabled={!canManage} className="space-y-3">
        <SwitchField name="aiCollectionEnabled" defaultChecked={ai} label="Collect details with AI" description="When a customer writes a number, email or profile link, AI decides whether it is really theirs and saves it to the chat's contact. The same number is never saved twice. It only saves; it never sends anything." />
        {!aiEngineOn ? <Alert tone="warning">The AI engine is off for this installation, so this switch will wait until it is on.</Alert> : null}
        <SwitchField name="autoCreateFromChats" defaultChecked={auto} label="Add every new personal chat" description="Anyone who starts a one-to-one chat or writes on Messenger, Instagram, Telegram or your website becomes a contact. Uses no AI. Groups are added by a person, or by AI when a group is monitored." />
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
  );
}
