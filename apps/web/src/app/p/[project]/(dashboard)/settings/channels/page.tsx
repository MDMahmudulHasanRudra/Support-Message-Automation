import { ArrowRight, PlugZap } from "lucide-react";
import { CHANNEL_TYPES, CHANNELS, UNAVAILABLE_CHANNELS } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { Alert, Badge, ButtonLink, Card, PageHeader, SectionHeader, ViewOnlyNotice } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { META_ERROR_TEXT, metaAllowedForProject, metaPlatformConfig, type MetaOAuthErrorCode } from "@/server/channels/metaOAuth";
import { activeProjectId } from "@/server/projectContext";
import { listChannelConnections } from "@/server/channels/connections";
import { ChannelMark } from "../../conversations/ChannelMark";
import { ConnectionStatusBadge } from "./ConnectionStatusBadge";
import { OneClickPanel } from "./OneClickPanel";

export const metadata = { title: "Messaging Channels" };

/**
 * Settings → Messaging Channels (OMNICHANNEL.md §11): every connected Messenger Page, Instagram account
 * and Telegram bot, and what can be connected. WhatsApp numbers are managed where they always were
 * (WhatsApp Accounts) and linked from here. No credential is ever sent to this page.
 */
export default async function ChannelsPage({ searchParams }: { searchParams: Promise<{ meta_error?: string }> }) {
  const { session, canManage } = await pageAccess("channels.view", "channels.manage", "OMNICHANNEL");
  const [connections, query] = await Promise.all([listChannelConnections(), searchParams]);
  const config = metaPlatformConfig();
  // One-click needs the server configured AND this workspace on META_ALLOWED_PROJECT_IDS (fails closed).
  const allowed = metaAllowedForProject(await activeProjectId());
  const oneClick = { ok: config.ok && allowed, problems: config.ok ? (allowed ? [] : ["This workspace is not on META_ALLOWED_PROJECT_IDS."]) : config.problems };
  // What is missing on the server is the platform administrator's business; only a Main Admin sees it.
  const problems = !oneClick.ok && (await hasPermission(session, "projects.manage")) ? oneClick.problems : null;
  const metaError = query.meta_error && query.meta_error in META_ERROR_TEXT ? META_ERROR_TEXT[query.meta_error as MetaOAuthErrorCode] : null;

  return (
    <div>
      <PageHeader
        title="Messaging Channels"
        description="Connect Facebook Messenger, Instagram DM and Telegram so their conversations land in All Conversations beside WhatsApp, answered by the same team and, if you switch it on, the same AI."
      />
      {canManage ? null : (
        <div className="mb-6">
          <ViewOnlyNotice />
        </div>
      )}

      {metaError ? (
        <div className="mb-6">
          <Alert tone="warning" title="Facebook connection not completed">
            {metaError}
          </Alert>
        </div>
      ) : null}

      <div className="space-y-8">
        <OneClickPanel available={oneClick.ok} canManage={canManage} problems={problems} />

        {CHANNEL_TYPES.map((type) => {
          const def = CHANNELS[type];
          const rows = connections.filter((c) => c.type === type);
          return (
            <section key={type}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <ChannelMark channel={type} size="md" />
                  <div>
                    <h2 className="text-[15px] font-semibold text-[color:var(--color-foreground)]">{def.label}</h2>
                    <p className="text-[12px] text-[color:var(--color-muted-foreground)]">{def.accountNoun}</p>
                  </div>
                </div>
                {canManage ? (
                  <ButtonLink href={`/settings/channels/new?type=${type}`} variant="secondary" size="sm">
                    <PlugZap className="size-3.5" aria-hidden />
                    {def.webhookKind === "META" && oneClick.ok ? "Connect with your own Meta app" : `Connect ${rows.length ? "another" : def.label}`}
                  </ButtonLink>
                ) : null}
              </div>
              {rows.length === 0 ? (
                <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] px-4 py-5 text-[13px] text-[color:var(--color-muted-foreground)]">Not connected.</p>
              ) : (
                <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
                  {rows.map((c) => (
                    <li key={c.id}>
                      <Link href={`/settings/channels/${c.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-neutral-bg)]/60">
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[13.5px] font-medium text-[color:var(--color-foreground)]">{c.name}</span>
                            <ConnectionStatusBadge connection={c} />
                            {c.aiAutomationEnabled ? <Badge color="blue">AI on</Badge> : null}
                            {c.authMode === "PLATFORM" ? <Badge color="gray">Connected with Facebook</Badge> : null}
                          </span>
                          <span className="mt-0.5 block truncate text-[12px] text-[color:var(--color-muted-foreground)]">
                            {c.externalAccountName ?? "—"} · {c.conversationCount} conversation{c.conversationCount === 1 ? "" : "s"}
                            {c.lastError ? ` · ${c.lastError}` : ""}
                          </span>
                        </span>
                        <ArrowRight className="size-4 shrink-0 text-[color:var(--color-subtle-foreground)]" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}

        <section>
          <SectionHeader title="Also" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Card className="!p-4">
              <div className="flex items-center gap-2.5">
                <ChannelMark channel="WHATSAPP" size="md" />
                <div className="min-w-0">
                  <p className="text-[13.5px] font-medium text-[color:var(--color-foreground)]">WhatsApp</p>
                  <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
                    Numbers are linked on{" "}
                    <Link href="/accounts" className="link">
                      WhatsApp Accounts
                    </Link>
                    , exactly as before. Their chats appear in All Conversations too.
                  </p>
                </div>
              </div>
            </Card>
            {UNAVAILABLE_CHANNELS.map((c) => (
              <Card key={c.key} className="!p-4">
                <div className="flex items-center gap-2">
                  <p className="text-[13.5px] font-medium text-[color:var(--color-foreground)]">{c.label}</p>
                  <Badge color="gray">Not available</Badge>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-[color:var(--color-muted-foreground)]">{c.reason}</p>
              </Card>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
