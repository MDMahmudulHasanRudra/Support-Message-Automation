import Link from "@/components/ProjectLink";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { Badge, type BadgeColor, EmptyState, Table, Td, Th, Tooltip } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { enumLabel } from "@/lib/displayLabels";

export interface MessageRow {
  id: string;
  senderPhone: string;
  senderName: string | null;
  isFromTeamMember: boolean;
  direction: string;
  body: string;
  processingStatus: string;
  timestampWa: Date;
  accountLabel: string;
  groupName: string | null;
  ruleName: string | null;
  decision: string | null;
  autoReplyStatus: string | null;
  notifications: Array<{ type: string; status: string }>;
}

export function MessagesTable({ messages, hasActiveFilters }: { messages: MessageRow[]; hasActiveFilters: boolean }) {
  if (messages.length === 0) {
    return <EmptyState>{hasActiveFilters ? "No messages match these filters." : "No messages found."}</EmptyState>;
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Time</Th>
          <Th>Conversation</Th>
          <Th>Sender</Th>
          <Th>Message</Th>
          <Th>Result</Th>
          <Th>{null}</Th>
        </tr>
      </thead>
      <tbody>
        {messages.map((m) => (
          <tr key={m.id}>
            <Td className="w-28 text-xs tabular-nums text-[color:var(--color-muted-foreground)]">{formatDateTime(m.timestampWa)}</Td>
            <Td className="max-w-52">
              <p className="truncate font-medium" title={m.groupName ?? undefined}>{m.groupName ?? "Personal chat"}</p>
              <p className="truncate text-xs text-[color:var(--color-muted-foreground)]">{m.accountLabel}</p>
            </Td>
            <Td className="max-w-40">
              <span className="break-words">{m.senderName ?? m.senderPhone}</span>
              {m.isFromTeamMember ? (
                <span className="ml-1.5">
                  <Badge color="blue">Team</Badge>
                </span>
              ) : null}
            </Td>
            <Td className="max-w-xs">
              <Tooltip content={<span className="whitespace-pre-wrap">{m.body}</span>}>
                <span className="flex min-w-0 items-center gap-1.5">
                  {m.direction === "OUTGOING" ? (
                    <ArrowUpRight className="size-3.5 shrink-0 text-[color:var(--color-accent-fg)]" aria-label="Sent by us" />
                  ) : (
                    <ArrowDownLeft className="size-3.5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-label="Received" />
                  )}
                  <span className="truncate">{m.body}</span>
                </span>
              </Tooltip>
            </Td>
            <Td className="max-w-72">
              <div className="flex flex-wrap gap-1">
                <Badge color={processingStatusColor(m.processingStatus)} dot>
                  {enumLabel(m.processingStatus)}
                </Badge>
                {m.decision ? <Badge color={decisionColor(m.decision)}>{enumLabel(m.decision)}</Badge> : null}
                {m.autoReplyStatus ? (
                  <Badge color={autoReplyStatusColor(m.autoReplyStatus)} dot>
                    Auto reply: {enumLabel(m.autoReplyStatus).toLowerCase()}
                  </Badge>
                ) : null}
                {m.notifications.map((n, i) => (
                  <Badge key={i} color={notificationStatusColor(n.status)}>
                    {enumLabel(n.type)}: {enumLabel(n.status).toLowerCase()}
                  </Badge>
                ))}
              </div>
              {m.ruleName ? <p className="mt-1 truncate text-xs text-[color:var(--color-muted-foreground)]" title={m.ruleName}>Rule: {m.ruleName}</p> : null}
            </Td>
            <Td>
              <Link
                href={`/messages/${m.id}`}
                className="link inline-flex items-center gap-1 text-xs"
              >
                View
                <ArrowUpRight className="size-3" aria-hidden />
              </Link>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function decisionColor(decision: string): BadgeColor {
  if (decision === "SUPPORT_REQUIRED") return "red";
  if (decision === "AUTO_REPLY" || decision === "ACTIONED") return "green";
  if (decision === "IGNORE" || decision === "STOPPED") return "gray";
  return "yellow"; // NO_MATCH
}

function processingStatusColor(status: string): BadgeColor {
  if (status === "IGNORED") return "gray";
  if (status === "FAILED") return "red";
  return "green";
}

function notificationStatusColor(status: string): BadgeColor {
  if (status === "SENT") return "green";
  if (status === "FAILED") return "red";
  return "yellow";
}

function autoReplyStatusColor(status: string): BadgeColor {
  if (status === "SENT") return "green";
  if (status === "FAILED") return "red";
  if (status === "SKIPPED" || status === "CANCELLED") return "gray";
  if (status === "PROCESSING") return "blue";
  return "yellow";
}
