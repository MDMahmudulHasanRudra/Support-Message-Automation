import NextLink from "next/link";
import { Puzzle } from "lucide-react";
import { BUSINESS_APP_CONTRACT_VERSION, BUSINESS_APPS, businessAppDefinition } from "@support-automation/shared";
import { Badge, Card, EmptyState, PageHeader, SectionHeader, Table, Td, Th } from "@/components/ui";
import { BusinessAppIcon } from "@/components/businessApps/BusinessAppIcon";
import { BusinessAppStatusBadge } from "@/components/businessApps/BusinessAppStatusBadge";
import { requireMainAdminPage } from "@/server/mainAdmin";
import { listCustomerInstallations } from "@/server/businessApps";

export const metadata = { title: "Business Apps" };

/**
 * The Business Apps a customer's projects can add (docs/BUSINESS_APP_INTEGRATION_CONTRACT.md): the catalogue,
 * then every installation across the customer's own projects. Adding, connecting and disabling happen on each
 * project's Business Apps tab, where `projects.manage` is checked by every action.
 */
export default async function BusinessAppsPage() {
  const { canManage } = await requireMainAdminPage();
  const installations = await listCustomerInstallations();

  return (
    <div className="space-y-8">
      <PageHeader
        title="Business Apps"
        description="Separate business apps your projects can add, such as a Commerce ERP. Each keeps its own data and opens from the project's workspace once its connection is verified."
      />

      <section>
        <SectionHeader title="Available apps" description={`Integration contract ${BUSINESS_APP_CONTRACT_VERSION}.`} />
        <div className="grid gap-4 md:grid-cols-3">
          {BUSINESS_APPS.map((app) => {
            const count = installations.filter((i) => i.appKey === app.key).length;
            const connected = installations.filter((i) => i.appKey === app.key && i.status === "ACTIVE").length;
            return (
              <Card key={app.key}>
                <div className="flex items-start gap-3">
                  <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent-bg)] text-[color:var(--color-accent-fg)]">
                    <BusinessAppIcon icon={app.icon} className="size-5" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[15px] font-semibold text-[color:var(--color-foreground)]">{app.name}</h3>
                      {app.availability === "INSTALLABLE" ? <Badge color="blue">Ready to add</Badge> : <Badge color="gray">Coming soon</Badge>}
                    </div>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">{app.description}</p>
                    <p className="mt-2 text-[12px] text-[color:var(--color-subtle-foreground)]">
                      {count ? `In ${count} ${count === 1 ? "project" : "projects"} · ${connected} connected` : "Not in any project yet"}
                    </p>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      <section>
        <SectionHeader
          title="Installations"
          description={canManage ? "Open a project to add, connect or disable an app there." : "Adding, connecting and disabling apps needs the Manage Projects permission."}
        />
        {installations.length === 0 ? (
          <Card>
            <EmptyState icon={<Puzzle className="size-5" aria-hidden />}>
              No project uses a Business App yet. Add one when you create a project, or from a project&apos;s Business Apps tab.
            </EmptyState>
          </Card>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Project</Th>
                <Th>App</Th>
                <Th>Status</Th>
                <Th>Last verified</Th>
                <Th>Last problem</Th>
              </tr>
            </thead>
            <tbody>
              {installations.map((i) => (
                <tr key={i.id}>
                  <Td>
                    <NextLink href={`/admin/projects/${i.projectId}?tab=apps`} className="font-medium text-[color:var(--color-foreground)] hover:underline">
                      {i.projectName}
                    </NextLink>
                    {i.projectStatus === "SUSPENDED" || i.projectStatus === "ARCHIVED" ? (
                      <span className="ml-2 text-[12px] text-[color:var(--color-subtle-foreground)]">({i.projectStatus.toLowerCase()})</span>
                    ) : null}
                  </Td>
                  <Td>{businessAppDefinition(i.appKey).name}</Td>
                  <Td>
                    <BusinessAppStatusBadge status={i.status} />
                  </Td>
                  <Td className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
                    {i.lastConnectedAt ? i.lastConnectedAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" }) : "Never"}
                  </Td>
                  <Td className="max-w-[28rem] text-[12.5px] text-[color:var(--color-muted-foreground)]">{i.status === "ACTIVE" ? "—" : (i.lastError ?? "—")}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
