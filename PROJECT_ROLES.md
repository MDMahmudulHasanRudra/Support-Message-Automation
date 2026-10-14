# Two-level permissions: platform roles, project roles and project Leads

Status: built 14 Oct 2026 (migration `20261014100000_project_roles`). Off nobody: it changes nothing
for any existing user until a Main Admin makes someone a Lead or a project role is given.

## The two levels

| Level | Who | Decides | Where it is stored |
|---|---|---|---|
| Platform | Main Admin (a global role holding `projects.manage`, i.e. Administrator) | projects, features, who may enter which project, who leads it, platform roles, every login | `User.permissionModuleId` (Permission Module), `ProjectAccess`, `ProjectFeature` |
| Project | the project's **Lead**, and Main Admins | that project's members, its project roles, and each member's role in it | `ProjectRole`, `ProjectMemberRole` (both project-owned) |

`ProjectAccess` is unchanged and still says only **who may enter**. The project-level role lives in
`ProjectMemberRole` (one row per user per project, unique), so access and permission stay separate
questions (MULTI_PROJECT_PLAN.md §7).

## How a user's rights in one project are worked out

`resolveRoleKeys` (`packages/shared/src/projectRoles.ts`), the single place, used by
`requirePermission`, `hasPermission`, `permissionRefusal` and `getGrantedPermissionKeys`
(`apps/web/src/server/permissions.ts`):

1. A Main Admin: their global role, unchanged, in every project.
2. No `ProjectMemberRole` row (every user before this existed): their global role, **exactly**.
3. Otherwise: the platform part of the global role (Main Admin keys, App Users / Permission Modules /
   Security, release-note editing) **+** the project part — the project role's keys if one is set,
   else the global role's project keys **+**, for the Lead, every project key and this project's
   administration (`project_members.manage`, `project_roles.manage`).

Then, unchanged: the access level narrows (READ / WRITE / FULL), a feature the Main Admin switched
off stays off, and a suspended or archived project is read-only. **A disabled feature cannot be
re-enabled by any role.**

## Rules worth not undoing

- **A project role never holds a platform key.** Filtered on every write and read
  (`isProjectAssignableKey` / `sanitizeProjectRoleKeys`), and the database refuses the dangerous ones
  (`ProjectRole_no_platform_keys` CHECK).
- **A member's project role is always a role of the same project** (`ProjectMemberRole_projectRoleId_same_project`
  trigger), and neither table's `projectId` can change (Phase 7 triggers).
- **Only a Main Admin designates a Lead** (`setUserLead`, needs `projects.manage`). Making someone Lead
  grants access with FULL; removing someone's access removes their project-level role too, so a
  re-grant never revives an old Lead flag.
- **What a Lead may do to a member** is `projectMemberActions` (pure, tested), applied by the page and
  by every action: never themselves, never another Lead, never a Main Admin or anybody with a
  privileged global role; role and removal for any other member of their project; the password and
  active state only of a login that belongs to their project alone (no other project, no global role).
- **The project-administration keys are privileged on a platform role** (`privilegeGuard`): putting
  them in a global role makes someone the administrator of every project they enter, so only a Main
  Admin may.
- **Passwords cannot be viewed by anybody.** They are stored as a one-way hash; reset instead (signs
  the member out everywhere).
- **Users are deactivated, not deleted** — their history (rules, sends, activity) keeps its owner.

## Pages

- `/p/<slug>/project-members` — members, their project role, add a member (creates a login for this
  project only), remove, reset password, deactivate. Key `project_members.manage`.
- `/p/<slug>/project-roles` (+ `/new`, `/<id>`) — the project's roles; modules grouped by category,
  each permission marked Read or Write. Key `project_roles.manage`.
- Main Admin Portal → Users → a user: a **Lead** switch per project; New user: **Project Lead** in
  the per-project access choice.

A Lead signs in and lands in their project (`/open`); they see another project only if a Main Admin
gave them access to it.

## Operations

- **Kill switch:** `PROJECT_ROLES_DISABLED=true` on the `app` service. Everybody is governed by their
  global role again; nothing is deleted, and unsetting it restores project roles. Web only.
- **Deploy:** the change is web + an additive migration. The worker reads none of these tables. Deploy
  `migrate` and `app` only (`docker compose up -d --build --no-deps migrate app`); do not recreate the
  `worker`, which would restart the live WhatsApp sessions.
- **Seed:** now add-only (audit finding 2). Administrator always holds every key; other default roles
  only receive keys new in that run; nothing is ever removed, so an edited default role survives
  deploys. A key introduced by a migration grants itself in that migration.
- **Compatibility check before enabling Leads in production:** on a restored copy, every existing
  user's `getGrantedPermissionKeys` per project must equal their global role (guaranteed by rule 2,
  pinned by `projectRoles.test.ts` over 300+ role shapes).

Tests: `packages/shared/src/__tests__/projectRoles.test.ts`, `apps/web/src/__tests__/projectRoles.integration.test.ts`.
