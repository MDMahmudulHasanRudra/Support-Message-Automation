import { notFound } from "next/navigation";
import { AlertTriangle, Ban, Clock, PauseCircle, Plug } from "lucide-react";
import { businessAppDefinition, isBusinessAppKey } from "@support-automation/shared";
import { ButtonLink, Card, PageHeader } from "@/components/ui";
import { BusinessAppIcon } from "@/components/businessApps/BusinessAppIcon";
import { BusinessAppStatusBadge } from "@/components/businessApps/BusinessAppStatusBadge";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { authorizeBusinessAppLaunch } from "@/server/businessApps";
import { activeProjectId } from "@/server/projectContext";
import { LaunchButton } from "./LaunchButton";

export const metadata = { title: "Business App" };

/**
 * The launcher for one Business App in this project. Every rule is `authorizeBusinessAppLaunch`'s — session,
 * project access, project status, the installation (project-scoped: another project's is never found) and
 * `business_apps.open` — and the page only words its answer. Nothing here embeds the app or hands it a
 * credential; Open asks the server for a single-use launch.
 */
export default async function BusinessAppLauncherPage({ params }: { params: Promise<{ appKey: string }> }) {
  const session = await requireAccess("business_apps.open");
  const { appKey } = await params;
  if (!isBusinessAppKey(appKey)) notFound();
  const app = businessAppDefinition(appKey);
  const [decision, canManage, projectId] = await Promise.all([authorizeBusinessAppLaunch(appKey), hasPermission(session, "projects.manage"), activeProjectId()]);
  const installation = decision.installation;

  let Icon = Clock;
  let detail: string | null = null;
  if (!decision.ok) {
    if (decision.refusal === "DISABLED") Icon = Ban;
    else if (decision.refusal === "PROJECT_SUSPENDED" || decision.refusal === "PROJECT_ARCHIVED") Icon = PauseCircle;
    else if (decision.refusal === "NOT_INSTALLED") Icon = Plug;
    else if (installation?.status === "ERROR") Icon = AlertTriangle;
    if (decision.refusal === "NOT_ACTIVE" && installation) {
      detail =
        installation.status === "ERROR"
          ? `The last connection check failed${installation.lastError ? `: ${installation.lastError}` : "."}`
          : installation.status === "CONNECTING"
            ? "A connection check is running. Reload in a moment."
            : (installation.lastError ?? "It has been added to this project and is waiting for a verified connection.");
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <BusinessAppIcon icon={app.icon} className="size-6 text-[color:var(--color-accent)]" />
            {app.name}
            {installation ? <BusinessAppStatusBadge status={installation.status} /> : null}
          </span>
        }
        description={app.description}
      />
      <Card>
        {decision.ok ? (
          <div className="space-y-4">
            <p className="text-[13.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">
              {app.name} is connected to this project. It opens in its own window and signs you in there; what you can do in it is decided by {app.name}.
            </p>
            <LaunchButton appKey={app.key} appName={app.name} />
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-sunken)] text-[color:var(--color-muted-foreground)]">
              <Icon className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-[color:var(--color-foreground)]">{decision.message}</p>
              {detail ? <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">{detail}</p> : null}
              {canManage && decision.refusal !== "PROJECT_ARCHIVED" ? (
                <div className="mt-3">
                  <ButtonLink href={`/admin/projects/${projectId}?tab=apps`} size="sm">
                    Manage in Main Admin
                  </ButtonLink>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
