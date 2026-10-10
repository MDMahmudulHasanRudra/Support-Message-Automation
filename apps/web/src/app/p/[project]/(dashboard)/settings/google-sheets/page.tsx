import { Alert, Badge, ButtonLink, Card, PageHeader, SectionHeader } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { getGoogleSheetsSettings } from "@/server/google/settings";
import { GoogleSheetsSettingsForm } from "./GoogleSheetsSettingsForm";
import { listGoogleAccounts } from "@/server/google/accounts";
import { SPREADSHEET_LIST_CAP } from "@/server/google/api";
import { expectedRedirectUri, GOOGLE_SCOPES, googleOAuthConfig } from "@/server/google/oauth";
import { GoogleAccountList } from "./GoogleAccountList";

export const metadata = { title: "Google Accounts" };

/** Every `google_error` the OAuth routes can send back, in words an admin can act on. */
const ERRORS: Record<string, string> = {
  expired: "The connection took too long or was started in another browser. Press Connect Google Account again.",
  state: "Google's answer did not match the request that was sent, so it was refused. Press Connect Google Account again.",
  denied: "Google access was not granted. Nothing was connected.",
  session: "You were signed in as somebody else when Google answered, so nothing was connected. Sign in as yourself and try again.",
  permission: "Connecting Google accounts needs the “Manage Google Sheets Accounts & Assignments” permission in this project.",
  not_configured: "Google sign-in is not set up on this server yet. Follow the steps below.",
  missing_scopes: "Google did not grant access to see and edit spreadsheets. Connect again and leave every permission ticked on Google's screen.",
  no_refresh_token: "Google did not grant offline access. Remove this app at myaccount.google.com/permissions, then connect again.",
  google_refused: "Google refused the connection. Press Connect Google Account again; if it keeps failing, check the OAuth client settings.",
  failed: "The connection could not be completed because of a server error. Check System Logs and try again.",
};

/**
 * Settings → Google Sheets → Google Accounts (GOOGLE_SHEETS.md, Phase 1). Connect Google accounts to
 * this project through Google's own consent screen, see what each can reach, and disconnect them.
 * No token, ciphertext or client secret is ever sent to this page.
 */
export default async function GoogleAccountsPage({ searchParams }: { searchParams: Promise<{ connected?: string; google_error?: string }> }) {
  const { canManage } = await pageAccess("google_sheets.view", "google_sheets.manage", "GOOGLE_SHEETS");
  const [accounts, params, settings, bridgeRows] = await Promise.all([
    listGoogleAccounts(),
    searchParams,
    getGoogleSheetsSettings(),
    prisma.googleIntegrationAccount.findMany({ select: { email: true, activityIdentityVerifiedAt: true, activityIdentityMismatchAt: true } }),
  ]);
  const mismatch = bridgeRows.find((r) => r.activityIdentityMismatchAt);
  const verified = bridgeRows.find((r) => r.activityIdentityVerifiedAt);
  const configured = googleOAuthConfig() !== null;
  const redirectUri = expectedRedirectUri();

  return (
    <div>
      <PageHeader
        title="Google Accounts"
        description="Connect the Google accounts your team's spreadsheets live in. Each one is connected through Google's own sign-in screen — no spreadsheet IDs, service accounts or sharing needed."
        actions={
          canManage && configured ? (
            <ButtonLink href="/api/google-sheets/connect" variant="primary" size="md">
              + Connect Google Account
            </ButtonLink>
          ) : null
        }
      />

      {params.connected ? (
        <div className="mb-6">
          <Alert tone="success" title={`${params.connected} is connected`}>
            Its spreadsheets are now reachable from this project.
          </Alert>
        </div>
      ) : null}
      {params.google_error ? (
        <div className="mb-6">
          <Alert tone="danger" title="Google account not connected">
            {ERRORS[params.google_error] ?? ERRORS.failed}
          </Alert>
        </div>
      ) : null}
      {canManage ? null : (
        <div className="mb-6">
          <Alert tone="info" title="View only">
            Connecting and disconnecting accounts needs the “Manage Google Sheets Accounts &amp; Assignments” permission.
          </Alert>
        </div>
      )}

      {configured ? null : (
        <Card className="mb-6">
          <SectionHeader
            title="Set up Google sign-in (once per server)"
            description="The server needs its own Google OAuth client before any account can be connected. This is done once, by whoever manages the server."
          />
          <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-relaxed text-[color:var(--color-foreground)]">
            <li>
              In Google Cloud Console, create (or choose) a project and enable the <strong>Google Drive API</strong>, the{" "}
              <strong>Google Sheets API</strong> and the <strong>Drive Activity API</strong>.
            </li>
            <li>
              Configure the OAuth consent screen. For accounts inside one Google Workspace organisation choose <strong>Internal</strong>.
              An <strong>External</strong> app left in <em>Testing</em> only lets listed test users connect, and Google expires their
              access after 7 days.
            </li>
            <li>
              Create an OAuth client ID of type <strong>Web application</strong> with this authorised redirect URI:
              <code className="mt-1 block w-fit max-w-full rounded-[var(--radius-sm)] bg-[var(--color-surface-sunken)] px-2 py-1 font-mono text-[12px] break-all">
                {redirectUri ?? "(set NEXTAUTH_URL on the server first — the redirect URI is built from it)"}
              </code>
            </li>
            <li>
              Put the client ID and secret in the server&apos;s <code className="font-mono">.env</code> as{" "}
              <code className="font-mono">GOOGLE_OAUTH_CLIENT_ID</code> and <code className="font-mono">GOOGLE_OAUTH_CLIENT_SECRET</code>, then restart the
              app and the worker. The secret stays on the server; it is never sent to a browser.
            </li>
          </ol>
        </Card>
      )}

      <GoogleAccountList accounts={accounts} canManage={canManage} configured={configured} countCap={SPREADSHEET_LIST_CAP} />

      <Card className="mt-6">
        <SectionHeader
          title="Work time and changes made in Google"
          description="How time spent on a spreadsheet in the app is measured, and whether the app reads who changed a monitored spreadsheet in Google directly."
        />
        <GoogleSheetsSettingsForm
          canManage={canManage}
          inactivityMinutes={settings.inactivityMinutes}
          externalActivityEnabled={settings.externalActivityEnabled}
          updated={settings.updatedByUsername ? `Last changed by ${settings.updatedByUsername}.` : null}
        />
        <div className="mt-5 border-t border-[var(--color-border)] pt-4 text-[13px]">
          <p className="mb-1.5 font-medium text-[color:var(--color-foreground)]">Crediting changes made in Google to people</p>
          {mismatch ? (
            <p className="text-[color:var(--color-danger-fg)]">
              <Badge color="red">Stopped</Badge> Google identified {mismatch.email}&apos;s own change with a different account number from its sign-in, so no change made in Google
              is credited to anyone in this project. They are all listed as unattributed.
            </p>
          ) : verified ? (
            <p className="text-[color:var(--color-muted-foreground)]">
              <Badge color="green">Confirmed</Badge> Google&apos;s record of {verified.email}&apos;s own change used the same account number as its sign-in, so a change made in
              Google is credited to the person who linked that Google account as their own (Google Sheets → My Google identity).
            </p>
          ) : (
            <p className="text-[color:var(--color-muted-foreground)]">
              <Badge color="gray">Not confirmed yet</Badge> Until Google is seen to identify a connected account&apos;s own change with that account&apos;s sign-in number, changes
              made in Google are listed as unattributed. It is confirmed automatically the first time a connected account edits a monitored spreadsheet in Google.
            </p>
          )}
        </div>
      </Card>

      <Card className="mt-6">
        <SectionHeader title="What the app asks Google for" description="Shown on Google's consent screen when an account is connected." />
        <ul className="space-y-1.5 text-[13px] text-[color:var(--color-muted-foreground)]">
          <li>
            <strong className="text-[color:var(--color-foreground)]">Your name and email</strong> — to know which account was connected.
          </li>
          <li>
            <strong className="text-[color:var(--color-foreground)]">See the list of your Google Drive files</strong> — to list your spreadsheets
            with their names and dates, without opening them.
          </li>
          <li>
            <strong className="text-[color:var(--color-foreground)]">See, edit, create and delete your spreadsheets</strong> — to show and change
            the sheets you open here.
          </li>
          <li>
            <strong className="text-[color:var(--color-foreground)]">See the activity record of files in your Google Drive</strong> — optional; to
            learn who changed a monitored spreadsheet in Google directly. Never which cells, and never for how long.
          </li>
        </ul>
        <p className="mt-3 font-mono text-[11px] break-all text-[color:var(--color-subtle-foreground)]">{GOOGLE_SCOPES.join("  ")}</p>
      </Card>
    </div>
  );
}
