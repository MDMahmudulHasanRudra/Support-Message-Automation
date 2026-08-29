import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Badge, type BadgeColor, EmptyState, Table, Td, Th, Tooltip } from "@/components/ui";
import { formatDateTime } from "@/lib/date";

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
          <Th>Account</Th>
          <Th>Group</Th>
          <Th>Sender</Th>
          <Th>Direction</Th>
          <Th>Message</Th>
          <Th>Status</Th>
          <Th>Rule Matched</Th>
          <Th>Decision</Th>
          <Th>Auto-Reply</Th>
          <Th>Notification</Th>
          <Th>{null}</Th>
        </tr>
      </thead>
      <tbody>
        {messages.map((m) => (
          <tr key={m.id}>
            <Td className="whitespace-nowrap font-[family-name:var(--font-mono)] text-xs">
              {formatDateTime(m.timestampWa)}
            </Td>
            <Td>{m.accountLabel}</Td>
            <Td>{m.groupName ?? "—"}</Td>
            <Td>
              {m.senderName ?? m.senderPhone}
              {m.isFromTeamMember ? (
                <span className="ml-1.5">
                  <Badge color="blue">Team</Badge>
                </span>
              ) : null}
            </Td>
            <Td>{m.direction}</Td>
            <Td className="max-w-xs">
              <Tooltip content={<span className="whitespace-pre-wrap">{m.body}</span>}>
                <span className="block max-w-xs truncate">{m.body}</span>
              </Tooltip>
            </Td>
            <Td>
              <Badge color={processingStatusColor(m.processingStatus)} dot>
                {m.processingStatus}
              </Badge>
            </Td>
            <Td>{m.ruleName ?? "—"}</Td>
            <Td>{m.decision ? <Badge color={decisionColor(m.decision)}>{m.decision}</Badge> : "—"}</Td>
            <Td>
              {m.autoReplyStatus ? (
                <Badge color={autoReplyStatusColor(m.autoReplyStatus)} dot>
                  {m.autoReplyStatus}
                </Badge>
              ) : (
                "—"
              )}
            </Td>
            <Td>
              {m.notifications.length === 0 ? (
                "—"
              ) : (
                <div className="flex flex-wrap gap-1">
                  {m.notifications.map((n, i) => (
                    <Badge key={i} color={notificationStatusColor(n.status)}>
                      {n.type}: {n.status}
                    </Badge>
                  ))}
                </div>
              )}
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
