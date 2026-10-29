"use client";

import { useActionState, useState, useTransition } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import type { WidgetSettings } from "@support-automation/shared";
import { rotateWebchatSecretAction, saveWebchatSettingsAction, type WebchatSettingsState } from "@/server/actions/webchatSettings";
import { CopyValue } from "./ConnectionPanel";

/** Website chat: install snippet, widget settings and the identity secret (WEBSITE_CHAT.md). */

export function WebchatInstall({ snippet, hasIdentitySecret, connectionId, canManage }: { snippet: string | null; hasIdentitySecret: boolean; connectionId: string; canManage: boolean }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-4 text-[12.5px]">
      {snippet ? (
        <>
          <CopyValue label="Paste before </body> on your website" value={snippet} />
          <p className="text-[color:var(--color-muted-foreground)]">
            The widget only works on the addresses listed below. It loads after the page, never blocks it, and renders inside its own isolated area so it cannot change your site&apos;s styling. If your
            site sends a Content-Security-Policy, allow this app&apos;s address in <code>script-src</code> and <code>connect-src</code>.
          </p>
        </>
      ) : (
        <Alert tone="warning" title="This server's public address (NEXTAUTH_URL) is not set, so the install snippet cannot be built." />
      )}
      <div className="border-t border-[var(--color-border)] pt-4">
        <p className="mb-1 font-medium text-[color:var(--color-foreground)]">Signed-in customers (optional)</p>
        <p className="text-[color:var(--color-muted-foreground)]">
          To show a logged-in customer as verified, your SERVER computes <code>HMAC-SHA256(identity secret, user id)</code> as hex and the page sets, before the script:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-2.5 text-[11.5px]">{`<script>window.GetAssistChat = { user: { id: "123", name: "Rina", email: "rina@example.com", hash: "<hmac hex>" } };</script>`}</pre>
        <p className="mt-2 text-[color:var(--color-muted-foreground)]">Never put the secret in the page. Without a valid hash the visitor is anonymous and anything they type is shown as unverified.</p>
        {secret ? <CopyValue label="Identity secret — shown once" value={secret} /> : null}
        {error ? <Alert tone="danger" title={error} /> : null}
        {canManage ? (
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            loading={pending}
            onClick={() =>
              start(async () => {
                const r = await rotateWebchatSecretAction(connectionId);
                if (r.error) setError(r.error);
                else setSecret(r.secret ?? null);
              })
            }
          >
            {hasIdentitySecret ? "Replace identity secret" : "Create identity secret"}
          </Button>
        ) : null}
        {hasIdentitySecret && !secret ? <p className="mt-1.5 text-[11.5px] text-[color:var(--color-subtle-foreground)]">A secret exists. Replacing it stops the old one verifying anybody.</p> : null}
      </div>
    </div>
  );
}

export function WebchatSettingsForm({ connectionId, settings, origins, canManage }: { connectionId: string; settings: WidgetSettings; origins: string[]; canManage: boolean }) {
  const [state, action, pending] = useActionState<WebchatSettingsState, FormData>(saveWebchatSettingsAction, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="connectionId" value={connectionId} />
      <fieldset disabled={!canManage} className="space-y-3">
        <Field label="Websites it runs on" htmlFor="origins" required hint="One per line, with https://.">
          <textarea id="origins" name="origins" rows={3} defaultValue={origins.join("\n")} className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px]" />
        </Field>
        <Field label="Title" htmlFor="title">
          <Input id="title" name="title" defaultValue={settings.title} maxLength={60} />
        </Field>
        <Field label="Welcome message" htmlFor="welcome" hint="The first bubble every visitor sees.">
          <Input id="welcome" name="welcome" defaultValue={settings.welcome} maxLength={300} />
        </Field>
        <Field label="Under the title" htmlFor="replyNote" hint="When people can expect an answer. Leave empty to hide.">
          <Input id="replyNote" name="replyNote" defaultValue={settings.replyNote} maxLength={120} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Colour" htmlFor="color">
            <input id="color" name="color" type="color" defaultValue={settings.color} className="h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]" />
          </Field>
          <Field label="Position" htmlFor="position">
            <select id="position" name="position" defaultValue={settings.position} className="h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[13px]">
              <option value="right">Bottom right</option>
              <option value="left">Bottom left</option>
            </select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" name="askName" defaultChecked={settings.askName} /> Ask for a name before the first message (optional for the visitor)
        </label>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" name="askEmail" defaultChecked={settings.askEmail} /> Ask for an email (optional for the visitor)
        </label>
      </fieldset>
      {state.error ? <Alert tone="danger" title={state.error} /> : null}
      {state.success ? <Alert tone="success" title={state.success} /> : null}
      {canManage ? (
        <Button type="submit" loading={pending}>
          Save widget
        </Button>
      ) : null}
    </form>
  );
}
