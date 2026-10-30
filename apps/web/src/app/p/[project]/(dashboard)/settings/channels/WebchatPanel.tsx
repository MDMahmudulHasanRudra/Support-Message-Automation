"use client";

import { useActionState, useState, useTransition } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import type { WidgetSettings } from "@support-automation/shared";
import { rotateWebchatSecretAction, saveWebchatSettingsAction, type WebchatSettingsState } from "@/server/actions/webchatSettings";
import { CopyValue } from "./ConnectionPanel";

/** Website chat: install snippet, widget settings and the identity secret (WEBSITE_CHAT.md). */

export function WebchatInstall({
  snippet,
  hasIdentitySecret,
  connectionId,
  canManage,
  wordpressHref,
}: {
  snippet: string | null;
  hasIdentitySecret: boolean;
  connectionId: string;
  canManage: boolean;
  /** The plugin download (channels.manage only), or null. */
  wordpressHref: string | null;
}) {
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
      {wordpressHref ? (
        <div className="border-t border-[var(--color-border)] pt-4">
          <p className="mb-1 font-medium text-[color:var(--color-foreground)]">WordPress</p>
          <p className="mb-2 text-[color:var(--color-muted-foreground)]">
            A ready plugin with this widget built in: Plugins → Add New → Upload Plugin, then activate. The identity secret is not inside it; paste it under Settings → Get Assist Chat if you want
            signed-in customers (and WooCommerce billing phones) shown as verified.
          </p>
          <a href={wordpressHref} download className="inline-flex h-8 items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[12.5px] font-medium hover:bg-[var(--color-neutral-bg)]">
            Download WordPress plugin
          </a>
        </div>
      ) : null}
      <div className="border-t border-[var(--color-border)] pt-4">
        <p className="mb-1 font-medium text-[color:var(--color-foreground)]">Signed-in customers (optional)</p>
        <p className="text-[color:var(--color-muted-foreground)]">
          To show a logged-in customer as verified, your SERVER computes <code>HMAC-SHA256(identity secret, user id)</code> as hex and the page sets, before the script:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-2.5 text-[11.5px]">{`<script>window.GetAssistChat = { user: { id: "123", name: "Rina", email: "rina@example.com", hash: "<hmac hex>",
  phone: "01712345678", phoneHash: "<HMAC-SHA256(secret, \"phone:123:01712345678\") hex>" } };</script>`}</pre>
        <p className="mt-2 text-[color:var(--color-muted-foreground)]">
          Never put the secret in the page. Without a valid hash the visitor is anonymous and anything they type is shown as unverified. The phone is optional and needs its own hash; with it, the
          conversation shows the customer&apos;s client record and orders.
        </p>
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
        <div className="grid grid-cols-2 gap-3">
          <Field label="Button label" htmlFor="launcherLabel" hint="Shown beside the chat button. Empty = icon only.">
            <Input id="launcherLabel" name="launcherLabel" defaultValue={settings.launcherLabel} maxLength={30} />
          </Field>
          <Field label="Distance from the bottom (px)" htmlFor="bottomOffset" hint="Raise it above a cookie bar or a bottom menu.">
            <Input id="bottomOffset" name="bottomOffset" type="number" min={0} max={200} defaultValue={settings.bottomOffset} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" name="allowAttachments" defaultChecked={settings.allowAttachments} /> Let visitors send photos and PDFs (up to 10 MB, 10 an hour)
        </label>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" name="askName" defaultChecked={settings.askName} /> Ask for a name before the first message (optional for the visitor)
        </label>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" name="askEmail" defaultChecked={settings.askEmail} /> Ask for an email (optional for the visitor)
        </label>
        <BusinessHoursFields settings={settings} />
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

/** Saturday first, as the week is read here; the stored list stays Sunday-first (index = JS weekday). */
const HOURS_DAY_ORDER: ReadonlyArray<[number, string]> = [
  [6, "Saturday"],
  [0, "Sunday"],
  [1, "Monday"],
  [2, "Tuesday"],
  [3, "Wednesday"],
  [4, "Thursday"],
  [5, "Friday"],
];

/**
 * Business hours (WEBSITE_CHAT.md §Hours). Outside them the widget says the team is away and when it is
 * back, and can ask for an email. Visitors can always write: nothing is refused, and the conversation
 * waits in the inbox like any other.
 */
function BusinessHoursFields({ settings }: { settings: WidgetSettings }) {
  const [enabled, setEnabled] = useState(settings.hours.enabled);
  return (
    <div className="space-y-3 border-t border-[var(--color-border)] pt-3">
      <label className="flex items-center gap-2 text-[12.5px] font-medium">
        <input type="checkbox" name="hoursEnabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Business hours
      </label>
      {enabled ? (
        <>
          <Field label="Time zone" htmlFor="hoursTimezone" hint="An IANA name, like Asia/Dhaka or Europe/London.">
            <Input id="hoursTimezone" name="hoursTimezone" defaultValue={settings.hours.timezone} maxLength={60} />
          </Field>
          <div className="space-y-1.5">
            {HOURS_DAY_ORDER.map(([index, label]) => {
              const day = settings.hours.days[index];
              return (
                <DayRow key={index} index={index} label={label} open={day?.open ?? "09:00"} close={day?.close ?? "18:00"} closed={!day} />
              );
            })}
          </div>
          <Field label="Away message" htmlFor="offlineMessage" hint="Shown outside business hours.">
            <Input id="offlineMessage" name="offlineMessage" defaultValue={settings.offlineMessage} maxLength={300} />
          </Field>
          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" name="offlineAskEmail" defaultChecked={settings.offlineAskEmail} /> While away, ask for an email so the team can answer later
          </label>
        </>
      ) : (
        <>
          {/* Kept as they were while the switch is off, so turning it back on finds the same hours. */}
          <input type="hidden" name="hoursTimezone" value={settings.hours.timezone} />
          {settings.hours.days.map((day, index) =>
            day ? (
              <span key={index}>
                <input type="hidden" name={`open_${index}`} value={day.open} />
                <input type="hidden" name={`close_${index}`} value={day.close} />
              </span>
            ) : (
              <input key={index} type="hidden" name={`closed_${index}`} value="on" />
            ),
          )}
          <input type="hidden" name="offlineMessage" value={settings.offlineMessage} />
          {settings.offlineAskEmail ? <input type="hidden" name="offlineAskEmail" value="on" /> : null}
        </>
      )}
    </div>
  );
}

function DayRow({ index, label, open, close, closed: initiallyClosed }: { index: number; label: string; open: string; close: string; closed: boolean }) {
  const [closed, setClosed] = useState(initiallyClosed);
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
      <span className="w-24 shrink-0">{label}</span>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" name={`closed_${index}`} checked={closed} onChange={(e) => setClosed(e.target.checked)} /> Closed
      </label>
      {closed ? null : (
        <>
          <input type="time" name={`open_${index}`} defaultValue={open} aria-label={`${label} opens`} className="h-8 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2" />
          <span aria-hidden>–</span>
          <input type="time" name={`close_${index}`} defaultValue={close} aria-label={`${label} closes`} className="h-8 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2" />
        </>
      )}
    </div>
  );
}
