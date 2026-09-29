"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  allowedProjectTransitions,
  PROJECT_STATUS_DESCRIPTIONS,
  type ProjectStatusValue,
} from "@support-automation/shared";
import { Badge, Button, ConfirmDialog, Switch, useToast } from "@/components/ui";
import { setProjectAccess, setProjectStatus } from "@/server/actions/projects";

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
  isMainAdmin: boolean;
}

/**
 * Who may enter this project — yes or no, per user. The user's role is shown and never changed
 * here: it decides what they may do inside every project they can enter, and it stays exactly as it
 * is. A Main Admin can enter every project whatever this says, so their switch is shown as such.
 */
export function ProjectAccessList({ projectId, users, canManage }: { projectId: string; users: AccessRow[]; canManage: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [, startTransition] = useTransition();

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

