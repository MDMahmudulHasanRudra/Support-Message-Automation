"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { ChevronDown } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Button, Field, Input, Select, Switch, useToast } from "@/components/ui";
import { EMAIL_TLS_LABELS, EMAIL_TLS_MODES, type EmailTlsModeValue } from "@support-automation/shared";
import { saveEmailSettings, sendTestEmail, setEmailEnabled, type EmailFormState } from "@/server/actions/emailSettings";
import type { EmailSettingsView } from "@/server/emailSettings";

/**
 * The common mail providers' published SMTP settings. Picking one fills the server, port and security, so a
 * person only types their address and password. "Other" shows every field. Values here are the providers' own
 * documented ones; the form still lets anybody change them under "More options".
 */
const PROVIDERS = [
  { id: "gmail", label: "Gmail / Google Workspace", host: "smtp.gmail.com", port: 587, tls: "STARTTLS", tip: "Use an app password (Google Account → Security → 2-Step Verification → App passwords), not your normal password." },
  { id: "outlook", label: "Outlook / Microsoft 365", host: "smtp.office365.com", port: 587, tls: "STARTTLS", tip: "Your Microsoft 365 admin must allow “Authenticated SMTP” for this mailbox." },
  { id: "zoho", label: "Zoho Mail", host: "smtp.zoho.com", port: 465, tls: "TLS", tip: "If two-factor sign-in is on, use an app-specific password from Zoho's security settings." },
  { id: "yahoo", label: "Yahoo Mail", host: "smtp.mail.yahoo.com", port: 465, tls: "TLS", tip: "Use an app password from Yahoo's account security page." },
  { id: "other", label: "Other / my hosting", host: "", port: 587, tls: "STARTTLS", tip: "Your hosting or mail provider lists these as “SMTP settings” or “outgoing mail server”." },
] as const satisfies readonly { id: string; label: string; host: string; port: number; tls: EmailTlsModeValue; tip: string }[];
type ProviderId = (typeof PROVIDERS)[number]["id"];

function providerFor(host: string): ProviderId | null {
  if (!host) return null;
  return PROVIDERS.find((p) => p.host && p.host === host.trim().toLowerCase())?.id ?? "other";
}

/** The SMTP settings. The password is write-only: it is never filled in, and blank keeps the stored one. */
export function EmailSettingsForm({ settings }: { settings: EmailSettingsView }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [state, formAction, pending] = useActionState<EmailFormState, FormData>(saveEmailSettings, {});
  const [message, setMessage] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [busy, startTransition] = useTransition();
  const v = (key: string, fallback: string) => state.values?.[key] ?? fallback;

  const [provider, setProvider] = useState<ProviderId | null>(providerFor(v("host", settings.host)));
  const [host, setHost] = useState(v("host", settings.host));
  const [port, setPort] = useState(v("port", String(settings.port)));
  const [tls, setTls] = useState(v("tlsMode", settings.tlsMode));
  const [address, setAddress] = useState(v("fromAddress", settings.fromAddress));
  // The sign-in name is the address for nearly every provider; it follows the address until someone changes it.
  const [username, setUsername] = useState(v("username", settings.username));
  const [usernameEdited, setUsernameEdited] = useState(Boolean(settings.username) && settings.username !== settings.fromAddress);
  const [more, setMore] = useState(provider === "other");
  const testAfterSave = useRef(false);

  useEffect(() => {
    if (!state.success) return;
    showToast({ tone: "success", title: state.message ?? "Saved" });
    if (testAfterSave.current) {
      testAfterSave.current = false;
      test();
    } else router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per successful save
  }, [state]);

  function choose(id: ProviderId) {
    const p = PROVIDERS.find((x) => x.id === id)!;
    setProvider(id);
    if (id !== "other") {
      setHost(p.host);
      setPort(String(p.port));
      setTls(p.tls);
    } else if (PROVIDERS.some((x) => x.host && x.host === host)) {
      setHost("");
    }
    setMore(id === "other");
  }

  function toggle(next: boolean) {
    startTransition(async () => {
      const r = await setEmailEnabled(next);
      setMessage({ tone: r.ok ? "info" : "danger", text: r.message });
      router.refresh();
    });
  }
  function test() {
    startTransition(async () => {
      const r = await sendTestEmail();
      setMessage({ tone: r.ok ? "info" : "danger", text: r.ok ? `${r.message} Check your inbox, then switch email on below.` : r.message });
      router.refresh();
    });
  }

  const chosen = PROVIDERS.find((p) => p.id === provider) ?? null;

  return (
    <div className="space-y-6">
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}

      <div>
        <p className="mb-2 text-[13px] font-medium text-[color:var(--color-foreground)]">1. Who provides your email?</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Email provider">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={provider === p.id}
              onClick={() => choose(p.id)}
              className={`h-9 rounded-[var(--radius-md)] border px-3 text-[13px] font-medium transition-colors ${
                provider === p.id
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-bg)] text-[color:var(--color-foreground)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {chosen ? <p className="mt-2 text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">{chosen.tip}</p> : null}
      </div>

      {provider ? (
        <form
          action={formAction}
          onSubmit={(e) => {
            testAfterSave.current = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("data-test") === "1";
          }}
          className="space-y-4"
        >
          {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
          <p className="text-[13px] font-medium text-[color:var(--color-foreground)]">2. Your email address and password</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Field label="Email address">
              <Input
                name="fromAddress"
                type="email"
                required
                placeholder="support@your-domain.com"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  if (!usernameEdited) setUsername(e.target.value);
                }}
              />
            </Field>
            <Field label={settings.passwordSet ? "Password (blank keeps the saved one)" : chosen && chosen.id !== "other" ? "App password" : "Password"}>
              <Input name="password" type="password" autoComplete="new-password" placeholder={settings.passwordSet ? "Saved — hidden" : ""} />
            </Field>
            <Field label="Name people see">
              <Input name="fromName" maxLength={100} placeholder="e.g. Support Team" defaultValue={v("fromName", settings.fromName)} />
            </Field>
          </div>

          <button
            type="button"
            onClick={() => setMore((m) => !m)}
            aria-expanded={more}
            className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
          >
            <ChevronDown className={`size-3.5 transition-transform ${more ? "rotate-180" : ""}`} aria-hidden />
            {provider === "other" ? "Mail server details" : "More options"}
          </button>
          {/* Always submitted, shown only when asked for: a preset fills them. */}
          <div className={more ? "space-y-3" : "hidden"}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <Field label="Mail server (host)" className="sm:col-span-2">
                <Input name="host" required placeholder="smtp.your-provider.com" value={host} onChange={(e) => setHost(e.target.value)} autoComplete="off" />
              </Field>
              <Field label="Port">
                <Input name="port" inputMode="numeric" required value={port} onChange={(e) => setPort(e.target.value)} />
              </Field>
              <Field label="Security">
                <Select name="tlsMode" value={tls} onChange={(e) => setTls(e.target.value as EmailTlsModeValue)}>
                  {EMAIL_TLS_MODES.map((m) => (
                    <option key={m} value={m}>
                      {EMAIL_TLS_LABELS[m]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <Field label="Sign-in name" className="sm:col-span-2">
                <Input
                  name="username"
                  required
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setUsernameEdited(true);
                  }}
                  autoComplete="off"
                />
              </Field>
              <Field label="Reply-to (optional)" className="sm:col-span-2">
                <Input name="replyTo" type="email" defaultValue={v("replyTo", settings.replyTo)} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <Field label="Most per minute">
                <Input name="maxPerMinute" inputMode="numeric" defaultValue={v("maxPerMinute", String(settings.maxPerMinute))} />
              </Field>
              <Field label="Most per day">
                <Input name="maxPerDay" inputMode="numeric" defaultValue={v("maxPerDay", String(settings.maxPerDay))} />
              </Field>
              <p className="self-end text-xs text-[color:var(--color-muted-foreground)] sm:col-span-2">Set these to what your mail provider allows. The defaults are cautious.</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={pending || busy} data-test="1">
              Save and send me a test email
            </Button>
            <Button type="submit" variant="ghost" disabled={pending || busy}>
              Save only
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">Pick one to fill in the mail server for you.</p>
      )}

      {settings.exists ? (
        <div className="flex flex-wrap items-center gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
          <span className="text-[13px] font-medium text-[color:var(--color-foreground)]">3. Switch it on</span>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={settings.enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} aria-label="Email on or off" />
            Email is {settings.enabled ? "on" : "off"}
          </label>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={test}>
            Send another test
          </Button>
        </div>
      ) : null}
    </div>
  );
}
