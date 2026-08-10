import { Badge, EmptyState, Table, Td, Th } from "@/components/ui";

export interface MessageRow {
  id: string;
  senderPhone: string;
  senderName: string | null;
  body: string;
  direction: string;
  processingStatus: string;
  isFromTeamMember: boolean;
  timestampWa: Date;
}

export function MessageList({ messages }: { messages: MessageRow[] }) {
  if (messages.length === 0) return <EmptyState>No messages found.</EmptyState>;

  return (
    <Table>
      <thead>
        <tr>
          <Th>Time</Th>
          <Th>Sender</Th>
          <Th>Direction</Th>
          <Th>Message</Th>
          <Th>Status</Th>
        </tr>
      </thead>
      <tbody>
        {messages.map((m) => (
          <tr key={m.id}>
            <Td>{m.timestampWa.toLocaleString()}</Td>
            <Td>
              {m.senderName ?? m.senderPhone}
              {m.isFromTeamMember ? (
                <span className="ml-1">
                  <Badge color="blue">Team</Badge>
                </span>
              ) : null}
            </Td>
            <Td>{m.direction}</Td>
            <Td className="max-w-lg">{m.body}</Td>
            <Td>
              <Badge color={m.processingStatus === "IGNORED" ? "gray" : m.processingStatus === "FAILED" ? "red" : "green"}>
                {m.processingStatus}
              </Badge>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
