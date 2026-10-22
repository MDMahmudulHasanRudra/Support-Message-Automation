import { PLATFORM_LOG_CUSTOMER, prisma as globalPrisma } from "@support-automation/db";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { requireOperatorPage } from "@/server/platform/auth";

export const metadata = { title: "Activity" };

/** The platform's own log: sign-ins, customers, plans, payments, domains, support access. Never a customer's log. */
export default async function PlatformActivityPage() {
  await requireOperatorPage();
  const rows = await globalPrisma.systemLog.findMany({ where: { customerId: PLATFORM_LOG_CUSTOMER }, orderBy: { createdAt: "desc" }, take: 200 });
  return (
    <div>
      <PageHeader title="Activity" description="What happened on the platform, newest first. Each customer's own System Log stays in their software." />
      {rows.length === 0 ? (
        <EmptyState>Nothing recorded yet.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Event</Th>
              <Th>Details</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap text-xs">{r.createdAt.toLocaleString()}</Td>
                <Td>
                  <span className="flex items-center gap-2">
                    {r.level !== "INFO" ? <Badge color={r.level === "ERROR" ? "red" : "yellow"}>{r.level}</Badge> : null}
                    {r.message}
                  </span>
                </Td>
                <Td className="max-w-md truncate font-mono text-[11px] text-[color:var(--color-muted-foreground)]">{r.metadata ? JSON.stringify(r.metadata) : ""}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
