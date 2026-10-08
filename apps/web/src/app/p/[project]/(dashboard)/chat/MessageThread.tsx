import { AlertTriangle, Bot, Check, Clock, ListChecks, Megaphone, Settings2, UserRound } from "lucide-react";
import type { OutboundSenderType } from "@support-automation/shared";
import { isMediaPlaceholderBody, mediaCaption } from "@support-automation/shared";
import type { ThreadEntry } from "@/server/chatInbox";
import { formatDateTime, formatTime } from "@/lib/date";
import { MediaNotArchived, MessageAttachment } from "./MessageAttachment";
import { MoodBadge } from "@/components/MoodBadge";

const dayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Dhaka",
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** Copy for each not-yet-settled outbound state, in the operator's terms rather than the enum's. */
const QUEUED_LABEL: Record<string, { text: string; tone: "wait" | "bad" }> = {
  PENDING: { text: "Queued — waiting for the worker", tone: "wait" },
  PROCESSING: { text: "Sending…", tone: "wait" },
  RATE_LIMITED: { text: "Held back by the account rate limit", tone: "bad" },
  FAILED: { text: "Failed to send", tone: "bad" },
  CANCELLED: { text: "Cancelled", tone: "bad" },
  SKIPPED: { text: "Not sent", tone: "bad" },
  SENT: { text: "Sent — waiting for WhatsApp to confirm", tone: "wait" },
};

/**
 * Automated authorship, in the operator's terms. A person's send is named instead (the software user
 * who pressed send), so it has no badge here.
 */
const AUTHOR_BADGE: Partial<Record<OutboundSenderType, { text: string; icon: typeof Bot }>> = {
  AI: { text: "AI", icon: Bot },
  RULE_AUTOMATION: { text: "Rule", icon: ListChecks },
  BROADCAST: { text: "Broadcast", icon: Megaphone },
  SYSTEM: { text: "Automated", icon: Settings2 },
};

/** Longer and the next message reads as a new thought rather than the same one continued. */
const RUN_GAP_MS = 5 * 60_000;

/** Whether `next` continues `current` — same speaker, same side, close in time. */
function continues(current: ThreadEntry, next: ThreadEntry): boolean {
  if (current.kind === "SYSTEM" || next.kind === "SYSTEM") return false;

  const currentOutbound = current.kind === "OUTGOING" || current.kind === "QUEUED";
  const nextOutbound = next.kind === "OUTGOING" || next.kind === "QUEUED";
  if (currentOutbound !== nextOutbound) return false;

  // Inbound runs also need the same person: a group has many speakers, and merging two of them
  // into one run would attribute somebody's message to whoever spoke above them.
  if (!nextOutbound && (current.senderPhone ?? null) !== (next.senderPhone ?? null)) return false;

  // Outbound runs need the same author — and, for people, the same person — so an AI reply never
  // merges into a person's, and Hasan's reply never appears under Rudra's name.
  if (nextOutbound && (current.authoredBy ?? null) !== (next.authoredBy ?? null)) return false;
  if (nextOutbound && (current.sentBy?.id ?? null) !== (next.sentBy?.id ?? null)) return false;

  return next.at.getTime() - current.at.getTime() <= RUN_GAP_MS;
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="my-4 flex items-center gap-3" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-[var(--color-border)]" aria-hidden />
      <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-0.5 text-[10px] font-medium text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <span className="h-px flex-1 bg-[var(--color-border)]" aria-hidden />
    </div>
  );
}

/**
 * The conversation itself. Incoming messages sit left, anything this account sent sits
 * right — the arrangement everyone already knows from WhatsApp, so nothing here needs
 * explaining.
 *
 * A "queued" bubble is a message written in this inbox that WhatsApp has not confirmed
 * yet. It is shown deliberately: the send is asynchronous (the web app only writes to the
 * outbound queue; the worker does the sending), so without it an operator would press
 * send and watch nothing happen for a couple of seconds.
 */
export function MessageThread({ entries, accountLabel }: { entries: ThreadEntry[]; accountLabel: string }) {
  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-12">
        <p className="max-w-sm text-center text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          No messages stored for this group yet. Anything sent or received from now on appears
          here.
        </p>
      </div>
    );
  }

  // Derived up front rather than tracked with a variable mutated inside the map: a render
  // pass must not depend on state left behind by the previous iteration.
  //
  // `startsRun` / `endsRun` are what turn a column of separate cards into a conversation.
  // Consecutive messages from one speaker are one thing said over several lines, and repeating
  // the name and full spacing between each of them is the difference between a thread that reads
  // and a list of receipts. A run breaks on a different speaker, a day boundary, or a gap long
  // enough that the next message is a new thought rather than a continuation.
  const rows = entries.map((entry, index) => {
    const previous = index === 0 ? null : entries[index - 1];
    const next = index === entries.length - 1 ? null : entries[index + 1];

    const day = dayFormat.format(entry.at);
    const previousDay = previous ? dayFormat.format(previous.at) : null;
    const showDivider = day !== previousDay;

    return {
      entry,
      day,
      showDivider,
      startsRun: showDivider || !previous || !continues(previous, entry),
      endsRun: !next || dayFormat.format(next.at) !== day || !continues(entry, next),
    };
  });

  return (
    <div className="flex flex-col gap-1 px-4 py-5 sm:px-6">
      {rows.map(({ entry, day, showDivider, startsRun, endsRun }) => {
        const isOutbound = entry.kind === "OUTGOING" || entry.kind === "QUEUED";
        const isSystem = entry.kind === "SYSTEM";
        const queued = entry.kind === "QUEUED" ? QUEUED_LABEL[entry.outboundStatus ?? ""] : undefined;
        // A file is drawn as itself; the provider's "[Image]" label beside it would say nothing, so
        // only a caption the person typed stays as text. A message that carried a file before media
        // storage existed has no attachment row, and says so instead of showing a bare label.
        const notArchived = !entry.media && entry.kind !== "QUEUED" && isMediaPlaceholderBody(entry.body);
        const hasFile = Boolean(entry.media) || notArchived;
        const text = hasFile ? mediaCaption(entry.body, entry.media?.type ?? null) : entry.body;

        return (
          <div key={entry.id} className={startsRun && !showDivider ? "mt-2.5" : undefined}>
            {showDivider ? <DayDivider label={day} /> : null}

            {isSystem ? (
              <p className="my-1 text-center text-[11px] italic text-[color:var(--color-subtle-foreground)]">
                {entry.body}
              </p>
            ) : (
              <div className={`group/bubble flex ${isOutbound ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[min(38rem,80%)] ${isOutbound ? "items-end" : "items-start"} flex flex-col`}>
                  {/* Named once per run, not once per message. */}
                  {!isOutbound && startsRun ? (
                    <span className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-medium text-[color:var(--color-muted-foreground)]">
                      {entry.isTeamMember ? (
                        <UserRound className="size-3" aria-hidden />
                      ) : null}
                      {entry.senderName ?? entry.senderPhone}
                    </span>
                  ) : null}

                  {/* The tail. Three corners stay soft and the one nearest the speaker tightens
                      on the last bubble of a run — the shape every chat client uses to say "this
                      side said this", carried by geometry rather than another label. Mid-run
                      bubbles keep both inner corners tight so a run reads as one block. */}
                  <div
                    className={`${hasFile ? "p-1.5" : "px-3.5 py-2"} text-[13px] leading-relaxed whitespace-pre-wrap break-words shadow-[var(--shadow-xs)] transition-shadow duration-[var(--duration-fast)] ease-[var(--ease-out)] group-hover/bubble:shadow-[var(--shadow-sm)] ${
                      isOutbound
                        ? `rounded-l-[var(--radius-lg)] rounded-br-[var(--radius-xs)] ${startsRun ? "rounded-tr-[var(--radius-lg)]" : "rounded-tr-[var(--radius-xs)]"}`
                        : `rounded-r-[var(--radius-lg)] ${startsRun ? "rounded-tl-[var(--radius-lg)]" : "rounded-tl-[var(--radius-xs)]"} rounded-bl-[var(--radius-xs)]`
                    } ${
                      entry.kind === "QUEUED"
                        ? "border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-sunken)] text-[color:var(--color-muted-foreground)]"
                        : isOutbound
                          ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]"
                          : "border border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-foreground)]"
                    }`}
                  >
                    {entry.media ? <MessageAttachment media={entry.media} /> : null}
                    {notArchived ? <MediaNotArchived body={entry.body} /> : null}
                    {text ? <div className={hasFile ? "px-2 pt-1.5 pb-0.5" : undefined}>{text}</div> : null}
                  </div>

                  {/* Mood Detection's reading of this customer message — an inference, with the
                      structured reasons on hover, never model reasoning. */}
                  {entry.mood ? (
                    <span className="mt-1 px-1">
                      <MoodBadge mood={entry.mood.mood} confidence={entry.mood.confidence} signals={entry.mood.signals} />
                    </span>
                  ) : null}

                  <span
                    className={`mt-1 flex items-center gap-1 px-1 text-[10px] text-[color:var(--color-muted-foreground)] ${
                      // A timestamp under every line of a four-line run is noise; under the last
                      // one it is the information. The rest are laid out but transparent, so they
                      // appear on hover of that message without the run reflowing when they do —
                      // `hidden` would have made every hover shift the messages below it.
                      endsRun || queued
                        ? ""
                        : "h-0 overflow-hidden opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover/bubble:h-auto group-hover/bubble:opacity-100"
                    }`}
                    title={formatDateTime(entry.at)}
                  >
                    {/* Who sent it, once per run: the software user who pressed send, or the
                        automation, and which of our numbers it went out from. The same attribution
                        the User Activity report reads, so the two can never disagree. */}
                    {isOutbound ? <Attribution entry={entry} accountLabel={accountLabel} /> : null}
                    {queued ? (
                      <>
                        {queued.tone === "bad" ? (
                          <AlertTriangle className="size-3 text-[color:var(--color-danger)]" aria-hidden />
                        ) : (
                          <Clock className="size-3" aria-hidden />
                        )}
                        <span className={queued.tone === "bad" ? "text-[color:var(--color-danger-fg)]" : ""}>
                          {queued.text}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="tabular">{formatTime(entry.at)}</span>
                        {entry.kind === "OUTGOING" ? <Check className="size-3" aria-hidden /> : null}
                      </>
                    )}
                  </span>

                  {queued?.tone === "bad" && entry.failureReason ? (
                    <span className="mt-0.5 max-w-full px-1 text-right text-[10px] leading-relaxed text-[color:var(--color-danger-fg)]">
                      {entry.failureReason}
                    </span>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Shown above the composer while a group has AI automation switched on. */
export function AiActiveNotice({ suppressedUntil }: { suppressedUntil: Date | null }) {
  const suppressed = suppressedUntil && new Date(suppressedUntil) > new Date();
  return (
    <div className="flex items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 py-2 text-[11px] text-[color:var(--color-muted-foreground)] sm:px-6">
      <Bot className="size-3.5 shrink-0" aria-hidden />
      {suppressed ? (
        <span>
          AI is paused for this group until {formatTime(new Date(suppressedUntil))} because a team
          member replied recently.
        </span>
      ) : (
        <span>
          AI automation is on for this group. Replying here pauses it while you handle the
          conversation.
        </span>
      )}
    </div>
  );
}

/** "Rudra · via Primary Account", or "AI · via Primary Account". Unknown senders stay unlabelled. */
function Attribution({ entry, accountLabel }: { entry: ThreadEntry; accountLabel: string }) {
  const badge = entry.authoredBy ? AUTHOR_BADGE[entry.authoredBy] : undefined;
  const person = entry.authoredBy === "HUMAN_USER" ? entry.sentBy : null;
  if (!badge && !person) return null;
  const Icon = badge?.icon;
  return (
    <span className="inline-flex items-center gap-1">
      {person ? (
        <span className="inline-flex items-center gap-0.5 font-medium text-[color:var(--color-foreground)]" title={`Sent by ${person.name} (@${person.username})`}>
          <UserRound className="size-2.5" aria-hidden />
          {person.name}
        </span>
      ) : badge && Icon ? (
        <span className="inline-flex items-center gap-0.5 rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1 py-px font-medium text-[color:var(--color-neutral-fg)]">
          <Icon className="size-2.5" aria-hidden />
          {badge.text}
          {entry.authoredBy === "BROADCAST" && entry.sentBy ? ` · ${entry.sentBy.name}` : ""}
        </span>
      ) : null}
      <span aria-hidden>·</span>
      <span>via {accountLabel}</span>
      <span aria-hidden>·</span>
    </span>
  );
}
