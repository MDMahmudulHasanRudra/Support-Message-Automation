import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";

export default async function LogsPage() {
  await requireSession();
  const logs = await prisma.systemLog.findMany({ orderBy: { createdAt: "desc" }, take: 200 });

  return (
    <div>
      <PageHeader title="System Logs" description="Most recent 200 entries." />
      {logs.length === 0 ? (
        <EmptyState>No log entries yet.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Time</Th>
              <Th>Level</Th>
              <Th>Scope</Th>
              <Th>Message</Th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <Td>{log.createdAt.toLocaleString()}</Td>
                <Td>
                  <Badge color={log.level === "ERROR" ? "red" : log.level === "WARN" ? "yellow" : "gray"}>{log.level}</Badge>
                </Td>
                <Td>{log.scope}</Td>
                <Td className="max-w-xl">{log.message}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
