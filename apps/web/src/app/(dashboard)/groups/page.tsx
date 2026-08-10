import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, Button, PageHeader, Table, Td, Th } from "@/components/ui";
import { toggleGroupMonitoring } from "@/server/actions/groups";

export default async function GroupsPage() {
  await requireSession();
  const groups = await prisma.whatsAppGroup.findMany({
    orderBy: { name: "asc" },
    include: { account: { select: { label: true } } },
  });

  return (
    <div>
      <PageHeader
        title="WhatsApp Groups"
        description="Only monitored groups are eligible for auto-reply. Use Accounts → Resync Groups to discover new ones."
      />

      {groups.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No groups discovered yet.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Group</Th>
              <Th>Account</Th>
              <Th>Monitored</Th>
              <Th>Last Synced</Th>
              <Th>Manage</Th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <Td>{g.name}</Td>
                <Td>{g.account.label}</Td>
                <Td>
                  <Badge color={g.isMonitored ? "green" : "gray"}>{g.isMonitored ? "Monitored" : "Not Monitored"}</Badge>
                </Td>
                <Td>{g.lastSyncedAt?.toLocaleString() ?? "—"}</Td>
                <Td>
                  <form action={toggleGroupMonitoring.bind(null, g.id)}>
                    <Button variant="secondary" type="submit">
                      {g.isMonitored ? "Stop Monitoring" : "Start Monitoring"}
                    </Button>
                  </form>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
