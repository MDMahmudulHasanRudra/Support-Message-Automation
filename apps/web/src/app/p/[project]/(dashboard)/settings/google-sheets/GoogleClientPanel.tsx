"use client";

import { useActionState, useState, useTransition } from "react";
import { Copy } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Badge, Button, ConfirmDialog, Field, Input, Switch, useToast } from "@/components/ui";
import {
  revalidateGoogleClientAction,
  saveGoogleClientAction,
  setGoogleIntegrationEnabledAction,
  type SettingsActionResult,
} from "@/server/actions/googleSheetsSettings";

/** What the page knows about the project's client — never the secret, only whether one is saved. */
export interface ClientPanelView {
  enabled: boolean;
  source: "PROJECT" | "ENVIRONMENT" | null;
  refusal: string | null;
  clientId: string | null;
  hasSecret: boolean;
  validationStatus: "UNVALIDATED" | "VALID" | "INVALID" | null;
  validatedAt: string | null;
  validationError: string | null;
  credentialsUpdatedAt: string | null;
  credentialsUpdatedByUsername: string | null;
  enabledChangedAt: string | null;
  enabledChangedByUsername: string | null;
  environmentClientAvailable: boolean;
  redirectUri: string | null;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

/**
 * The project's Google OAuth client (GOOGLE_SHEETS.md §22): its status, the on/off switch, the form to
 * save or update the client ID and secret (checked with Google before saving), and how to create one.
 */
export function GoogleClientPanel({ view, canManage }: { view: ClientPanelView; canManage: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [confirmOff, setConfirmOff] = useState(false);
  const [state, formAction, saving] = useActionState<SettingsActionResult, FormData>(saveGoogleClientAction, {});

  const settle = (result: SettingsActionResult) => {
    showToast({ tone: result.error ? "danger" : "success", title: result.error ?? result.success ?? "Saved" });
    router.refresh();
  };
  const setEnabled = (enabled: boolean) => startTransition(async () => settle(await setGoogleIntegrationEnabledAction(enabled)));

  const status = !view.enabled ? (
    <Badge color="gray">Switched off</Badge>
  ) : view.source === "PROJECT" && view.validationStatus === "VALID" ? (
    <Badge color="green" dot>
      Ready — accepted by Google
    </Badge>
  ) : view.source === "PROJECT" ? (
    <Badge color="yellow">Saved — not yet confirmed by Google</Badge>
  ) : view.source === "ENVIRONMENT" ? (
    <Badge color="blue">Using the server&apos;s default client</Badge>
  ) : view.validationStatus === "INVALID" ? (
    <Badge color="red">Rejected by Google</Badge>
  ) : (
    <Badge color="gray">Not set up</Badge>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          {status}
          {view.clientId ? <span className="font-mono text-[12px] [overflow-wrap:anywhere] text-[color:var(--color-muted-foreground)]">{view.clientId}</span> : null}
        </div>
        {canManage ? (
          <label className="flex cursor-pointer items-center gap-2 text-[13px]">
            <Switch
              checked={view.enabled}
              disabled={pending}
              onChange={(e) => (e.target.checked ? setEnabled(true) : setConfirmOff(true))}
              aria-label="Google integration on for this project"
            />
            Integration {view.enabled ? "on" : "off"}
          </label>
        ) : null}
      </div>

      {view.refusal && view.enabled ? <Alert tone={view.validationStatus === "INVALID" ? "danger" : "info"} title={view.refusal} /> : null}
      {!view.enabled ? (
        <Alert tone="info" title="Nothing is sent to Google for this project">
          Spreadsheets cannot be opened or refreshed and changes made in Google are not read. Credentials, connected accounts, members and history are kept — switching it
          back on resumes without connecting again.
        </Alert>
      ) : null}
      {view.validationError && view.source === "PROJECT" ? <p className="text-[12.5px] text-[color:var(--color-warning-fg)]">{view.validationError}</p> : null}

      <dl className="grid gap-x-6 gap-y-1 text-[12.5px] text-[color:var(--color-muted-foreground)] sm:grid-cols-2">
        {view.validatedAt ? (
          <div suppressHydrationWarning>
            <dt className="inline">Accepted by Google: </dt>
            <dd className="inline">{when(view.validatedAt)}</dd>
          </div>
        ) : null}
        {view.credentialsUpdatedAt ? (
          <div suppressHydrationWarning>
            <dt className="inline">Credentials saved: </dt>
            <dd className="inline">
              {when(view.credentialsUpdatedAt)}
              {view.credentialsUpdatedByUsername ? ` by ${view.credentialsUpdatedByUsername}` : ""}
            </dd>
          </div>
        ) : null}
        {view.enabledChangedAt ? (
          <div suppressHydrationWarning>
            <dt className="inline">Switched {view.enabled ? "on" : "off"}: </dt>
            <dd className="inline">
              {when(view.enabledChangedAt)}
              {view.enabledChangedByUsername ? ` by ${view.enabledChangedByUsername}` : ""}
            </dd>
          </div>
        ) : null}
      </dl>

      <div>
        <p className="mb-1 text-[12.5px] font-medium text-[color:var(--color-foreground)]">Authorised redirect URI to register on the client</p>
        <div className="flex items-center gap-2">
          <code className="block min-w-0 flex-1 rounded-[var(--radius-sm)] bg-[var(--color-surface-sunken)] px-2 py-1.5 font-mono text-[12px] break-all">
            {view.redirectUri ?? "(set NEXTAUTH_URL on the server first — the redirect URI is built from it)"}
          </code>
          {view.redirectUri ? (
            <Button
              size="sm"
              variant="secondary"
              type="button"
              onClick={() => void navigator.clipboard?.writeText(view.redirectUri ?? "").then(() => showToast({ tone: "success", title: "Redirect URI copied." }))}
            >
              <Copy className="size-3.5" aria-hidden />
              Copy
            </Button>
          ) : null}
        </div>
      </div>

      {canManage ? (
        <form action={formAction} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-3.5">
          <p className="text-[13px] font-medium text-[color:var(--color-foreground)]">{view.clientId ? "Update credentials" : "Add this project's OAuth client"}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Client ID" htmlFor="gs-client-id" hint="Ends in .apps.googleusercontent.com.">
              <Input id="gs-client-id" name="clientId" defaultValue={view.clientId ?? ""} autoComplete="off" spellCheck={false} required />
            </Field>
            <Field
              label="Client secret"
              htmlFor="gs-client-secret"
              hint={view.hasSecret ? "A secret is saved. Leave empty to keep it (same client ID only)." : "Shown once on the client's page in Google Cloud."}
            >
              <Input
                id="gs-client-secret"
                name="clientSecret"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={view.hasSecret ? "•••••••• saved" : ""}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={saving}>
              Save and check with Google
            </Button>
            {view.clientId && view.hasSecret ? (
              <Button type="button" variant="secondary" disabled={pending} onClick={() => startTransition(async () => settle(await revalidateGoogleClientAction()))}>
                Check again
              </Button>
            ) : null}
          </div>
          <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
            Google is asked whether the ID and secret belong together before anything is saved; a pair it rejects is not saved. Changing the client ID means each connected
            account must be connected again — Google only accepts an account&apos;s access through the client that issued it.
          </p>
          {state.error ? (
            <Alert tone="danger" title="Not saved">
              {state.error}
            </Alert>
          ) : state.success ? (
            <Alert tone="success" title={state.success} />
          ) : null}
        </form>
      ) : null}

      <details className="text-[13px]">
        <summary className="cursor-pointer font-medium text-[color:var(--color-foreground)]">How to create the OAuth client in Google Cloud</summary>
        <p className="mt-2 text-[12.5px] text-[color:var(--color-muted-foreground)]">
          The app cannot create it for you: it is made in your own Google Cloud project, then pasted here.
        </p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 leading-relaxed">
          <li>
            In Google Cloud Console, create or choose a project, and enable the <strong>Google Drive API</strong>, <strong>Google Sheets API</strong> and{" "}
            <strong>Drive Activity API</strong>.
          </li>
          <li>
            <strong>Google Auth Platform → Audience</strong>: <strong>Internal</strong> if every account belongs to one Google Workspace. Otherwise <strong>External</strong>; in{" "}
            <em>Testing</em> only listed test users can connect or link themselves, and Google expires their access after 7 days. Publishing an External app that uses
            Drive scopes requires Google&apos;s verification.
          </li>
          <li>
            <strong>Data access</strong>: add openid, email, profile, drive.metadata.readonly, spreadsheets and drive.activity.readonly.
          </li>
          <li>
            <strong>Clients → Create client → Web application</strong>, with the redirect URI above under Authorized redirect URIs.
          </li>
          <li>Paste the client ID and secret into the form above and save. Then connect an account below.</li>
        </ol>
        {view.environmentClientAvailable ? (
          <p className="mt-2 text-[12.5px] text-[color:var(--color-muted-foreground)]">
            This server also has a default client in its environment, used by any project that has not saved its own.
          </p>
        ) : null}
      </details>

      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={() => {
          setConfirmOff(false);
          setEnabled(false);
        }}
        title="Switch the Google integration off for this project?"
        description="Spreadsheets stop opening and refreshing, and changes made in Google stop being read. Nothing is deleted or disconnected; switching it on again resumes as before."
        confirmLabel="Switch off"
        tone="danger"
        loading={pending}
      />
    </div>
  );
}
