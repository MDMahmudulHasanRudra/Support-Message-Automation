"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, ExternalLink, Play, Send, SkipForward, Undo2 } from "lucide-react";
import { CAMPAIGN_CHANNEL_KIND, campaignOpenLink, CONTACT_CAMPAIGN_CHANNEL_LABEL } from "@support-automation/shared";
import { Alert, Badge, Button, Card, StatTile, useToast } from "@/components/ui";
import Link, { useProjectRouter } from "@/components/ProjectLink";
import { ContactAvatar, CopyButton } from "@/components/contacts/contactDisplay";
import { deleteContactCampaign, finishContactCampaign, markCampaignRecipient, sendCampaignRecipientInChat, startContactCampaign } from "@/server/actions/contacts";
import type { CampaignDetail } from "@/server/contacts";

type Tab = "PENDING" | "DONE" | "SKIPPED";

/** A campaign: for email, the start button and the tally; for every other channel, the next person and their message. */
export function CampaignRun({ campaign, emailBlocked }: { campaign: CampaignDetail; emailBlocked: string | null }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("PENDING");
  const isEmail = campaign.channel === "EMAIL";

  const waiting = useMemo(() => campaign.recipients.filter((r) => r.status === "PENDING"), [campaign.recipients]);
  const shown = campaign.recipients.filter((r) => (tab === "PENDING" ? r.status === "PENDING" || r.status === "QUEUED" : r.status === tab));
  const next = campaign.status === "RUNNING" && !isEmail ? waiting[0] : undefined;
  const reachable = campaign.counts.pending + campaign.counts.queued + campaign.counts.done;

  const act = (work: () => Promise<{ error: string } | object>, message?: string) =>
    start(async () => {
      const r = await work();
      if ("error" in r) {
        setError(r.error as string);
        return;
      }
      setError(null);
      if (message) showToast({ tone: "success", title: message });
      router.refresh();
    });

  const n = (v: number) => v.toLocaleString("en-US");
  const TABS: Array<[Tab, string, number]> = [
    ["PENDING", "Waiting", campaign.counts.pending + campaign.counts.queued],
    ["DONE", isEmail ? "Sent" : "Done", campaign.counts.done],
    ["SKIPPED", "Left out", campaign.counts.skipped],
  ];
  const link = next ? campaignOpenLink(campaign.channel, next.toValue ?? "", next.message) : null;
  const hasValue = Boolean(next?.toValue);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Waiting" value={n(campaign.counts.pending + campaign.counts.queued)} />
        <StatTile label={isEmail ? "Sent" : "Done"} value={n(campaign.counts.done)} tone="success" />
        <StatTile label="Left out" value={n(campaign.counts.skipped)} />
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {campaign.status === "DRAFT" ? (
        <Card className="p-4">
          <p className="text-[14px] font-semibold">Ready to start</p>
          <p className="mt-0.5 text-[13px] text-[color:var(--color-muted-foreground)]">
            {isEmail ? `${n(reachable)} emails will go out through your mail server, at the pace set in Settings → Email.` : `${n(reachable)} people will be listed here one at a time. You press send for each.`}
          </p>
          {emailBlocked ? (
            <Alert tone="warning">
              {emailBlocked}{" "}
              <Link href="/settings/email" className="underline">
                Open Email settings
              </Link>
            </Alert>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button
              disabled={pending || Boolean(emailBlocked)}
              onClick={() => {
                if (isEmail && !window.confirm(`Send this email to ${n(reachable)} people?`)) return;
                act(() => startContactCampaign(campaign.id), isEmail ? "Sending started" : "Started");
              }}
            >
              <Play className="size-4" aria-hidden />
              Start
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await deleteContactCampaign(campaign.id);
                  if ("error" in r) setError(r.error);
                  else router.push("/contacts/campaigns");
                })
              }
            >
              Delete
            </Button>
          </div>
        </Card>
      ) : null}

      {next ? (
        <Card className="p-4 sm:p-5">
          <p className="text-[12px] font-medium text-[color:var(--color-muted-foreground)]">Next person · {n(waiting.length)} waiting</p>
          <div className="mt-2 flex items-center gap-3">
            <ContactAvatar name={next.contactName} />
            <div className="min-w-0 flex-1">
              <Link href={`/contacts/${next.contactId}`} className="block truncate text-[15px] font-semibold hover:underline">
                {next.contactName}
              </Link>
              <p className="truncate text-[13px] text-[color:var(--color-muted-foreground)]">{next.toValue ?? `Has a chat, no ${CAMPAIGN_CHANNEL_KIND[campaign.channel].toLowerCase()} saved`}</p>
            </div>
          </div>
          <div className="mt-3 flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2.5">
            <p className="min-w-0 flex-1 whitespace-pre-wrap text-[13.5px]">{next.message}</p>
            <CopyButton value={next.message} label="message" />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {next.inChat && campaign.channel !== "CALL" && campaign.channel !== "SMS" ? (
              <Button disabled={pending} onClick={() => act(() => sendCampaignRecipientInChat(next.id), "Sent")}>
                <Send className="size-4" aria-hidden />
                Send in their chat
              </Button>
            ) : null}
            {link && hasValue ? (
              <a href={link} target={link.startsWith("https") ? "_blank" : undefined} rel="noopener noreferrer nofollow" className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] font-medium hover:bg-[var(--color-neutral-bg)]">
                <ExternalLink className="size-4" aria-hidden />
                {campaign.channel === "CALL" ? "Call" : `Open in ${CONTACT_CAMPAIGN_CHANNEL_LABEL[campaign.channel]}`}
              </a>
            ) : null}
            <Button variant="secondary" disabled={pending} onClick={() => act(() => markCampaignRecipient(next.id, "DONE"))}>
              <Check className="size-4" aria-hidden />
              {campaign.channel === "CALL" ? "Called" : "Mark done"}
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => act(() => markCampaignRecipient(next.id, "SKIPPED"))}>
              <SkipForward className="size-4" aria-hidden />
              Skip
            </Button>
          </div>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-2">
          {TABS.map(([key, label, count]) => (
            <button key={key} type="button" onClick={() => setTab(key)} aria-pressed={tab === key} className={`rounded-full px-3 py-1 text-[12.5px] font-medium ${tab === key ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"}`}>
              {label} <span className="tabular opacity-80">{n(count)}</span>
            </button>
          ))}
          <span className="flex-1" />
          {campaign.status === "RUNNING" && !isEmail ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => finishContactCampaign(campaign.id), "Finished")}>
              Finish
            </Button>
          ) : null}
        </div>
        {shown.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-[color:var(--color-muted-foreground)]">Nobody here.</p>
        ) : (
          <ul className="max-h-[32rem] divide-y divide-[var(--color-border)] overflow-y-auto">
            {shown.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                <div className="min-w-0 flex-1">
                  <Link href={`/contacts/${r.contactId}`} className="block truncate font-medium hover:underline">
                    {r.contactName} <span className="tabular font-normal text-[color:var(--color-muted-foreground)]">{r.contactLabel}</span>
                  </Link>
                  <p className="truncate text-[12.5px] text-[color:var(--color-muted-foreground)]">{r.skipReason ?? r.toValue ?? "In their chat"}</p>
                </div>
                {r.status === "QUEUED" ? <Badge color="blue">Sending</Badge> : null}
                {r.doneByName ? <span className="shrink-0 text-[12.5px] text-[color:var(--color-muted-foreground)]">{r.doneByName}</span> : null}
                {!isEmail && campaign.status === "RUNNING" && (r.status === "DONE" || r.status === "SKIPPED") ? (
                  <button type="button" disabled={pending} aria-label={`Put ${r.contactName} back on the list`} title="Put back on the list" onClick={() => act(() => markCampaignRecipient(r.id, "PENDING"))} className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]">
                    <Undo2 className="size-3.5" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <p className="mb-1 text-[12px] font-medium text-[color:var(--color-muted-foreground)]">The message</p>
        {campaign.subject ? <p className="mb-1 text-[13.5px] font-semibold">{campaign.subject}</p> : null}
        <p className="whitespace-pre-wrap text-[13.5px]">{campaign.body}</p>
      </Card>
    </div>
  );
}
