import { pageAccess } from "@/server/authorize";
import { listBillingCurrencies, listDues, parseDueFilters, DUES_PAGE_SIZE } from "@/server/clientBilling";
import { Badge, Card, EmptyState, PageHeader, SectionHeader, Table, Td, Th, ViewOnlyNotice } from "@/components/ui";
import Link from "@/components/ProjectLink";
import { CLIENT_DUE_STATUS_LABELS, formatMoney, type ClientDueStatusValue } from "@support-automation/shared";
import { CurrencyPanel } from "./CurrencyPanel";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const VIEWS: Array<[string, string]> = [
  ["open", "Open"],
  ["overdue", "Overdue"],
  ["PAID", "Paid"],
  ["all", "All"],
];

/** Every manual due in the project. Needs the billing key; the client list and its timeline do not show any of this. */
export default async function DuesPage({ searchParams }: { searchParams: SearchParams }) {
  const { canManage } = await pageAccess("clients.view_billing", "clients.edit_billing");
  const filters = parseDueFilters(await searchParams);
  const [{ dues, total, today }, currencies] = await Promise.all([listDues(filters), listBillingCurrencies()]);
  const href = (view: string) => `/clients/dues?view=${view}${filters.q ? `&q=${encodeURIComponent(filters.q)}` : ""}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Client dues" description={`Due dates typed by staff, as of ${today} (Dhaka). Nothing here is sent to a client, and nothing is connected to a payment system.`} />
      {canManage ? null : <ViewOnlyNotice />}

      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map(([value, label]) => (
          <Link key={value} href={href(value)} className={`rounded-full border px-3 py-1 text-sm ${filters.view === value ? "border-[var(--color-accent)] font-medium" : "border-[var(--color-border)]"}`}>
            {label}
          </Link>
        ))}
        <form className="ml-auto">
          <input type="hidden" name="view" value={filters.view} />
          <input name="q" defaultValue={filters.q} placeholder="Client name or code" className="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-transparent px-3 text-sm" />
        </form>
      </div>

      {dues.length === 0 ? (
        <EmptyState>No dues match.</EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Client</Th>
                <Th>Due date</Th>
                <Th>Amount</Th>
                <Th>Paid so far</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {dues.map((d) => (
                <tr key={d.id}>
                  <Td>
                    <Link className="link font-medium" href={`/clients/${d.client.id}`}>
                      {d.client.name}
                    </Link>
                    <div className="text-xs text-[color:var(--color-muted-foreground)]">{d.client.code}</div>
                  </Td>
                  <Td>{d.dueDate}</Td>
                  <Td>{formatMoney(d.amount, d.currency)}</Td>
                  <Td>{d.paidAmount ? formatMoney(d.paidAmount, d.currency) : "—"}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      {d.overdue ? <Badge color="red">Overdue</Badge> : null}
                      <Badge color={d.status === "PAID" ? "green" : d.status === "UNPAID" || d.status === "PARTIALLY_PAID" ? "yellow" : "gray"}>{CLIENT_DUE_STATUS_LABELS[d.status as ClientDueStatusValue] ?? d.status}</Badge>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {total > DUES_PAGE_SIZE ? <p className="text-xs text-[color:var(--color-muted-foreground)]">Showing the first {DUES_PAGE_SIZE} of {total}. Narrow the filter to see the rest.</p> : null}
        </>
      )}

      <Card className="p-6">
        <SectionHeader title="Currencies" />
        <CurrencyPanel currencies={currencies.map((c) => ({ code: c.code, enabled: c.enabled }))} canEdit={canManage} />
      </Card>
    </div>
  );
}
