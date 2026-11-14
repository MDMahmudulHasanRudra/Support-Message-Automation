import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AlertTriangle, Ban, Clock, PauseCircle, Plug } from "lucide-react";
import { businessAppDefinition, isBusinessAppKey, safeAppPath } from "@support-automation/shared";
import { ButtonLink, Card, PageHeader } from "@/components/ui";
import { BusinessAppIcon } from "@/components/businessApps/BusinessAppIcon";
import { BusinessAppStatusBadge } from "@/components/businessApps/BusinessAppStatusBadge";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { authorizeBusinessAppLaunch, businessAppEmbedUrl } from "@/server/businessApps";
import { activeProjectId } from "@/server/projectContext";
import { LaunchButton } from "./LaunchButton";
import { EmbeddedBusinessApp } from "./EmbeddedBusinessApp";

export const metadata = { title: "Business App" };

/**
 * One Business App in this project. Every rule is `authorizeBusinessAppLaunch`'s — session, project access,
 * project status, the installation (project-scoped: another project's is never found) and `business_apps.open`
 * — and the page only words its answer. When the app is allowed and its dashboard address is configured, the
 * app's own frontend is shown inside the workspace (`EmbeddedBusinessApp`), on its own origin, with nothing of
 * this product's session handed to it. A refused decision never renders the frame, so a disabled, pending or
 * held installation cannot be opened from here.
 */
export default async function BusinessAppLauncherPage({ params, searchParams }: { params: Promise<{ appKey: string }>; searchParams: Promise<{ path?: string }> }) {
  const session = await requireAccess("business_apps.open");
  const { appKey } = await params;
  const { path } = await searchParams;
  if (!isBusinessAppKey(appKey)) notFound();
  const app = businessAppDefinition(appKey);
  const [decision, canManage, projectId] = await Promise.all([authorizeBusinessAppLaunch(appKey), hasPermission(session, "projects.manage"), activeProjectId()]);
  const installation = decision.installation;

  if (decision.ok) {
    const embed = businessAppEmbedUrl(app.key, path);
    // The frame keeps the app's own sign-in only because the app is on ANOTHER origin; one served from this
    // product's own address could lift its sandbox, so it is never framed.
    const h = await headers();
    const ownHost = (h.get("x-forwarded-host")?.split(",")[0] ?? h.get("host") ?? "").trim().toLowerCase();
    if (embed && new URL(embed.origin).host.toLowerCase() !== ownHost) {
      return <EmbeddedBusinessApp app={app} projectName={decision.project.name} src={embed.url} path={safeAppPath(path)} workspaceId={installation?.externalWorkspaceId ?? null} />;
    }
  }

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
              {app.name} is connected to this project, but its dashboard address is not configured on this server, so it cannot be shown here. Open asks {app.name} for a sign-in hand-off instead; what you can do in it is decided by {app.name}.
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
