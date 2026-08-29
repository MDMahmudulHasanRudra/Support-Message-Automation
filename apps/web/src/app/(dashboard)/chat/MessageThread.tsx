import { AlertTriangle, Bot, Check, Clock, ListChecks, UserRound } from "lucide-react";
import type { ThreadEntry } from "@/server/chatInbox";
import { formatDateTime, formatTime } from "@/lib/date";

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

/** Who wrote an outgoing message, in the operator's terms. */
const AUTHOR_LABEL = {
  AI: { text: "AI", icon: Bot },
  RULE: { text: "Rule", icon: ListChecks },
  PERSON: { text: null, icon: null },
} as const;

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
export function MessageThread({ entries }: { entries: ThreadEntry[] }) {
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
  const rows = entries.map((entry, index) => {
    const day = dayFormat.format(entry.at);
    const previousDay = index === 0 ? null : dayFormat.format(entries[index - 1].at);
    return { entry, day, showDivider: day !== previousDay };
  });

  return (
    <div className="flex flex-col gap-1 px-4 py-5 sm:px-6">
      {rows.map(({ entry, day, showDivider }) => {
        const isOutbound = entry.kind === "OUTGOING" || entry.kind === "QUEUED";
        const isSystem = entry.kind === "SYSTEM";
        const queued = entry.kind === "QUEUED" ? QUEUED_LABEL[entry.outboundStatus ?? ""] : undefined;

        return (
          <div key={entry.id}>
            {showDivider ? <DayDivider label={day} /> : null}

            {isSystem ? (
              <p className="my-1 text-center text-[11px] italic text-[color:var(--color-subtle-foreground)]">
                {entry.body}
              </p>
            ) : (
              <div className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[min(38rem,80%)] ${isOutbound ? "items-end" : "items-start"} flex flex-col`}>
                  {!isOutbound ? (
                    <span className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-medium text-[color:var(--color-muted-foreground)]">
                      {entry.isTeamMember ? (
                        <UserRound className="size-3" aria-hidden />
                      ) : null}
                      {entry.senderName ?? entry.senderPhone}
                    </span>
                  ) : null}

                  <div
                    className={`rounded-[var(--radius-lg)] px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words ${
                      entry.kind === "QUEUED"
                        ? "border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-sunken)] text-[color:var(--color-muted-foreground)]"
                        : isOutbound
                          ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]"
                          : "border border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-foreground)]"
                    }`}
                  >
                    {entry.body}
                  </div>

                  <span
                    className="mt-1 flex items-center gap-1 px-1 text-[10px] text-[color:var(--color-muted-foreground)]"
                    title={formatDateTime(entry.at)}
                  >
                    {/* Only automated authorship is called out. A person's own reply needs no
                        badge — the absence of one is the signal, and labelling every message
                        would make the automated ones harder to spot, not easier. */}
                    {entry.authoredBy && AUTHOR_LABEL[entry.authoredBy].text ? (
                      <span className="inline-flex items-center gap-0.5 rounded-[var(--radius-xs)] bg-[var(--color-neutral-bg)] px-1 py-px font-medium text-[color:var(--color-neutral-fg)]">
                        {(() => {
                          const Icon = AUTHOR_LABEL[entry.authoredBy!].icon!;
                          return <Icon className="size-2.5" aria-hidden />;
                        })()}
                        {AUTHOR_LABEL[entry.authoredBy].text}
                      </span>
                    ) : null}
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
