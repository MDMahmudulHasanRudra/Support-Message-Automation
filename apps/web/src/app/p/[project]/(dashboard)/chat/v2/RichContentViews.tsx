"use client";

import { BarChart3, Check, CheckCheck, ExternalLink, Forward, MapPin, Trash2 } from "lucide-react";
import { describeReceipt, describeRevoked, locationMapUrl, type RichContent } from "@support-automation/shared";
import { useProjectHref } from "@/components/ProjectLink";

/**
 * Chat v2 rich messaging (CHAT_RICH_MESSAGING.md): how a poll, a location, a sticker waiting to be
 * sent, a forward, a deleted message and a receipt look in the thread. Presentation only — every fact
 * shown here is one WhatsApp reported and the server stored.
 */

/** The ticks on a message this account sent: one = sent, two = delivered, blue = read. */
export function ReceiptTicks({ ackLevel, isGroup }: { ackLevel: number | null | undefined; isGroup: boolean }) {
  const receipt = describeReceipt(ackLevel ?? null, isGroup);
  const Icon = receipt.ticks === 2 ? CheckCheck : Check;
  return (
    <span className="inline-flex items-center" title={receipt.label}>
      {/* Blue is WhatsApp's own "read"; it is a state, so the info token rather than the brand accent. */}
      <Icon className={`size-3.5 ${receipt.read ? "text-[color:var(--color-info)]" : ""}`} aria-hidden />
      <span className="sr-only">{receipt.label}</span>
    </span>
  );
}

export function RevokedNotice({ outgoing }: { outgoing: boolean }) {
  return (
    <p className="mb-1 flex items-start gap-1.5 text-[11.5px] italic leading-snug text-[color:var(--color-muted-foreground)]">
      <Trash2 className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span>{describeRevoked(outgoing)}</span>
    </p>
  );
}

export function ForwardedLabel() {
  return (
    <p className="mb-0.5 flex items-center gap-1 text-[11px] italic text-[color:var(--color-muted-foreground)]">
      <Forward className="size-3" aria-hidden />
      Forwarded
    </p>
  );
}

/** A poll or a location, as a card inside the bubble. */
export function RichContentCard({ rich }: { rich: RichContent }) {
  if (rich.kind === "LOCATION") {
    const href = locationMapUrl(rich.latitude, rich.longitude);
    return (
      <div className="min-w-[13rem] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
        <p className="flex items-start gap-2 text-[13px] font-medium">
          <MapPin className="mt-0.5 size-4 shrink-0 text-[color:var(--color-danger)]" aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]" dir="auto">
            {rich.name || "Shared location"}
          </span>
        </p>
        <p className="mt-0.5 pl-6 text-[11px] tabular text-[color:var(--color-muted-foreground)]">
          {rich.latitude}, {rich.longitude}
        </p>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 rounded-[var(--radius-sm)] pl-6 text-[12px] font-medium text-[color:var(--color-accent-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
        >
          Open in Maps
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>
    );
  }
  return (
    <div className="min-w-[13rem] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
      <p className="flex items-start gap-2 text-[13px] font-semibold">
        <BarChart3 className="mt-0.5 size-4 shrink-0 text-[color:var(--color-accent)]" aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]" dir="auto">
          {rich.name || "Poll"}
        </span>
      </p>
      {rich.options.length ? (
        <ul className="mt-2 space-y-1 pl-6">
          {rich.options.map((option, i) => (
            <li key={`${i}-${option}`} className="flex items-center gap-2 text-[12.5px]" dir="auto">
              <span className={`size-3 shrink-0 border border-[var(--color-border-strong)] ${rich.allowMultiple ? "rounded-[3px]" : "rounded-full"}`} aria-hidden />
              <span className="min-w-0 [overflow-wrap:anywhere]">{option}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {/* Votes arrive on the phone; this connection does not collect them, so none are invented. */}
      <p className="mt-2 pl-6 text-[10.5px] text-[color:var(--color-muted-foreground)]">
        {rich.allowMultiple ? "More than one answer allowed · " : ""}Votes are counted on WhatsApp
      </p>
    </div>
  );
}

/** A sticker waiting in the queue, shown from the stored file it will send. */
export function QueuedSticker({ mediaId }: { mediaId: string }) {
  const toProject = useProjectHref();
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a project-scoped media endpoint, not a static asset
    <img src={toProject(`/api/whatsapp/media/${encodeURIComponent(mediaId)}`)} alt="Sticker" className="size-28 object-contain" loading="lazy" />
  );
}
