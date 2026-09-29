# Main Admin Workspace

**Status (30 Sep 2026):** every project module is project-tab based. This is verified locally but
not pushed and not deployed. There is no migration. The first version (WhatsApp Chat only, 29 Sep)
was a proof of concept, and it has been replaced by the general mechanism below. Read
`MULTI_PROJECT_PLAN.md` first: this builds on its isolation model and changes none of it.

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
- **Read/Write/Full** is not introduced. It stays a design note: see git history of this file,
  29 Sep.

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
- Admin Overview (functional, unchanged)
- Projects

Configuration (Departments / Job Titles / Employees) is not built, so there is no nav entry for it
(see §5).

## 5. Deferred

- **Configuration:** Departments, Job Titles and Employees are new entities. They need a migration
  and a design decision; the findings are in this file's 29 Sep version.
- **Cross-project KPI dashboard on Admin Overview:** later task, as asked.
- **Users & Permissions** is the existing global pages, reached through the workspace. No
  project-access editing was added there. It still lives on each project's page under Projects.

## 6. Verification (30 Sep 2026)

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
