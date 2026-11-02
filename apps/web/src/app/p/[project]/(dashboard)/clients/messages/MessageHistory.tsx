import { Badge } from "@/components/ui";
import type { ClientMessageView } from "@/server/clientMessages";

const TONE: Record<string, "green" | "yellow" | "red" | "gray" | "blue"> = {
  ACCEPTED: "green",
  QUEUED: "blue",
  SENDING: "blue",
  WAITING_APPROVAL: "yellow",
  PREPARED: "gray",
  FAILED: "red",
  UNKNOWN: "yellow",
  SKIPPED: "gray",
  CANCELLED: "gray",
};

const CHANNEL: Record<string, string> = { EMAIL: "Email", WHATSAPP: "WhatsApp", MESSENGER: "Messenger", INSTAGRAM: "Instagram", COPY: "Copied" };

/**
 * Messages to a client (or about one record), as they are known: an email by its outbox state — accepted by the
 * mail server, never "delivered"; anything else as prepared, because Get Assist did not send it.
 */
export function MessageHistory({ messages, empty }: { messages: ClientMessageView[]; empty: string }) {
  if (messages.length === 0) return <p className="text-sm text-[color:var(--color-muted-foreground)]">{empty}</p>;
  return (
    <ul className="space-y-3">
      {messages.map((m) => (
        <li key={m.id} className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">
              {CHANNEL[m.channel] ?? m.channel}
              {m.toAddress ? <span className="font-normal text-[color:var(--color-muted-foreground)]"> · {m.toAddress}</span> : null}
            </span>
            <Badge color={TONE[m.state] ?? "gray"}>{m.stateLabel}</Badge>
          </div>
          {m.subject ? <div className="mt-1 font-medium">{m.subject}</div> : null}
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[color:var(--color-muted-foreground)]">{m.body}</p>
          {m.error ? <p className="mt-1 text-xs text-[color:var(--color-danger-fg)]">{m.error}</p> : null}
          {m.skipReason ? <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">Skipped: {m.skipReason}</p> : null}
          <div className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            {m.createdByName ?? "—"} · {m.createdAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" })}
            {m.templateName ? ` · ${m.templateName}${m.templateVersion ? ` v${m.templateVersion}` : ""}` : ""}
          </div>
        </li>
      ))}
    </ul>
  );
}
