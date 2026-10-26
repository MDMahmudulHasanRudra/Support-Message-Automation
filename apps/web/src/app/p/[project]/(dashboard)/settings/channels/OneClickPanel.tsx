import { CheckCircle2 } from "lucide-react";
import { ButtonLink, Card } from "@/components/ui";
import { ChannelMark } from "../../conversations/ChannelMark";

/**
 * "Connect with Facebook" on Settings → Messaging Channels (docs/meta-integration). The customer signs
 * in at Facebook, picks their Pages, and comes back — no Meta app, App ID, App Secret or token on their
 * side. When the platform has not set it up, ordinary people see one plain sentence; a Main Admin also
 * sees which server settings are missing (names only, never a value).
 */
export function OneClickPanel({ available, canManage, problems }: { available: boolean; canManage: boolean; problems: string[] | null }) {
  if (!available) {
    return (
      <Card className="!p-4">
        <p className="text-[13.5px] font-medium text-[color:var(--color-foreground)]">Connect with Facebook</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          One-click connection is not switched on for this server yet. You can still connect a Page or Instagram account with your own Meta app below.
        </p>
        {problems && problems.length > 0 ? (
          <details className="mt-2 text-[12px] text-[color:var(--color-muted-foreground)]">
            <summary className="cursor-pointer">For the platform administrator: what is missing</summary>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p className="mt-1.5">See docs/meta-integration/META_DEVELOPER_SETUP.md.</p>
          </details>
        ) : null}
      </Card>
    );
  }
  return (
    <Card className="!p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-[color:var(--color-foreground)]">Connect with Facebook</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Sign in at Facebook, choose your Pages and Instagram accounts, and come back. No Meta app, App ID or access token needed.
          </p>
          <ul className="mt-2 space-y-0.5 text-[12px] text-[color:var(--color-muted-foreground)]">
            <li className="flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 text-[color:var(--color-success)]" aria-hidden />
              You choose exactly which Pages to connect, on Facebook and again here.
            </li>
            <li className="flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 text-[color:var(--color-success)]" aria-hidden />
              Only messaging access is asked for — no posts, ads or payments.
            </li>
          </ul>
        </div>
        {canManage ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            <ButtonLink href="/api/meta/connect?type=MESSENGER" variant="primary" size="md">
              <ChannelMark channel="MESSENGER" size="sm" />
              Connect Facebook Page
            </ButtonLink>
            <ButtonLink href="/api/meta/connect?type=INSTAGRAM" variant="secondary" size="md">
              <ChannelMark channel="INSTAGRAM" size="sm" />
              Connect Instagram
            </ButtonLink>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
