import NextLink from "next/link";
import { Card, EmptyState, PageHeader, SectionHeader, Table, Td, Th } from "@/components/ui";
import { requireOperatorPage } from "@/server/platform/auth";
import { listSupportSessions } from "@/server/platform/support";
import { EndSupportButton } from "./EndSupportButton";

export const metadata = { title: "Support access" };

/** Every support session, open ones first: who entered which customer, why, for how long, and how it ended. */
export default async function SupportAccessPage() {
  await requireOperatorPage();
  const sessions = await listSupportSessions({ take: 100 });
  const open = sessions.filter((s) => s.active);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Support access"
        description="Start support access from a customer's page. Each session is time-limited, recorded here and in the customer's own System Log, and can be ended by any operator."
      />
      <Card>
        <SectionHeader title={`Open now (${open.length})`} />
        {open.length === 0 ? <EmptyState>No support session is open.</EmptyState> : <SessionTable sessions={open} />}
      </Card>
      <Card>
        <SectionHeader title="History" />
        {sessions.length === 0 ? <EmptyState>No support access yet.</EmptyState> : <SessionTable sessions={sessions.filter((s) => !s.active)} />}
      </Card>
    </div>
  );
}

function SessionTable({ sessions }: { sessions: Awaited<ReturnType<typeof listSupportSessions>> }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Customer</Th>
          <Th>Operator</Th>
          <Th>Reason</Th>
          <Th>When</Th>
          <Th>Status</Th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.id}>
            <Td>
              <NextLink href={`/platform/customers/${s.customerId}`} className="font-medium hover:underline">
                {s.customerName}
              </NextLink>
            </Td>
            <Td>{s.operatorUsername}</Td>
            <Td className="max-w-xs text-xs">{s.reason}</Td>
            <Td className="text-xs">
              {new Date(s.createdAt).toLocaleString()}
              <br />
              until {new Date(s.expiresAt).toLocaleTimeString()}
            </Td>
            <Td className="text-xs">
              {s.active ? (
                <EndSupportButton id={s.id} />
              ) : s.endedAt ? (
                `${(s.endReason ?? "ended").toLowerCase()}${s.endedByUsername ? ` by ${s.endedByUsername}` : ""}`
              ) : (
                "expired"
              )}
              {s.ticketUsedAt ? null : <span className="block text-[color:var(--color-muted-foreground)]">link not used</span>}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
