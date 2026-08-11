import Link from "next/link";
import { Badge, EmptyState, Table, Td, Th } from "@/components/ui";

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
            <Td>{m.timestampWa.toLocaleString()}</Td>
            <Td>{m.accountLabel}</Td>
            <Td>{m.groupName ?? "—"}</Td>
            <Td>
              {m.senderName ?? m.senderPhone}
              {m.isFromTeamMember ? (
                <span className="ml-1">
                  <Badge color="blue">Team</Badge>
                </span>
              ) : null}
            </Td>
            <Td>{m.direction}</Td>
            <Td className="max-w-xs truncate">{m.body}</Td>
            <Td>
              <Badge color={m.processingStatus === "IGNORED" ? "gray" : m.processingStatus === "FAILED" ? "red" : "green"}>
                {m.processingStatus}
              </Badge>
            </Td>
            <Td>{m.ruleName ?? "—"}</Td>
            <Td>{m.decision ? <Badge color={decisionColor(m.decision)}>{m.decision}</Badge> : "—"}</Td>
            <Td>{m.autoReplyStatus ?? "—"}</Td>
            <Td>
              {m.notifications.length === 0
                ? "—"
                : m.notifications.map((n) => `${n.type}: ${n.status}`).join(", ")}
            </Td>
            <Td>
              <Link href={`/messages/${m.id}`} className="text-xs underline">
                View
              </Link>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function decisionColor(decision: string): "green" | "red" | "yellow" | "gray" | "blue" {
  if (decision === "SUPPORT_REQUIRED") return "red";
  if (decision === "AUTO_REPLY" || decision === "ACTIONED") return "green";
  if (decision === "IGNORE" || decision === "STOPPED") return "gray";
  return "yellow"; // NO_MATCH
}
