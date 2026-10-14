# Two-level permissions: platform roles, project roles and project Leads

Status: built 14 Oct 2026 (migration `20261014100000_project_roles`); page-level roles added 15 Oct
2026 (migration `20261015100000_project_role_sections`, see "Pages" below). It changes nothing for any
existing user until a Main Admin makes someone a Lead or a project role is given.

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

## Pages: which modules and sub-modules a role opens

A project role chooses, for every module of the sidebar and every page in it, **Hidden**, **Read**
(open and look) or **Full** (also change things there) — and which parts of the **Dashboard** (the
Overview) it shows: things that need attention, summary numbers, metrics and charts, module status
cards, the live message stream. Members see only those pages in the sidebar, the settings rail, the
tabs and ⌘K; every other page is refused with a banner saying the Lead decides.

**The catalogue is the sidebar.** `apps/web/src/app/p/[project]/(dashboard)/projectSections.ts`
derives the modules and pages from `NAV_GROUPS`, `SETTINGS_SECTIONS` and the report catalogue, in the
same order and under the same names. Pages whose key is the platform's (App Users, Permission Modules,
Security, this project's members and roles, release-note editing) are not offered. Written by hand,
in `SECTION_RULES`, is only what the sidebar cannot say: which keys a page's changes need, and the paths
that belong to a page without being its link (detail pages, legacy redirects, export routes). A page
that only opens to change something (New broadcast, Add Number to Groups, Import, Shifts…) offers Full
only; a read-only page offers Read only. A detail page shared by several tabs (a Support Assignment case)
opens when any of them is given.

**Stored as pages; the keys follow.** `ProjectRole.sectionAccess` is `{ "<page path>": "READ" | "FULL",
"dashboard:<part>": "READ" }`. `ProjectRole.permissionKeys` is DERIVED from it on the server
(`keysForSectionAccess`) — the form's own key list is ignored — so the two cannot disagree. "Fine-tune"
can only hold back a write key of a Full page (e.g. edit clients, never delete them); reading cannot be
held back. Both are sanitised on every write and read; a CHECK keeps `sectionAccess` an object.

**Who it applies to.** Only a member whose project role has a page selection. Never a Lead, a Main Admin,
a user on their global role, or a role saved before pages existed (`sectionAccess` null — its keys alone
decide, exactly as before). Editing such a role starts from the pages its keys opened
(`sectionAccessFromKeys`); saving converts it.

**Enforcement** (`server/permissions.ts`, `server/authorize.ts`):

1. **The page step** — `requireProjectPage` refuses a page the selection does not open (with
   `/overview?page=…`). It runs for every page, including pages that check no key (the reports hub,
   legacy redirects). The Overview always opens, so it never loops; an unknown page fails closed.
2. **Every permission check** (`checkPermission`, `requireAccess`, `pageAccess`, `hasPermission`) also
   asks: is the page this request is for (or a Server Action was posted from, `x-softify-project-path`)
   granted — Read to read, Full to change? A Read page therefore renders view-only (`canManage` false).
   Platform keys are never affected. A request with no page (an OAuth callback, `after()`) can only read
   unless the action names its pages.
3. **Actions bound to their own page.** Sibling pages share keys — Accounts, Groups, Team Members and
   Teams all use `whatsapp.manage` — so the highest-risk actions name their page and need IT at Full,
   wherever they are posted from: Accounts (connect, logout, delete…), Automation Control (kill switch,
   mode), safety settings, New broadcast, Add Number to Groups, Groups Admin Maker, AI Providers
   (`checkPermission(key, { sections: [...] })`). Every other action is held by the page it is posted
   from: through the app a member can only change what is on a Full page. A member who crafts a request
   by hand, from a Full page, to an unbound action of a sibling page that uses the same key is NOT
   stopped by the page side — only by the key. Bind an action with `{ sections }` to close that for it;
   `projectSections.test.ts` checks that every bound file is bound to the pages that import it.

**The Overview** shows only the chosen parts; a link to a page the role does not open is left out rather
than offered and refused. With no part chosen it is "Your pages": the member's pages, by module, marked
Read or Full.

**Adding a page:** put it in the sidebar as before. If it changes something, add its write keys to
`SECTION_RULES`; if it has detail pages or export routes outside its path, add them under `also`.
`projectSections.test.ts` fails until every page file and export route under `app/p/[project]` belongs
to a page, every project key a page checks is given by its page, and every project key can be given
somewhere.

**Kill switch for the page side only:** `PROJECT_ROLE_PAGES_DISABLED=true` on `app` — roles keep their
keys, the selection is ignored (sidebar and pages as before). `PROJECT_ROLES_DISABLED=true` still turns
off project roles entirely.

## Pages of this feature

- `/p/<slug>/project-members` — members, their project role, add a member (creates a login for this
  project only), remove, reset password, deactivate. Key `project_members.manage`.
- `/p/<slug>/project-roles` (+ `/new`, `/<id>`) — the project's roles: the module → page tree with
  Hidden / Read / Full at every level (module, sidebar entry with tabs, page), "Find a page", Read/Full
  everything, the Dashboard parts, and Fine-tune. Key `project_roles.manage`.
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

Tests: `packages/shared/src/__tests__/projectRoles.test.ts`, `apps/web/src/__tests__/projectRoles.integration.test.ts`,
`apps/web/src/__tests__/projectSections.test.ts` (the catalogue against every page file, export route and
bound action), `apps/web/src/__tests__/projectRolePages.integration.test.ts` (two projects, through the
real checks). Each protection was confirmed to fail its test when removed (13 mutations).
