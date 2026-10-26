import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { CHANNELS } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { Alert, ButtonLink, Card, PageHeader, SectionHeader, ViewOnlyNotice } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { getChannelConnection } from "@/server/channels/connections";
import { metaPlatformConfig } from "@/server/channels/metaOAuth";
import { ChannelMark } from "../../../conversations/ChannelMark";
import { ConnectionStatusBadge } from "../ConnectionStatusBadge";
import { SetupGuide } from "../SetupGuide";
import { ConnectChannelForm } from "../ConnectChannelForm";
import { ConnectionHealth, ConnectionSwitches, CopyValue, DisconnectConnection, RenameConnection } from "../ConnectionPanel";

export const metadata = { title: "Messaging channel" };

const when = (d: Date | null) => (d ? d.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

/**
 * One connection: its health, the switches, the webhook details to paste into the provider, new
 * credentials, and disconnect. The Meta verify token is revealed only to a role that can manage
 * channels, because pasting it into Meta's dashboard is a manager's job; no token or secret is ever
 * sent to this page.
 */
export default async function ChannelConnectionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ connected?: string; warning?: string }> }) {
  const { canManage } = await pageAccess("channels.view", "channels.manage", "OMNICHANNEL");
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const c = await getChannelConnection(id, { revealVerifyToken: canManage });
  if (!c) notFound();
  const def = CHANNELS[c.type];
  const disconnected = c.status === "DISCONNECTED";
  const meta = def.webhookKind === "META";
  // Connected with "Connect with Facebook": the platform's app, no webhook or secret for anyone to paste.
  const oneClick = c.authMode === "PLATFORM";
  const canOneClick = meta && metaPlatformConfig().ok;
  const reconnectHref = `/api/meta/connect?reconnect=${c.id}&type=${c.type}`;

  return (
    <div>
      <Link href="/settings/channels" className="mb-3 inline-flex items-center gap-1 text-[12.5px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
        <ArrowLeft className="size-3.5" aria-hidden />
        Messaging Channels
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            <ChannelMark channel={c.type} size="md" />
            {c.name}
            <ConnectionStatusBadge connection={c} />
          </span>
        }
        description={`${def.label} · ${c.externalAccountName ?? "—"}${c.externalUsername ? ` (@${c.externalUsername})` : ""}`}
        actions={
          !disconnected ? (
            <ButtonLink href={`/conversations/${def.slug}`} variant="secondary" size="sm">
              Open inbox
            </ButtonLink>
          ) : null
        }
      />
      {canManage ? null : (
        <div className="mb-6">
          <ViewOnlyNotice />
        </div>
      )}
      {query.connected ? (
        <div className="mb-6">
          <Alert tone="success" title={`${c.name} is connected`}>
            {oneClick ? "New messages will arrive in All Conversations." : meta ? "One step left: paste the Callback URL and Verify token below into your Meta app's Webhooks settings." : "Telegram will now send its messages here."}
          </Alert>
        </div>
      ) : null}
      {c.lastError && !disconnected ? (
        <div className="mb-6">
          <Alert
            tone={c.status === "NEEDS_RECONNECT" ? "danger" : "warning"}
            title={c.lastError}
            actions={
              oneClick && canManage && canOneClick ? (
                <ButtonLink href={reconnectHref} size="sm">
                  Reconnect with Facebook
                </ButtonLink>
              ) : undefined
            }
          />
        </div>
      ) : null}
      {disconnected ? (
        <div className="mb-6">
          <Alert tone="info" title="Disconnected">
            Its {c.conversationCount} conversation{c.conversationCount === 1 ? " is" : "s are"} kept and still readable. {canOneClick ? "Reconnect with Facebook, or enter your own app's credentials below." : "Enter the credentials again below to reconnect."}
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <SectionHeader title="Settings" />
            <ConnectionSwitches id={c.id} type={c.type} enabled={c.enabled} aiAutomationEnabled={c.aiAutomationEnabled} humanAgentEnabled={c.humanAgentEnabled} aiDisclosureEnabled={c.aiDisclosureEnabled} aiDisclosureText={c.aiDisclosureText} aiDisclosureIdleHours={c.aiDisclosureIdleHours} disconnected={disconnected} canManage={canManage} />
            <div className="mt-4 border-t border-[var(--color-border)] pt-4">
              <p className="mb-1.5 text-[12.5px] font-medium text-[color:var(--color-foreground)]">Name in this app</p>
              <RenameConnection id={c.id} name={c.name} canManage={canManage && !disconnected} />
            </div>
          </Card>

          {oneClick && !disconnected ? (
            <Card>
              <SectionHeader title="Connected with Facebook" description="Through the platform's Meta app. There is no webhook, App Secret or token for you to manage." />
              <div className="space-y-2 text-[12.5px] text-[color:var(--color-muted-foreground)]">
                <p>Permissions Facebook granted: {c.grantedScopes.length ? c.grantedScopes.join(", ") : "—"}.</p>
                <p>Last event received: {when(c.lastEventAt)}.</p>
                {canManage && canOneClick ? (
                  <div className="pt-1">
                    <ButtonLink href={reconnectHref} variant="secondary" size="sm">
                      Reconnect with Facebook
                    </ButtonLink>
                    <p className="mt-1.5">Use this after a Page admin changes, a password changes, or Facebook asks for permissions again. Conversations are kept.</p>
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}

          {!disconnected && !oneClick ? (
            <Card>
              <SectionHeader title="Webhook" description={meta ? "Paste these into your Meta app: Webhooks (Messenger or Instagram product) → Callback URL and Verify token." : "Registered with Telegram automatically. Shown for reference."} />
              <div className="space-y-3">
                <CopyValue label="Callback URL" value={c.webhookUrl} />
                {meta && canManage ? <CopyValue label="Verify token" value={c.verifyToken ?? null} secret /> : null}
                <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
                  {c.webhookVerifiedAt ? `${meta ? "Meta verified this address" : "Registered with Telegram"} ${when(c.webhookVerifiedAt)}.` : meta ? "Meta has not verified this address yet." : "Not registered with Telegram yet — save the token again below."}{" "}
                  Last event received: {when(c.lastEventAt)}.
                </p>
              </div>
            </Card>
          ) : null}

          {!disconnected ? (
            <Card>
              <SectionHeader title="Health" description="Asks the provider whether the credentials, subscription and webhook still work." />
              <ConnectionHealth id={c.id} canManage={canManage} />
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          {canManage && disconnected && canOneClick ? (
            <Card>
              <SectionHeader title="Reconnect with Facebook" description="Sign in at Facebook and choose this account again. Its conversations come back with it." />
              <ButtonLink href={reconnectHref} size="md">
                Reconnect with Facebook
              </ButtonLink>
            </Card>
          ) : null}
          {canManage ? (
            <Card>
              <SectionHeader
                title={oneClick && !disconnected ? "Use your own Meta app instead" : disconnected ? (canOneClick ? "Or reconnect with your own Meta app" : "Reconnect") : meta ? "Replace credentials" : "Bot token"}
                description={
                  oneClick && !disconnected
                    ? "Only if you run your own Meta app: entering its App ID, App Secret and a Page token switches this connection off one-click. You will then have to set up its webhook yourself."
                    : meta
                      ? "Rotated the App Secret or generated a new Page token? Enter all three again. They must be for the same account."
                      : "Revoked the token in BotFather? Paste the new one. It must be the same bot."
                }
              />
              <ConnectChannelForm type={c.type} connectionId={c.id} />
            </Card>
          ) : null}
          {oneClick ? null : (
            <Card>
              <SectionHeader title="Setup steps" />
              <SetupGuide type={c.type} />
            </Card>
          )}
          <Card>
            <SectionHeader title="Record" />
            <dl className="space-y-1 text-[12.5px] text-[color:var(--color-muted-foreground)]">
              <div>Connected by {c.createdByUsername ?? "—"} · {when(c.createdAt)}</div>
              <div>Credentials last saved by {c.credentialsUpdatedByUsername ?? "—"} · {when(c.credentialsUpdatedAt)}</div>
              <div>Last checked: {when(c.lastCheckedAt)}</div>
              {c.disconnectedAt ? <div>Disconnected: {when(c.disconnectedAt)}</div> : null}
            </dl>
            {!disconnected ? (
              <div className="mt-4 border-t border-[var(--color-border)] pt-4">
                <DisconnectConnection id={c.id} name={c.name} canManage={canManage} />
              </div>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  );
}
