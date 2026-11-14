import { ArrowRight, Puzzle } from "lucide-react";
import { businessAppDefinition, BUSINESS_APP_STATUS_LABELS } from "@support-automation/shared";
import { ButtonLink, Card, EmptyState, PageHeader } from "@/components/ui";
import { BusinessAppIcon } from "@/components/businessApps/BusinessAppIcon";
import { BusinessAppStatusBadge } from "@/components/businessApps/BusinessAppStatusBadge";
import { requireAccess } from "@/server/authorize";
import { projectInstallationsInWorkspace } from "@/server/businessApps";

export const metadata = { title: "Business Apps" };

/**
 * The project's Business Apps, from inside the workspace: each app a Main Admin added, its state, and Open for
 * a connected one. Only for a role that may open Business Apps; adding and connecting happen in the Main Admin
 * portal.
 */
export default async function BusinessAppsHubPage() {
  await requireAccess("business_apps.open");
  const installations = await projectInstallationsInWorkspace();

  return (
    <div>
      <PageHeader title="Business Apps" description="Separate business apps this project uses. Each keeps its own data; a connected app opens in its own window." />
      {installations.length === 0 ? (
        <Card>
          <EmptyState icon={<Puzzle className="size-5" aria-hidden />}>
            No Business App has been added to this project yet. A Main Admin can add one from the project&apos;s Business Apps tab in the Main Admin portal.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {installations.map((i) => {
            const app = businessAppDefinition(i.appKey);
            return (
              <Card key={i.id}>
                <div className="flex items-start gap-3">
                  <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent-bg)] text-[color:var(--color-accent-fg)]">
                    <BusinessAppIcon icon={app.icon} className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[15px] font-semibold text-[color:var(--color-foreground)]">{app.name}</h2>
                      <BusinessAppStatusBadge status={i.status} />
                    </div>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">{app.description}</p>
                    <div className="mt-3">
                      <ButtonLink href={`/apps/${app.key}`} variant={i.status === "ACTIVE" ? "primary" : "secondary"} size="sm">
                        {i.status === "ACTIVE" ? "Open" : `Details (${BUSINESS_APP_STATUS_LABELS[i.status].toLowerCase()})`}
                        <ArrowRight className="size-3.5" aria-hidden />
                      </ButtonLink>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
