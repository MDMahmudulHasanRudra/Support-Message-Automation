"use client";

import { useRouter } from "next/navigation";
import { startTransition as startActionTransition, useActionState, useEffect, useMemo, useState, useTransition, type FormEvent } from "react";
import {
  allowedProjectTransitions,
  PROJECT_ACCESS_LEVEL_DESCRIPTIONS,
  PROJECT_ACCESS_LEVEL_LABELS,
  PROJECT_ACCESS_LEVELS,
  PROJECT_NAME_MAX,
  PROJECT_STATUS_DESCRIPTIONS,
  type ProjectAccessLevelValue,
  type ProjectStatusValue,
} from "@support-automation/shared";
import { Badge, Button, ConfirmDialog, Field, Input, Select, Switch, Textarea, useToast } from "@/components/ui";
import { setProjectAccess, setProjectStatus, updateProjectDetails, type ProjectDetailsState } from "@/server/actions/projects";
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
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<AccessRow | null>(null);

  const term = query.trim().toLowerCase();
  const shown = useMemo(
    () => (term ? users.filter((u) => u.username.toLowerCase().includes(term) || u.name.toLowerCase().includes(term) || (u.role ?? "").toLowerCase().includes(term)) : users),
    [users, term],
  );

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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-full max-w-sm">
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search username, name or role"
            aria-label="Search users"
          />
        </div>
        <p className="text-xs text-[color:var(--color-muted-foreground)] tabular-nums" aria-live="polite">
          {term ? `${shown.length} of ${users.length} users` : `${users.length} user${users.length === 1 ? "" : "s"}`}
        </p>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] px-4 py-6 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
          {term ? `No user matches “${query.trim()}”.` : "There are no users yet."}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
          {shown.map((user) => (
            <li key={user.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-[color:var(--color-foreground)]">
                  {user.name || user.username} <span className="font-normal text-[color:var(--color-muted-foreground)]">@{user.username}</span>
                </p>
                <p className="text-xs text-[color:var(--color-muted-foreground)]">
                  Role: {user.role ?? "none"} <span aria-hidden>·</span> unchanged by project access
                </p>
                {user.hasAccess ? (
                  <p className="text-xs text-[color:var(--color-muted-foreground)]">
                    {PROJECT_ACCESS_LEVEL_LABELS[user.level ?? "FULL"]}: {PROJECT_ACCESS_LEVEL_DESCRIPTIONS[user.level ?? "FULL"]}
                  </p>
                ) : null}
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
                  onChange={(event) => (event.target.checked ? toggle(user, true) : setRemoving(user))}
                  aria-label={`${user.username} may enter this project`}
                  data-user={user.username}
                />
                {user.hasAccess ? "Has access" : "No access"}
              </label>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const user = removing;
          setRemoving(null);
          if (user) toggle(user, false);
        }}
        title={removing ? `Remove ${removing.name || removing.username}'s access?` : ""}
        description={
          removing
            ? `@${removing.username} can no longer enter this project, from their next request. Any Lead status or project role they hold here is removed too. Nothing they did here is deleted, and access can be given back at any time.${
                removing.isMainAdmin ? " As a Main Admin they can still enter every project." : ""
              }`
            : undefined
        }
        confirmLabel="Remove access"
        tone="danger"
      />
    </div>
  );
}

/**
 * Rename the project and edit its description. The slug is shown but not editable: it is the
 * project's address, and changing it would break every link anybody saved (see updateProjectDetails).
 */
export function ProjectDetailsForm({
  projectId,
  name,
  slug,
  description,
}: {
  projectId: string;
  name: string;
  slug: string;
  description: string | null;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [state, formAction, pending] = useActionState(
    (prev: ProjectDetailsState, formData: FormData) => updateProjectDetails(projectId, prev, formData),
    {} as ProjectDetailsState,
  );

  useEffect(() => {
    if (!state.savedAt) return;
    showToast({ tone: "success", title: "Project details saved" });
    router.refresh();
  }, [state.savedAt, showToast, router]);

  // Submitted from onSubmit rather than <form action>: React resets an uncontrolled form after an
  // action, which would throw away what was typed whenever the server refuses it.
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startActionTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Project name" htmlFor="project-name" required error={state.fieldErrors?.name} hint="Shown in the project switcher, the breadcrumb and the Main Admin portal.">
        <Input id="project-name" name="name" defaultValue={name} required maxLength={PROJECT_NAME_MAX} />
      </Field>
      <Field label="Address" htmlFor="project-slug" hint="The address cannot be changed — every saved link and bookmark uses it.">
        <Input id="project-slug" value={`/p/${slug}/`} readOnly disabled />
      </Field>
      <Field
        label="Description"
        htmlFor="project-description"
        className="sm:col-span-2"
        error={state.fieldErrors?.description}
        hint="Optional. Shown under the project's name on this page."
      >
        <Textarea id="project-description" name="description" defaultValue={description ?? ""} maxLength={500} className="min-h-20" />
      </Field>
      {state.error ? (
        <p role="alert" className="text-[13px] font-medium text-[color:var(--color-danger)] sm:col-span-2">
          {state.error}
        </p>
      ) : null}
      <div className="sm:col-span-2">
        <Button type="submit" loading={pending}>
          Save details
        </Button>
      </div>
    </form>
  );
}
