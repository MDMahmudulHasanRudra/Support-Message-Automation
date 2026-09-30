"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  allowedProjectTransitions,
  PROJECT_ACCESS_LEVEL_DESCRIPTIONS,
  PROJECT_ACCESS_LEVEL_LABELS,
  PROJECT_ACCESS_LEVELS,
  PROJECT_STATUS_DESCRIPTIONS,
  type ProjectAccessLevelValue,
  type ProjectStatusValue,
} from "@support-automation/shared";
import { Badge, Button, ConfirmDialog, Select, Switch, useToast } from "@/components/ui";
import { setProjectAccess, setProjectFeature, setProjectStatus } from "@/server/actions/projects";
import { setUserAccessLevel } from "@/server/actions/adminUsers";

const VERB: Record<ProjectStatusValue, string> = {
  SETUP: "Move back to setup",
  ACTIVE: "Make active",
  SUSPENDED: "Suspend",
  ARCHIVED: "Archive",
};

/** The lifecycle buttons: only the transitions this status allows, and a confirmation for the two that stop work. */
export function ProjectStatusControl({ projectId, projectName, status }: { projectId: string; projectName: string; status: ProjectStatusValue }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<ProjectStatusValue | null>(null);
  const next = allowedProjectTransitions(status);

  function apply(to: ProjectStatusValue) {
    startTransition(async () => {
      const result = await setProjectStatus(projectId, to);
      setConfirming(null);
      if (result.error) showToast({ tone: "danger", title: result.error });
      else {
        showToast({ tone: "success", title: result.success ?? "Saved" });
        router.refresh();
      }
    });
  }

  if (next.length === 0) {
    return <p className="text-[13px] text-[color:var(--color-muted-foreground)]">An archived project cannot be changed from the portal. Nothing in it has been deleted.</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {next.map((to) => (
        <Button
          key={to}
          variant={to === "ARCHIVED" || to === "SUSPENDED" ? "danger" : "primary"}
          size="sm"
          loading={pending && confirming === to}
          onClick={() => (to === "ACTIVE" ? apply(to) : setConfirming(to))}
        >
          {VERB[to]}
        </Button>
      ))}
      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && apply(confirming)}
        title={confirming ? `${VERB[confirming]} ${projectName}?` : ""}
        description={confirming ? PROJECT_STATUS_DESCRIPTIONS[confirming] : undefined}
        confirmLabel={confirming ? VERB[confirming] : undefined}
        tone="danger"
        loading={pending}
      >
        {confirming === "ARCHIVED" ? (
          <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
            Archiving cannot be undone from the portal. Every message, setting and report stays in the database.
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

export interface AccessRow {
  id: string;
  username: string;
  name: string;
  role: string | null;
  hasAccess: boolean;
  level: ProjectAccessLevelValue | null;
  isMainAdmin: boolean;
}

/**
 * Who may enter this project, per user, and how much of their role they may use in it (Read, Write,
 * Full — a level only narrows the role, never widens it). The user's role is shown and never changed
 * here. A Main Admin can enter every project whatever this says, so their switch is shown as such.
 */
export function ProjectAccessList({ projectId, users, canManage }: { projectId: string; users: AccessRow[]; canManage: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function changeLevel(user: AccessRow, level: string) {
    setPendingUser(user.id);
    startTransition(async () => {
      const result = await setUserAccessLevel(user.id, projectId, level);
      setPendingUser(null);
      if (result.error) showToast({ tone: "danger", title: result.error });
      else {
        showToast({ tone: "success", title: result.success ?? "Saved" });
        router.refresh();
      }
    });
  }

  function toggle(user: AccessRow, granted: boolean) {
    setPendingUser(user.id);
    startTransition(async () => {
      const result = await setProjectAccess(projectId, user.id, granted);
      setPendingUser(null);
      if (result.error) showToast({ tone: "danger", title: result.error });
      else {
        showToast({ tone: "success", title: result.success ?? "Saved" });
        router.refresh();
      }
    });
  }

  return (
    <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
      {users.map((user) => (
        <li key={user.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-[color:var(--color-foreground)]">
              {user.name || user.username} <span className="font-normal text-[color:var(--color-muted-foreground)]">@{user.username}</span>
            </p>
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              Role: {user.role ?? "none"} <span aria-hidden>·</span> unchanged by project access
            </p>
          </div>
          {user.isMainAdmin ? <Badge color="blue">Main Admin — enters every project</Badge> : null}
          {user.hasAccess ? (
            <div className="w-28">
            <Select
              aria-label={`${user.username}'s access level in this project`}
              data-level-user={user.username}
              value={user.level ?? "FULL"}
              disabled={!canManage || pendingUser === user.id}
              onChange={(event) => changeLevel(user, event.target.value)}
              title={PROJECT_ACCESS_LEVEL_DESCRIPTIONS[user.level ?? "FULL"]}
            >
              {PROJECT_ACCESS_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {PROJECT_ACCESS_LEVEL_LABELS[level]}
                </option>
              ))}
            </Select>
            </div>
          ) : null}
          <label className="flex items-center gap-2 text-[13px] text-[color:var(--color-muted-foreground)]">
            <Switch
              checked={user.hasAccess}
              disabled={!canManage || pendingUser === user.id}
              onChange={(event) => toggle(user, event.target.checked)}
              aria-label={`${user.username} may enter this project`}
              data-user={user.username}
            />
            {user.hasAccess ? "Has access" : "No access"}
          </label>
        </li>
      ))}
    </ul>
  );
}


export interface FeatureRow {
  key: string;
  label: string;
  description: string;
  workerEffect: string;
  enabled: boolean;
}

/**
 * The project's feature entitlements. A switch per feature for a Main Admin; read-only otherwise.
 * Switching one off hides and refuses its pages and actions in this project and stops its background
 * work — said beside the switch, so nobody finds out from a missing module.
 */
export function ProjectFeatureList({ projectId, features, canManage }: { projectId: string; features: FeatureRow[]; canManage: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function toggle(feature: FeatureRow, enabled: boolean) {
    setPendingKey(feature.key);
    startTransition(async () => {
      const result = await setProjectFeature(projectId, feature.key, enabled);
      setPendingKey(null);
      if (result.error) showToast({ tone: "danger", title: result.error });
      else {
        showToast({ tone: "success", title: result.success ?? "Saved" });
        router.refresh();
      }
    });
  }

  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {features.map((feature) => (
        <li key={feature.key} className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-[color:var(--color-foreground)]">{feature.label}</span>
            {canManage ? (
              <Switch
                checked={feature.enabled}
                disabled={pendingKey === feature.key}
                onChange={(event) => toggle(feature, event.target.checked)}
                aria-label={`${feature.label} enabled for this project`}
                data-feature={feature.key}
              />
            ) : (
              <Badge color={feature.enabled ? "green" : "gray"} dot>
                {feature.enabled ? "On" : "Off"}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">{feature.description}</p>
          {feature.enabled ? null : (
            <p className="mt-1.5 text-xs text-[color:var(--color-warning-fg)]">Off: its pages are hidden and refused. {feature.workerEffect}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
