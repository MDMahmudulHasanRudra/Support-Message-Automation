import { ArrowLeft } from "lucide-react";
import Link from "@/components/ProjectLink";
import { Alert, Badge, ButtonLink, Card, PageHeader } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { getSession } from "@/server/auth";
import { loadCompletedMetaSession, loadMetaChoice, MetaOAuthError, type MetaChoice } from "@/server/channels/metaOAuth";
import { MetaChoiceForm } from "./MetaChoiceForm";

export const metadata = { title: "Choose Facebook Pages" };

/**
 * Back from Facebook: the Pages and Instagram accounts the person chose there, each with whether it can
 * be connected (docs/meta-integration/03). Opens only for the person who started the connection, after
 * the claim step, within 30 minutes. Nothing is connected until they confirm here.
 */
export default async function MetaChoicePage({ params }: { params: Promise<{ sessionId: string }> }) {
  await requireAccess("channels.manage", "OMNICHANNEL");
  const session = await getSession();
  const { sessionId } = await params;
  let choice: MetaChoice | null = null;
  let error: string | null = null;
  try {
    choice = await loadMetaChoice({ sessionId, userId: session!.userId });
  } catch (err) {
    if (!(err instanceof MetaOAuthError)) throw err;
    error = err.message;
  }
  const done = choice ? null : await loadCompletedMetaSession({ sessionId, userId: session!.userId });
  if (done) {
    return (
      <div>
        <PageHeader title="Facebook connection finished" description="This connection attempt is complete. What it connected:" />
        <Card>
          {done.connections.length === 0 ? (
            <p className="text-[13px] text-[color:var(--color-muted-foreground)]">Nothing was connected.</p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {done.connections.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                  <Link href={`/settings/channels/${c.id}`} className="link">
                    {c.name}
                  </Link>
                  <Badge color={c.status === "CONNECTED" ? "green" : "yellow"}>{c.status === "CONNECTED" ? "Connected" : c.status.toLowerCase().replace("_", " ")}</Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4">
            <ButtonLink href="/settings/channels" variant="secondary">
              Back to Messaging Channels
            </ButtonLink>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <Link href="/settings/channels" className="mb-3 inline-flex items-center gap-1 text-[12.5px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
        <ArrowLeft className="size-3.5" aria-hidden />
        Messaging Channels
      </Link>
      <PageHeader
        title="Choose what to connect"
        description={
          choice
            ? `Signed in at Facebook${choice.metaUserName ? ` as ${choice.metaUserName}` : ""}. These are the Pages you allowed. Tick the ones whose messages should come here.`
            : "Connect with Facebook"
        }
      />
      {error || !choice ? (
        <Alert tone="warning" title="This Facebook connection cannot continue" actions={<ButtonLink href="/settings/channels" size="sm">Back to Messaging Channels</ButtonLink>}>
          {error}
        </Alert>
      ) : (
        <Card>
          <MetaChoiceForm
            sessionId={choice.sessionId}
            assets={choice.assets}
            preferred={choice.channelType}
            reconnectId={choice.reconnectConnectionId}
            declinedScopes={choice.declinedScopes}
            truncated={choice.truncated}
            expiresAt={choice.expiresAt.toISOString()}
          />
        </Card>
      )}
    </div>
  );
}
