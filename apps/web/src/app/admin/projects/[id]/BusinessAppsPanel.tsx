"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AlertTriangle, ExternalLink, Plug, Plus, Power, RefreshCw } from "lucide-react";
import { BUSINESS_APPS, type BusinessAppKey, type BusinessAppStatus } from "@support-automation/shared";
import { Button, ButtonLink, ConfirmDialog, useToast } from "@/components/ui";
import { BusinessAppIcon } from "@/components/businessApps/BusinessAppIcon";
import { BusinessAppStatusBadge } from "@/components/businessApps/BusinessAppStatusBadge";
import { addBusinessApp, connectBusinessAppAction, setBusinessAppEnabledAction, type BusinessAppActionResult } from "@/server/actions/businessApps";
import { ConnectAppDialog } from "./ConnectAppDialog";

export interface PanelInstallation {
  id: string;
  appKey: BusinessAppKey;
  status: BusinessAppStatus;
  lastConnectedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  installedByName: string | null;
  createdAt: string;
  contractVersion: string;
  externalWorkspaceId: string | null;
  credentialHint: string | null;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null);

/**
 * One project's Business Apps, from the Main Admin portal: every app in the registry, whether this project
 * has it, the state of its connection and the one or two things a Main Admin can do next. Every button is a
 * Server Action that checks `projects.manage` itself; a person without it sees the states and no buttons.
 */
export function BusinessAppsPanel({
  projectId,
  projectSlug,
  projectStatus,
  installations,
  canManage,
  canEnter,
}: {
  projectId: string;
  projectSlug: string;
  projectStatus: string;
  installations: PanelInstallation[];
  canManage: boolean;
  canEnter: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<PanelInstallation | null>(null);
  const [connecting, setConnecting] = useState<PanelInstallation | null>(null);
  const held = projectStatus === "SUSPENDED" || projectStatus === "ARCHIVED";

  function run(id: string, action: () => Promise<BusinessAppActionResult>) {
    setBusy(id);
    startTransition(async () => {
      const result = await action();
      setBusy(null);
      setConfirmDisable(null);
      if (!result.error) setConnecting(null);
      if (result.error) showToast({ tone: "danger", title: result.error });
      else showToast({ tone: "success", title: result.success ?? "Saved" });
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {BUSINESS_APPS.map((app) => {
        const inst = installations.find((i) => i.appKey === app.key) ?? null;
        const installable = app.availability === "INSTALLABLE";
        const isBusy = pending && busy === (inst?.id ?? app.key);
        return (
          <div key={app.key} className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 sm:flex-row sm:items-start">
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent-bg)] text-[color:var(--color-accent-fg)]">
              <BusinessAppIcon icon={app.icon} className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[14.5px] font-semibold text-[color:var(--color-foreground)]">{app.name}</h3>
                {inst ? <BusinessAppStatusBadge status={inst.status} /> : installable ? null : <span className="text-[12px] text-[color:var(--color-subtle-foreground)]">Coming soon</span>}
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">{app.description}</p>
              {inst ? (
                <dl className="mt-2.5 grid grid-cols-1 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
                  <div className="flex gap-1.5">
                    <dt className="text-[color:var(--color-subtle-foreground)]">Added</dt>
                    <dd className="text-[color:var(--color-muted-foreground)]">
                      {when(inst.createdAt)}
                      {inst.installedByName ? ` by ${inst.installedByName}` : ""}
                    </dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt className="text-[color:var(--color-subtle-foreground)]">Last verified</dt>
                    <dd className="text-[color:var(--color-muted-foreground)]">{when(inst.lastConnectedAt) ?? "Never"}</dd>
                  </div>
                  {inst.externalWorkspaceId ? (
                    <div className="flex min-w-0 gap-1.5">
                      <dt className="shrink-0 text-[color:var(--color-subtle-foreground)]">Workspace</dt>
                      <dd className="truncate font-mono text-[11.5px] text-[color:var(--color-muted-foreground)]" title={inst.externalWorkspaceId}>
                        {inst.externalWorkspaceId}
                      </dd>
                    </div>
                  ) : null}
                  {inst.credentialHint ? (
                    <div className="flex gap-1.5">
                      <dt className="text-[color:var(--color-subtle-foreground)]">Key</dt>
                      <dd className="font-mono text-[11.5px] text-[color:var(--color-muted-foreground)]">
                        {inst.credentialHint}… · contract {inst.contractVersion}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
              {inst?.lastError && inst.status !== "ACTIVE" ? (
                <p className={`mt-2.5 flex items-start gap-1.5 rounded-[var(--radius-md)] px-3 py-2 text-[12px] leading-relaxed ${inst.status === "ERROR" ? "bg-[var(--color-danger-bg)] text-[color:var(--color-danger-fg)]" : "bg-[var(--color-surface-sunken)] text-[color:var(--color-muted-foreground)]"}`}>
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    {inst.lastError}
                    {inst.lastErrorAt ? <span className="text-[color:var(--color-subtle-foreground)]"> · {when(inst.lastErrorAt)}</span> : null}
                  </span>
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
              {!inst && installable && canManage ? (
                <Button size="sm" loading={isBusy} disabled={pending || projectStatus === "ARCHIVED"} onClick={() => run(app.key, () => addBusinessApp(projectId, app.key))}>
                  <Plus className="size-3.5" aria-hidden />
                  Add to project
                </Button>
              ) : null}
              {inst && canManage && inst.status !== "DISABLED" ? (
                <Button size="sm" variant={inst.status === "ACTIVE" ? "secondary" : "primary"} loading={isBusy} disabled={pending || held} onClick={() => (inst.externalWorkspaceId ? run(inst.id, () => connectBusinessAppAction(inst.id, projectId, { mode: "RECHECK" })) : setConnecting(inst))}>
                  {inst.status === "ACTIVE" || inst.status === "ERROR" ? <RefreshCw className="size-3.5" aria-hidden /> : <Plug className="size-3.5" aria-hidden />}
                  {inst.status === "ACTIVE" ? "Check again" : inst.status === "ERROR" || inst.externalWorkspaceId ? "Reconnect" : "Connect"}
                </Button>
              ) : null}
              {inst && canManage && inst.status === "DISABLED" ? (
                <Button size="sm" variant="secondary" loading={isBusy} disabled={pending || projectStatus === "ARCHIVED"} onClick={() => run(inst.id, () => setBusinessAppEnabledAction(inst.id, projectId, true))}>
                  <Power className="size-3.5" aria-hidden />
                  Enable
                </Button>
              ) : null}
              {inst && canManage && inst.status !== "DISABLED" ? (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmDisable(inst)}>
                  Disable
                </Button>
              ) : null}
              {inst?.status === "ACTIVE" && canEnter && !held ? (
                <ButtonLink href={`/p/${projectSlug}/apps/${app.key}`} size="sm">
                  Open
                  <ExternalLink className="size-3.5" aria-hidden />
                </ButtonLink>
              ) : null}
            </div>
          </div>
        );
      })}
      <ConnectAppDialog
        open={connecting !== null}
        appName={connecting ? (BUSINESS_APPS.find((a) => a.key === connecting.appKey)?.name ?? "the app") : "the app"}
        loading={pending}
        onClose={() => setConnecting(null)}
        onConnect={(input) => connecting && run(connecting.id, () => connectBusinessAppAction(connecting.id, projectId, input))}
      />
      <ConfirmDialog
        open={confirmDisable !== null}
        onClose={() => setConfirmDisable(null)}
        onConfirm={() => confirmDisable && run(confirmDisable.id, () => setBusinessAppEnabledAction(confirmDisable.id, projectId, false))}
        title="Disable this app for the project?"
        description="Nobody can open it from this workspace, and the AI stops asking it anything. Nothing is deleted here or in the app, and the stored key is kept (encrypted, unused) so enabling it again needs only a fresh check. Someone already signed in to the app keeps that app's own session until it ends there."
        confirmLabel="Disable"
        tone="danger"
        loading={pending}
      />
    </div>
  );
}
