"use client";

import { useMemo, useState, useTransition } from "react";
import { CheckCircle2, CircleAlert, XCircle } from "lucide-react";
import type { AssetAvailability, ClassifiedAsset } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { Alert, Badge, Button, ButtonLink, Checkbox } from "@/components/ui";
import { cancelMetaChoiceAction, connectMetaAssetsAction } from "@/server/actions/channelConnections";
import type { MetaConnectOutcome } from "@/server/channels/metaOAuth";
import { ChannelMark } from "../../../../conversations/ChannelMark";

const AVAILABILITY: Record<AssetAvailability, { label: string; color: "green" | "blue" | "gray" | "yellow" | "red" }> = {
  AVAILABLE: { label: "Ready to connect", color: "green" },
  CONNECTED_HERE: { label: "Connected here — reconnect", color: "blue" },
  MANUAL_HERE: { label: "Connected with your own app — switch to one-click", color: "blue" },
  CONNECTED_ELSEWHERE: { label: "Connected in another workspace", color: "gray" },
  MISSING_PERMISSION: { label: "Missing permission", color: "yellow" },
  MISSING_PAGE_ROLE: { label: "Your Page role is not enough", color: "yellow" },
  NO_INSTAGRAM: { label: "No Instagram account linked", color: "gray" },
};

/**
 * The choice: every Page the person allowed, as Messenger and as Instagram, with its verdict. Only
 * connectable rows have a checkbox. Results are shown per account — CONNECTED only when Meta accepted
 * the subscription, so nobody believes messages will arrive when they will not.
 */
export function MetaChoiceForm(props: {
  sessionId: string;
  assets: ClassifiedAsset[];
  preferred: "MESSENGER" | "INSTAGRAM" | null;
  reconnectId: string | null;
  declinedScopes: string[];
  truncated: boolean;
  expiresAt: string;
}) {
  const initial = useMemo(() => {
    const selectable = props.assets.filter((a) => a.selectable);
    // A reconnect pre-ticks what is already here; otherwise the kind of channel the person asked for,
    // when there is exactly one such account.
    const already = selectable.filter((a) => a.availability === "CONNECTED_HERE" || a.availability === "MANUAL_HERE");
    if (props.reconnectId && already.length) return new Set(already.map((a) => a.key));
    const ofType = selectable.filter((a) => a.type === props.preferred && a.availability === "AVAILABLE");
    return new Set(ofType.length === 1 ? [ofType[0]!.key] : []);
  }, [props.assets, props.preferred, props.reconnectId]);
  const [picked, setPicked] = useState<Set<string>>(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<MetaConnectOutcome[] | null>(null);

  if (outcomes) {
    const ok = outcomes.filter((o) => o.outcome === "CONNECTED").length;
    return (
      <div className="space-y-4">
        <Alert tone={ok === outcomes.length ? "success" : ok > 0 ? "warning" : "danger"} title={`${ok} of ${outcomes.length} connected`}>
          {ok > 0 ? "New messages to the connected accounts will arrive in All Conversations. Messages from before now are not imported." : "Nothing was connected. The reasons are below."}
        </Alert>
        <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)]">
          {outcomes.map((o) => (
            <li key={o.key} className="flex items-start gap-3 px-4 py-3 text-[13px]">
              {o.outcome === "CONNECTED" ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[color:var(--color-success)]" aria-hidden />
              ) : o.outcome === "SUBSCRIPTION_FAILED" ? (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-[color:var(--color-warning)]" aria-hidden />
              ) : (
                <XCircle className="mt-0.5 size-4 shrink-0 text-[color:var(--color-danger)]" aria-hidden />
              )}
              <span className="min-w-0 flex-1">
                <span className="font-medium text-[color:var(--color-foreground)]">{o.name}</span>
                <span className="block text-[12.5px] text-[color:var(--color-muted-foreground)]">{o.message}</span>
              </span>
              {o.connectionId ? (
                <Link href={`/settings/channels/${o.connectionId}`} className="link shrink-0 text-[12.5px]">
                  Open
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
        <ButtonLink href="/settings/channels" variant="secondary">
          Back to Messaging Channels
        </ButtonLink>
      </div>
    );
  }

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const submit = () =>
    start(async () => {
      setError(null);
      const result = await connectMetaAssetsAction(props.sessionId, [...picked]);
      if (result.error) setError(result.error);
      else setOutcomes(result.outcomes ?? []);
    });

  const byPage = new Map<string, ClassifiedAsset[]>();
  for (const a of props.assets) byPage.set(a.pageId, [...(byPage.get(a.pageId) ?? []), a]);

  return (
    <div className="space-y-4">
      {props.declinedScopes.length > 0 ? (
        <Alert tone="warning" title="Some permissions were not granted">
          Facebook says these were declined: {props.declinedScopes.join(", ")}. Accounts that need them cannot be connected until you reconnect and allow them.
        </Alert>
      ) : null}
      {props.truncated ? <Alert tone="info" title="Only the first 500 Pages are listed">Choose fewer Pages on Facebook to see the rest.</Alert> : null}
      {props.assets.length === 0 ? (
        <Alert tone="warning" title="Facebook did not share any Page">
          On Facebook&apos;s screen, choose at least one Page (and its Instagram account) to connect, then start again.
        </Alert>
      ) : (
        <div className="space-y-3">
          {[...byPage.entries()].map(([pageId, rows]) => (
            <fieldset key={pageId} className="rounded-[var(--radius-lg)] border border-[var(--color-border)]">
              <legend className="sr-only">{rows[0]!.pageName}</legend>
              <p className="border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 py-2 text-[13px] font-medium text-[color:var(--color-foreground)]">{rows[0]!.pageName}</p>
              <ul className="divide-y divide-[var(--color-border)]">
                {rows.map((a) => {
                  const look = AVAILABILITY[a.availability];
                  const id = `asset-${a.key.replace(/[^A-Za-z0-9]/g, "-")}`;
                  return (
                    <li key={a.key} className="flex items-start gap-3 px-4 py-3">
                      <span className="mt-0.5 w-5 shrink-0">
                        {a.selectable ? <Checkbox id={id} checked={picked.has(a.key)} onChange={() => toggle(a.key)} disabled={pending} aria-label={`Connect ${a.accountName} (${a.type === "MESSENGER" ? "Messenger" : "Instagram"})`} /> : null}
                      </span>
                      <label htmlFor={a.selectable ? id : undefined} className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2 text-[13px]">
                          <ChannelMark channel={a.type} size="sm" />
                          <span className="font-medium text-[color:var(--color-foreground)]">{a.type === "MESSENGER" ? "Messenger" : a.username ? `Instagram @${a.username}` : "Instagram"}</span>
                          <Badge color={look.color}>{look.label}</Badge>
                        </span>
                        {a.reason ? <span className="mt-0.5 block text-[12.5px] text-[color:var(--color-muted-foreground)]">{a.reason}</span> : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          ))}
        </div>
      )}
      {error ? <Alert tone="danger" title={error} /> : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-4">
        <Button onClick={submit} disabled={pending || picked.size === 0}>
          {pending ? "Connecting…" : `Connect ${picked.size || ""} selected`.replace("  ", " ")}
        </Button>
        <form action={cancelMetaChoiceAction.bind(null, props.sessionId)}>
          <Button type="submit" variant="ghost" disabled={pending}>
            Cancel
          </Button>
        </form>
        <span className="text-[12px] text-[color:var(--color-muted-foreground)]">
          This choice stays open until {new Date(props.expiresAt).toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit" })}.
        </span>
      </div>
    </div>
  );
}
