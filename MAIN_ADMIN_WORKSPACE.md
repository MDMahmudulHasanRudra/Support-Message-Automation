# Main Admin Workspace

**Status (30 Sep 2026):** built and verified locally, not pushed and not deployed.
- Every project module is project-tab based (§1–§4).
- Configuration (Departments, Job Titles, Employees), Users & Permissions, project access levels
  and the combined Overview figures are built too (§5–§7).
- One migration awaits deployment: `20260930120000_main_admin_configuration` (additive only).

Read `MULTI_PROJECT_PLAN.md` first: this builds on its isolation model and changes none of it.

## 1. What it is

The Main Admin has one unified workspace. They click a module once, and the projects they may use it
in appear as tabs. Clicking a tab opens that project's own page for that module:

```
Main Admin → Messages
[ ISP Digital ] [ Edufy ] [ Biznify ]                 Open in ISP Digital ↗
─────────────────────────────────────
(the project portal's own Messages page, for the selected project)
```

The project portal (`/p/<slug>/…`) is unchanged and remains the normal way in. The workspace is an
additional way to reach the same pages.

## 2. Architecture: one mechanism, no per-module code

```
/admin/workspace/<slug>/<any project page>
        │  proxy.ts: rewrite → /p/<slug>~ws/<page>, with x-softify-project = <slug>,
        │            x-softify-project-path = <page>, x-softify-workspace = 1
        │            (every incoming copy of all three is discarded first)
        ▼
app/p/[project]/(dashboard)/layout.tsx      the portal's OWN layout
        │  workspace mode: needs projects.view (else 404); a project that is not one of the
        │  viewer's → /admin/workspace?unavailable=1; then requireProjectPage() exactly as in the portal
        ▼
DashboardShell (workspace mode)             same shell, Main Admin chrome + <WorkspaceTabs/>
        ▼
the project's existing page                 its own permission check, the scoped client, triggers
```

- **No module is copied.** No route file exists per module or per project. Any page the portal has,
  the workspace has, including detail pages, settings, exports and server actions.
- **The project is a path segment.** A Server Action posts to the browser URL (the workspace URL),
  and the proxy rewrites that POST the same way, so the project travels with it.
- **Refresh and direct URLs work.** The URL is the whole state, so both come back to the same project.
- **`~ws` marker on the rewritten segment.** The router keeps a layout only while its segments are
  unchanged. Without the marker, "Open in ISP Digital" (workspace → the same page in the portal) kept
  the workspace chrome.
  - The marker is never authority: the project always comes from the header.
  - `/p/<slug>~ws/…` requested directly carries no project and is a 404.
- **Selected project persists across modules.** Every link on a workspace page is written in the
  same project (`ProjectLink` / `useProjectRouter` / server `projectPath()`), so a click from
  WhatsApp Chat to Messages keeps Edufy selected.
  - The `softify-workspace-project` cookie only picks the tab a module opens on from the Main Admin
    sidebar. It is ignored once the project is no longer the viewer's.

**Pieces**

| Piece | Role |
|---|---|
| `lib/workspace.ts` | URL parsing, the tab rule `workspaceTabsFor` (one function for every module), the global-page list, the `to=` sanitiser |
| `server/workspace.ts` | `workspaceProjects` (the tab source) and `chooseWorkspaceProject` (which project a module opens in) |
| `WorkspaceTabs.tsx` | the ONE tab component |
| `app/admin/workspace/page.tsx` | `?to=<page>` picks a project on the server and redirects; `?unavailable=1` says the project is not available, without saying why |

## 3. Tabs, permissions, features, access

Tabs = `user → may enter the project → the page's feature is on there → existing permission`.

- **Access.** `accessibleProjects`, the same list the project switcher uses. That is ProjectAccess
  rows, or every project for a Main Admin, and never an archived project. An inaccessible project
  never appears.
  - Typing its URL, or keeping a tab open after access is removed, lands on "not available".
  - A replayed action is refused by the project step.
- **Features.** A project with the page's feature switched off gets no tab on that page.
  - Opened by URL anyway, the portal's own feature gate sends it to that project's Overview with the
    reason.
  - The workspace sidebar hides a module only when it is off in every project. A link to a module
    that is off in the current project opens `/admin/workspace?to=…`, which chooses a project that
    has it.
- **Permissions.** Unchanged and final. A module the role lacks opens nowhere. Its page by URL is
  refused by the page's own check. Actions keep their own keys (e.g. `messages.reply`).
- **Lifecycle.**
  - Suspended projects keep their tab, with a badge, and are read-only as in the portal.
  - Archived projects are not tabs.
- **"Open in <project>"** goes to the same page in that project's normal portal.
- **Read/Write/Full** access levels narrow the role inside one project; see §6.

## 4. Module classification

**Project-tab modules.** These are every project page in the navigation:
- Project Overview
- Support: WhatsApp Chat, Messages, Escalations
- Team: Today, Roster, Leave, Team Performance, Activity Feed
- Reports
- WhatsApp: Accounts, Groups, Team Members, Teams, Broadcast, Add Number to Groups
- Automation: Rules, Rule Tester, Automation Control
- AI Learning
- Conversation Learning
- System: Notifications, System Logs, Settings, and every project settings page

**Global.** These have no tabs, because their tables carry no `projectId`. They open in the workspace
with the note "The same in every project":
- App Users
- Permission Modules
- Security settings
- Release Notes

These live under MAIN ADMIN in the sidebar (`GLOBAL_PAGE_PREFIXES`).

**Main Admin's own pages:**
- Admin Overview, with the combined figures (§7)
- Projects
- Configuration (§5)
- Users & Permissions (§5)

## 5. Configuration and Users & Permissions

**Configuration** (`/admin/configuration`, keys `configuration.view` / `configuration.manage`, both in
the Main Admin category so no default role but Administrator gets them):

| Entity | What it is | Never |
|---|---|---|
| `Department` | a department of the organisation (name, optional code) | the WhatsApp support `Team` (per project, with membership history) |
| `JobTitle` | a label for a person | a role — it grants nothing |
| `Employee` | the person: name, email, phone, department, job title, joined on, optional login | the login (`User`) or a WhatsApp roster entry (`InternalTeamMember`) |

- All three are platform-level: no `projectId`, so no project tabs.
- A department or job title somebody is filed under can only be deactivated. An unused one can be
  deleted. Employees are only ever deactivated.
- **Employee ID:** `EMP-000001` onward, from the `employee_code_seq` sequence, read in the same
  transaction that creates the employee.
  - Unique even for simultaneous creates.
  - Never reused, never edited.
  - A CHECK constraint refuses any other shape.
- **User ID:** logins keep their existing unique `id` and `username`. The person's identifier is
  the employee ID; the two are deliberately separate.

**Users & Permissions** (`/admin/users`) shows each login with its employee, role and project access.
Each part is changed only with the EXISTING key for that part:

| Part | Key |
|---|---|
| create the login | `users.create` |
| change the role | `users.edit` (never your own) |
| project access and levels | `projects.manage` |
| the employee record | `configuration.manage` |

- **New user** creates all four in ONE transaction: the employee (new, existing, or none), the
  login, the role and the per-project access. An invalid part saves nothing.
- The user page edits the role, the employee link and a project × level grid.
- Password resets, sessions and deactivation stay on the existing App Users page, linked from there.
- Roles themselves stay on Permission Modules.

## 6. Project access levels

`ProjectAccess.level`: READ, WRITE, FULL, or null. **Null is FULL**, which is what every existing row
has, so nobody's rights changed. A level only ever narrows the role:

```
may do X in project P  =  role grants X  AND  level(P) allows X
```

| Level | Allows of the role |
|---|---|
| Read | `.view` and `.bulk_export` keys only |
| Write | also day-to-day work (reply, edit rules and groups, broadcasts), but not `*.delete`, `settings.edit` or `ai_settings.edit` |
| Full | the whole role, never more |

- **Global keys are not affected**, because their data belongs to no project: users, permissions,
  security settings, release notes, and the Main Admin keys.
- **Where it is enforced:** in `hasPermission` / `requirePermission`
  (`apps/web/src/server/permissions.ts`), which every page, action and `checkPermission` asks. So no
  caller can forget it.
- **Refusals name the level:**
  - `checkPermission` returns "Your access to X is Read, which does not include this…".
  - A page redirect carries `&level=`, and the Overview explains it.
- **The shell is filtered too:** `getGrantedPermissionKeys` applies the level, so the shell does not
  offer what the level refuses. That is presentation only.
- **Main Admins:** a Main Admin with no access row enters as FULL. A level on their own row still
  applies, because Full is never a bypass.
- **Where it is edited:** a project's page (level beside each user) and a user's page (project grid).
- **Rules:** `packages/shared/src/projectAccessLevels.ts`, tested against every key in the catalogue.

## 7. Combined figures on the Admin Overview

"Across your projects" sums, for today:
- WhatsApp connected / total
- messages
- open escalations
- support activity
- AI answers
- monitored groups
- active team members

The sum covers only the projects the viewer may ENTER (`combineKpis` in `server/mainAdmin.ts`).
Projects that are listed but that the viewer cannot enter are left out, and the page says so. Every
figure is a count the project's own pages already show; there are no new definitions.

## 8. Verification (30 Sep 2026)

| Suite | Result |
|---|---|
| Unit: `workspace.test.ts` | 20 |
| Integration, isolated DB: `workspaceProjects.integration.test.ts` | 10 |
| Browser checks, dev server on the throwaway DB, 4 projects and 3 roles | 72/72 |

**Unit tests** cover:
- URL parsing;
- links in every module;
- the tab rule applied to every nav page and every feature route;
- the global-page list;
- the `to=` sanitiser;
- the proxy rewrite, POSTs, forged headers, and the `~ws` route requested directly.

**Integration tests** cover:
- the access, feature, archived, suspended and Main Admin cases;
- revocation;
- the module chooser against permissions.

**Browser checks** cover:
- tabs and per-project data for Chat, Messages, Groups, Rules and Knowledge;
- 9 more modules opening with tabs;
- refresh;
- project kept across modules;
- a feature-off module opening elsewhere;
- the feature gate by URL;
- a global page without tabs;
- "Open in", including soft navigation;
- a reply landing in the tab's project;
- a 2-project user never seeing the others, by tab or URL;
- 3 action replays and a replay after revocation, all refused with zero rows;
- the permission gates;
- no workspace without `projects.view`;
- suspended and archived projects;
- the portal unchanged on 4 pages;
- no horizontal scroll at 390px.

**Mutation checks:**
- removing the proxy's workspace-header strip fails 2 unit tests;
- dropping the feature filter fails 4 unit tests and 3 integration tests.
