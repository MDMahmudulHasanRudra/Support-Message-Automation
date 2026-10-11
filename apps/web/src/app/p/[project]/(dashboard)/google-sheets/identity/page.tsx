import { Alert, ButtonLink, Card, PageHeader, SectionHeader } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { resolveProjectGoogleClient } from "@/server/google/clientConfig";
import { listMyGoogleIdentities } from "@/server/google/identity";
import { IdentityList } from "./IdentityList";

export const metadata = { title: "My Google identity" };

const ERRORS: Record<string, string> = {
  expired: "Linking took too long or was started in another browser. Press Link my Google account again.",
  state: "Google's answer did not match the request that was sent, so it was refused. Try again.",
  denied: "Google did not confirm an account. Nothing was linked.",
  session: "You were signed in as somebody else when Google answered, so nothing was linked. Sign in as yourself and try again.",
  permission: "Linking a Google identity needs the “View Google Sheets” permission in this project.",
  not_configured: "Google sign-in is not set up on this server yet. A Google Sheets manager can see how under Settings → Google Sheets.",
  disabled: "The Google integration is switched off for this project. A Google Sheets manager can switch it on under Settings → Google Sheets.",
  invalid_client: "Google rejected this project's OAuth client. A Google Sheets manager updates it under Settings → Google Sheets.",
  client_changed: "This project's OAuth client changed while you were on Google's screen. Press Link my Google account again.",
  google_refused: "Google refused the sign-in. Try again in a minute.",
  linked_elsewhere: "That Google account is already linked to another login. Ask that person to unlink it from their own page first.",
  failed: "Linking could not be completed because of a server error. Try again; if it keeps failing, tell an administrator.",
};

/**
 * My Google identity (GOOGLE_SHEETS.md §5, Phase 4): the person proves which Google account is their
 * own, by signing in with it. It is the ONLY way a change made in Google Sheets directly can be
 * credited to them — the app never guesses from an email or a name. Each person sees and changes only
 * their own.
 */
export default async function MyGoogleIdentityPage({ searchParams }: { searchParams: Promise<{ linked?: string; google_error?: string }> }) {
  const { session } = await pageAccess("google_sheets.view", "google_sheets.view", "GOOGLE_SHEETS");
  const [identities, params, teamMember] = await Promise.all([
    listMyGoogleIdentities(session.userId),
    searchParams,
    prisma.internalTeamMember.findFirst({ where: { userId: session.userId }, select: { name: true } }),
  ]);
  const configured = (await resolveProjectGoogleClient()).ok;

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="My Google identity"
        description="Link the Google account you use for your work, so that changes you make in Google Sheets directly are credited to you."
        actions={
          configured ? (
            <ButtonLink href="/api/google-sheets/identity" variant="primary" size="md">
              Link my Google account
            </ButtonLink>
          ) : null
        }
      />

      {params.linked ? (
        <div className="mb-6">
          <Alert tone="success" title={`${params.linked} is linked to your login`}>
            Changes it makes to monitored spreadsheets in Google can now be credited to you.
          </Alert>
        </div>
      ) : null}
      {params.google_error ? (
        <div className="mb-6">
          <Alert tone="danger" title="Not linked">
            {ERRORS[params.google_error] ?? ERRORS.failed}
          </Alert>
        </div>
      ) : null}

      <Card className="mb-6">
        <SectionHeader title="Linked Google accounts" description="Only you can link or unlink these, and only by signing in with the account itself." />
        <IdentityList identities={identities.map((i) => ({ id: i.id, email: i.email, displayName: i.displayName, verifiedAt: i.verifiedAt.toISOString() }))} />
      </Card>

      <Card>
        <SectionHeader title="How it is used" />
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          <li>
            <strong className="text-[color:var(--color-foreground)]">Work done in this app</strong> is always credited to you, the signed-in person — this link is not needed
            for it.
          </li>
          <li>
            <strong className="text-[color:var(--color-foreground)]">Changes made in Google Sheets directly</strong> are reported by Google with the Google account that made
            them. Linking yours is what lets such a change be credited to you; without it, it is listed as unattributed.
          </li>
          <li>Google tells the app when a change was made, never which cells and never for how long, so those changes count as edits — never as work time.</li>
          <li>Signing in here asks Google only for your account&apos;s id and email. Nothing is kept that could open your Drive, and the app never acts as you.</li>
          <li>
            Your login is {teamMember ? <>linked to the team member <strong className="text-[color:var(--color-foreground)]">{teamMember.name}</strong></> : "not linked to a team member"}{" "}
            (set on Team Members by a manager); reports show your work under that name.
          </li>
        </ul>
      </Card>
    </div>
  );
}
