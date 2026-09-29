# Main Admin Workspace

Status: **Stages 1–4 implemented and verified locally on 29 Sep 2026. Not pushed, not deployed.**
The four stages are the workspace shell, the reusable project tabs, WhatsApp Chat as the first
module, and a verification of project switching. No migration was needed, so none was created.
Stages 5–8 are designed below but not built. Read `MULTI_PROJECT_PLAN.md` first: this builds on its
isolation model and changes none of it.

## 1. What it is

The Main Admin Portal (`/admin`) gains a **Workspace** section. A workspace module is an EXISTING
project module, such as WhatsApp Chat. It opens with one tab per project the viewer may use it in:

```
/admin/workspace/whatsapp-chat                          → opens the remembered or first tab
/admin/workspace/whatsapp-chat/isp-digital              → ISP Digital's inbox
/admin/workspace/whatsapp-chat/bizify/<groupId>         → one Bizify conversation
```

**A tab is the project's own page.** Nothing about the inbox is re-implemented:
`app/admin/workspace/whatsapp-chat/[project]/` holds a layout that wraps the portal's own chat layout,
and three one-line pages that re-export the portal's pages. Data is never merged across projects.
Each tab reads through the scoped client, in exactly one project.

The project is a **path segment**, not the `?project=` query sketched in the request. A Server Action
posts to the page's path, and the project must travel with it the way it does in `/p/<slug>/…`.

## 2. Architecture audit (the six questions)

| # | Question | Answer |
|---|---|---|
| 1 | Reusable as it is | `accessibleProjects` (tab source); `disabledFeaturesFor` (feature filter); `hasPermission` / `requireProjectPage` / `requireAccess` (every check); the scoped Prisma client; `ProjectSwitcher`; `AdminShell`; the whole chat module (layout, pages, actions, `chatInbox.ts`). `getProjectSummaries` for the future aggregate dashboard. |
| 2 | Needs new entities | None for Stages 1–4. Later: `Department`, `JobTitle`, `Employee` (Stage 6), and an optional access level on `ProjectAccess` (§4). |
| 3 | Needs new routes | `/admin/workspace`, `/admin/workspace/whatsapp-chat`, `/admin/workspace/whatsapp-chat/[project]` (+ `/[groupId]`, `/archived`). Later: `/admin/configuration/*` and `/admin/users`. |
| 4 | Needs new permissions | None. The workspace sits under `/admin` (`projects.view`). Each module uses its existing key (`messages.view`, `messages.reply`). Stage 6 would add `configuration.view` / `configuration.manage`. |
| 5 | Needs migrations | None for Stages 1–4. Stage 6 would need new tables, and access levels a new nullable column; both are additive. |
| 6 | Could conflict with permissions | Only the access levels, if built wrong. They must only ever remove rights (§4). Also, in the portal, "Teams" already means WhatsApp support teams (`Team`, `TeamMembership`, `InternalTeamMember.teamId`), and "role" already means the permission role. So departments and job titles must be new entities, not new meanings (§5). |

## 3. How a tab is checked

```
proxy.ts            /admin/workspace/<module>/<slug>/<rest>
                    → x-softify-project = <slug>, x-softify-project-path = <module path><rest>,
                      x-softify-workspace-module = <module>. Every incoming copy of each header is
                      discarded first, exactly as for /p/<slug>/…
admin layout        projects.view (the portal gate, unchanged)
workspace frame     1. the slug must be one of the viewer's tabs (below), otherwise → the module's
                       start page, "not available here"
                    2. requireProjectPage() — the portal's own gate: access (404), feature (redirect)
module pages        their own pageAccess / requireAccess, unchanged (messages.view; messages.reply
                    decides whether the composer can send)
Server Actions      checkPermission / requireAccess in the project the URL names; the scoped
                    client and Phase 7's database triggers underneath, unchanged
```

**Tabs** (`server/workspace.ts`) apply `user → may enter the project → feature enabled → existing
permission`. Each step can only remove a tab. No permission means no tabs in any project, because
roles are the same in every project. An archived project is never a tab. A suspended one is shown with
its badge, and is read-only exactly as in the portal.

**Selected project.** The `softify-workspace-project` cookie (path `/admin`) only chooses which tab
`/admin/workspace/<module>` opens. A remembered project that is no longer a tab is ignored. The cookie
never decides a read or a write; the URL does.

**Revocation.** Tabs are computed on every render, including the chat's 4-second refresh. So a tab
whose access was removed goes back to the start page on the next refresh, after at most the 5-second
access cache. A replayed action is refused by the same check.

**Links inside a module.** `ProjectLink`, `useProjectRouter` and the server's `projectPath()` keep
the module's own paths in the workspace (`/chat/x` → `/admin/workspace/whatsapp-chat/<slug>/x`).
Every other path goes to the SAME project's portal (`/groups` → `/p/<slug>/groups`).

**Switcher and tabs coexist.** The switcher (top of the sidebar) moves between whole portals. The
tabs move between projects inside one module.

**Adding a module:** one entry in `WORKSPACE_MODULES` (`lib/workspace.ts`) with its path, feature and
permission. Then a route folder whose files re-export the portal's pages, and an icon in `AdminShell`.
`workspace.test.ts` checks that the module's path belongs to its feature, so switching the feature off
also closes the workspace page.

## 4. Project access levels (Read / Write / Full): design only, not built

**Rule: a level can only take away. It never grants.** What a user may do in a project is:

```
effective = (existing permission granted by the role)  AND  (level allows that kind of action)
```

| Level | Allows | Never |
|---|---|---|
| Read | `.view` and export keys only (the same split `isReadKey` in `authorize.ts` already makes for suspended projects) | any write, whatever the role says |
| Write | everything the role grants except `.manage` / delete / settings keys (list to be fixed when built) | anything the role does not grant |
| Full | exactly what the role grants | anything beyond the role. Full is NOT a bypass |

- **Storage:** a nullable `ProjectAccess.level` column, where null means Full. Every existing row
  therefore behaves exactly as today, and the migration is additive with no backfill.
- **Enforcement:** one place, `checkPermission` / `requireAccess`, after the permission check and
  beside the existing read-only-project check, which is the same shape. Presentation (tabs, nav) would
  read it too, but never as the check.
- **Main Admin:** there is no `ProjectAccess` row, so the level is Full, which is still bounded by the
  role.
- **Not built** because the request asked for the design to be documented first. The Write/Full
  boundary needs a decision on which keys count as "manage".

## 5. Configuration, users and IDs: findings for Stages 6–7

- **Teams ≠ Departments.** `Team` is already the WhatsApp support team (per project, with
  `TeamMembership` history used by Team Report). Do not redefine it. Departments should be a separate
  platform-level `Department` entity.
- **Existing free text.** `InternalTeamMember.department` and `InternalTeamMember.role` are free-text
  columns today. They are the obvious migration source for `Department` and `JobTitle`. Keep them
  until the new entities are adopted.
- **Job Title ≠ Role.** "Role" in this codebase is the `PermissionModule` a `User` holds. A job title
  grants nothing.
- **Three identities, kept separate:**
  - `User` is a login. It is platform-wide, has a `cuid` id and a unique `username`.
  - `InternalTeamMember` is a WhatsApp roster entry. It is per project and has a `cuid` id.
  - `Employee` would be the person. It is new, platform-wide, and links optionally to one `User` and
    to `InternalTeamMember` rows in any project.
- **IDs.** No human-readable ID exists anywhere today. Recommendation: an `employeeCode` such as
  `EMP-000123`, from a Postgres sequence. It is unique and deterministic, never reused, and
  independent of the username (which can change) and of the `cuid` (which is not for people).
- **Current behaviour worth knowing:** `createUser` (`server/actions/users.ts`) grants no
  `ProjectAccess`. A new non-admin user therefore sees "No project access" until a Main Admin adds them
  on the project's page. Stage 7's user creation should set project access in the same step.
- **Aggregate dashboard (Stage 5).** `/admin`'s Overview already aggregates counts across projects,
  but it lists every project to anyone with `projects.view`. It marks the ones they cannot enter
  rather than hiding them, which was the Phase 4 design. Before building the aggregate dashboard,
  decide whether it should list authorized projects only. `getProjectSummaries` would then filter on
  `canEnter`.

## 6. Verification (29 Sep 2026)

| Suite | Result |
|---|---|
| Unit: `apps/web/src/__tests__/workspace.test.ts` | 12 |
| Integration, isolated DB: `workspaceTabs.integration.test.ts` | 8 |
| Browser checks, dev server on the test DB | 33/33 |

**Unit tests** cover URL parsing, link rewriting and proxy headers, including forged headers stripped
on workspace and non-workspace URLs.

**Integration tests** cover:
- access, feature, archived, suspended and Main Admin;
- a role without the permission;
- revocation and re-enabling;
- an inactive user.

**Browser checks** cover:
- tabs per user;
- switching between projects;
- links staying in the workspace;
- a reply from the Bizify tab landing in Bizify;
- the selected project persisting;
- disabled-feature and unknown projects;
- a read-only role seeing no composer;
- four action replays refused with zero rows: a foreign URL, a swapped group id, a forged header and
  the portal URL;
- a stale tab and a replay after revocation;
- a role without `messages.view`;
- no horizontal scroll at 390px.

**Mutation checks:**
- removing the proxy's header stripping fails the unit suite;
- loosening the path match fails it;
- dropping the feature filter fails the integration suite;
- dropping the permission filter fails it too.
