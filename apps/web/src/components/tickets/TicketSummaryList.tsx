import { Badge } from "@/components/ui";
import Link from "@/components/ProjectLink";
import { TICKET_STATUS_LABEL } from "@support-automation/shared";
import type { TicketSummary } from "@/server/tickets";
import { TICKET_CLOCK_CLASS, TICKET_STATUS_COLOR } from "./ticketDisplay";

/** The short list on a conversation's panel and a client's profile. */
export function TicketSummaryList({ items }: { items: TicketSummary[] }) {
  return (
    <ul className="divide-y divide-[var(--color-border)]">
      {items.map((t) => (
        <li key={t.id} className="py-2.5 first:pt-0 last:pb-0">
          <Link href={`/tickets/${t.id}`} className="group block">
            <span className="flex items-center gap-2">
              <span className="tabular shrink-0 text-[12px] font-medium text-[color:var(--color-muted-foreground)]">{t.label}</span>
              <Badge color={TICKET_STATUS_COLOR[t.status]}>{TICKET_STATUS_LABEL[t.status]}</Badge>
            </span>
            <span className="mt-1 block truncate text-[13px] font-medium text-[color:var(--color-foreground)] group-hover:underline">{t.subject}</span>
            <span className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 text-[12px]">
              <span className={TICKET_CLOCK_CLASS[t.clock.tone]}>{t.clock.text}</span>
              <span className="truncate text-[color:var(--color-muted-foreground)]">{t.assigneeName ?? "Nobody yet"}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
