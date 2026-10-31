import { Share2 } from "lucide-react";
import { SOCIAL_CAPABILITY_LABELS, SOCIAL_PLATFORMS } from "@support-automation/shared";
import { Alert, Badge, ButtonLink, Card, EmptyState, PageHeader, SectionHeader, Table, Td, Th } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { activeProjectId } from "@/server/projectContext";
import { listSocialAccounts, listSocialConnections } from "@/server/social/accounts";
import { socialMetaReadiness } from "@/server/social/metaConnect";
import { formatInZone, platformLabel } from "../socialUi";
import { AccountSwitch, ConnectionControls } from "./AccountControls";

export const metadata = { title: "Social accounts" };

const ERRORS: Record<string, string> = {
  permission: "You do not have permission to connect accounts here.",
  not_configured: "Meta publishing is not set up on this server yet. See Settings → Social Publishing.",
  expired: "The connection attempt expired. Start again.",
  state: "The answer from Meta did not match this attempt. Start again.",
  denied: "The connection was cancelled at Meta.",
  session: "Sign in as the same person who started connecting, then try again.",
  meta: "Meta did not complete the connection. Try again; the System Log has the details.",
  failed: "Connecting failed. Try again; the System Log has the details.",
};

/**
 * Where Social Studio accounts are connected and looked after (SOCIAL_STUDIO.md §Accounts). Separate from
 * Messaging Channels: a Page connected for Messenger is NOT thereby connected for publishing, and the
 * reverse — publishing needs its own permissions.
 */
export default async function SocialAccountsPage({ searchParams }: { searchParams: Promise<{ social_error?: string; connected?: string; attention?: string }> }) {
  const { canManage } = await pageAccess("social.view", "social.manage", "SOCIAL_STUDIO");
  const sp = await searchParams;
  const [connections, accounts, projectId] = await Promise.all([listSocialConnections(), listSocialAccounts(), activeProjectId()]);
  const ready = socialMetaReadiness(projectId);
  const tz = process.env.SOCIAL_DEFAULT_TIMEZONE?.trim() || "Asia/Dhaka";

  return (
    <div>
      <PageHeader
        title="Accounts"
        description="The Facebook Pages and Instagram professional accounts this project publishes to. Connecting here is separate from Messenger and Instagram DM: publishing needs its own permissions."
        actions={
          canManage && ready.ok ? (
            <ButtonLink href="/api/social/meta/connect" variant="primary" size="md">
              <Share2 className="size-4" aria-hidden /> Connect Facebook / Instagram
            </ButtonLink>
          ) : null
        }
      />
      {sp.social_error ? <Alert tone="danger" title={ERRORS[sp.social_error] ?? "Connecting failed."} /> : null}
      {sp.connected ? <Alert tone="success" title={`Connected: ${sp.connected} account(s) ready${Number(sp.attention) ? `, ${sp.attention} need attention (see below)` : ""}.`} /> : null}
      {canManage && !ready.ok ? (
        <Alert tone="warning" title="Meta publishing is not available in this workspace yet.">
          <ul className="list-disc pl-5 text-sm">
            {ready.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <section className="mb-8 mt-4">
        <SectionHeader title="Accounts" />
        {accounts.length === 0 ? (
          <Card>
            <EmptyState icon={<Share2 className="size-5" aria-hidden />}>No account is connected yet.</EmptyState>
          </Card>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th>Status</Th>
                <Th>Can do</Th>
                <Th>Published (30 days)</Th>
                <Th>Publishing</Th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <Td>
                    <p className="font-medium">{a.name}</p>
                    <p className="text-xs text-[color:var(--color-muted-foreground)]">
                      {platformLabel(a.platform)}
                      {a.username ? ` · @${a.username}` : ""} · connected by {a.connectedBy}
                    </p>
                  </Td>
                  <Td>
                    {a.status === "ACTIVE" ? <Badge color="green">Ready</Badge> : <Badge color="yellow">Needs attention</Badge>}
                    {a.lastError ? <p className="mt-1 max-w-xs text-xs text-[color:var(--color-muted-foreground)]">{a.lastError}</p> : null}
                  </Td>
                  <Td className="text-xs">{a.platform in SOCIAL_PLATFORMS ? SOCIAL_PLATFORMS[a.platform as keyof typeof SOCIAL_PLATFORMS].capabilities.map((c) => SOCIAL_CAPABILITY_LABELS[c]).join(", ") : "—"}</Td>
                  <Td className="tabular">{a.publishedLast30d}</Td>
                  <Td>{canManage ? <AccountSwitch accountId={a.id} enabled={a.enabled} disabled={a.status !== "ACTIVE"} /> : a.enabled ? "On" : "Off"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section className="mb-8">
        <SectionHeader title="Connections" description="Each is one person's authorization at Meta. Access can also be removed at Facebook → Settings → Business Integrations." />
        {connections.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">None.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {connections.map((c) => (
              <Card key={c.id} className="space-y-2 p-4 text-sm">
                <p className="font-medium">
                  {c.provider === "META" ? "Meta" : c.provider} · {c.externalUserName ?? "unknown person"}{" "}
                  {c.status === "CONNECTED" ? <Badge color="green">Connected</Badge> : <Badge color="yellow">{c.status.replace(/_/g, " ").toLowerCase()}</Badge>}
                </p>
                <p className="text-xs text-[color:var(--color-muted-foreground)]">
                  Connected by {c.connectedByUsername} · {c.accounts} account(s)
                  {c.tokenExpiresAt ? ` · authorization renews by ${formatInZone(c.tokenExpiresAt, tz)} (connect again before then)` : ""}
                  {c.lastCheckedAt ? ` · checked ${formatInZone(c.lastCheckedAt, tz)}` : ""}
                </p>
                {c.declinedScopes.length ? <p className="text-xs text-[color:var(--color-warning-fg)]">Declined at Meta: {c.declinedScopes.join(", ")}</p> : null}
                {c.lastError ? <p className="text-xs text-[color:var(--color-danger)]">{c.lastError}</p> : null}
                {canManage ? <ConnectionControls connectionId={c.id} /> : null}
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeader title="Other networks" description="Each needs its own developer approval and a Get Assist adapter. Not available yet." />
        <ul className="grid gap-2 text-sm md:grid-cols-2">
          {Object.values(SOCIAL_PLATFORMS)
            .filter((p) => !p.implemented)
            .map((p) => (
              <li key={p.key} className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
                <p className="font-medium">{p.label}</p>
                <p className="text-xs text-[color:var(--color-muted-foreground)]">{p.requirement}</p>
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}
