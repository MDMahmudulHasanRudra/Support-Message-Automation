import NextLink from "next/link";
import { Plus } from "lucide-react";
import { ButtonLink, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { requireOperatorPage } from "@/server/platform/auth";
import { listCustomers } from "@/server/platform/customers";
import { listCustomerSubscriptions } from "@/server/platform/billing";
import { SAAS_SUBSCRIPTION_STATE_LABELS } from "@support-automation/shared";
import { Badge } from "@/components/ui";
import { DomainStatusBadge } from "../DomainStatusBadge";

export const metadata = { title: "Customers" };

export default async function CustomersPage() {
  await requireOperatorPage();
  const canManage = true;
  const [customers, subscriptions] = await Promise.all([listCustomers(), listCustomerSubscriptions()]);
  return (
    <div>
      <PageHeader
        title="Customers"
        description="Each customer runs its own copy of the software — its own Main Admin, projects, people, roles and WhatsApp numbers — on its own address. Nothing is shared between customers."
        actions={
          canManage ? (
            <ButtonLink href="/platform/customers/new" variant="primary">
              <Plus className="size-4" aria-hidden />
              Add customer
            </ButtonLink>
          ) : null
        }
      />
      {customers.length === 0 ? (
        <EmptyState>
          No customers yet. Start by adding your existing installation as the first customer — choose “The original installation” so its data, people
          and addresses stay exactly as they are.
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Customer</Th>
              <Th>Workspaces</Th>
              <Th>Subscription</Th>
              <Th>Addresses</Th>
              <Th>Contact</Th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id}>
                <Td>
                  <NextLink href={`/platform/customers/${c.id}`} className="font-medium hover:underline">
                    {c.name}
                  </NextLink>
                </Td>
                <Td>
                  {c.projects.length === 0 ? (
                    "—"
                  ) : (
                    <span className="flex flex-col gap-0.5">
                      {c.projects.slice(0, 3).map((p) => (
                        <span key={p.id}>
                          {p.name} <span className="font-mono text-xs text-[color:var(--color-muted-foreground)]">/p/{p.slug}</span>
                        </span>
                      ))}
                      {c.projects.length > 3 ? <span className="text-xs text-[color:var(--color-muted-foreground)]">+{c.projects.length - 3} more</span> : null}
                    </span>
                  )}
                  {c.isFounding ? <Badge color="blue">Original installation</Badge> : null}
                </Td>
                <Td>
                  {(() => {
                    const s = subscriptions.get(c.id);
                    if (!s) return <span className="text-[color:var(--color-muted-foreground)]">None</span>;
                    const color = s.state === "ACTIVE" ? "green" : s.state === "TRIALING" ? "blue" : s.state === "PAST_DUE" ? "yellow" : s.state === "SUSPENDED" ? "red" : "gray";
                    return (
                      <span className="flex flex-col gap-1">
                        <span>{s.planName}</span>
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge color={color} dot>
                            {SAAS_SUBSCRIPTION_STATE_LABELS[s.state]}
                          </Badge>
                          {s.accessUntil ? <span className="text-xs text-[color:var(--color-muted-foreground)]">until {s.accessUntil.slice(0, 10)}</span> : null}
                        </span>
                      </span>
                    );
                  })()}
                </Td>
                <Td>
                  {c.domains.length === 0 ? (
                    <span className="text-[color:var(--color-muted-foreground)]">None yet</span>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {c.domains.map((d) => (
                        <span key={d.hostname} className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs">{d.hostname}</span>
                          <DomainStatusBadge status={d.status} />
                        </span>
                      ))}
                    </div>
                  )}
                </Td>
                <Td>{[c.contactName, c.contactEmail].filter(Boolean).join(" · ") || "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
