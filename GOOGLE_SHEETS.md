# Google Sheets — work management and monitoring

**Status (9 Oct 2026): all ten phases are built and tested.**

- Phases 1–2 and 5 (accounts, the list, members) — §12, §13, §15.
- Phase 3, the editor — §16. Phase 4, a person's own Google identity — §17.
- Phases 6–7, the activity log and work / viewing time — §18. Phase 8, changes made in Google — §19.
- Phases 9–10, the employee and sheet reports — §20.
- **Real-Google validation happens live** (§21): every Google answer in the tests is a fake modelled on
  Google's documentation, and §3's open question (`people/<id>` = sign-in `sub`) is now checked by the
  worker itself before anything is credited.
- **§3 records what Google can and cannot tell us about who did what.** Every attribution rule follows
  from it.

The module is **additive**. It changes nothing in WhatsApp, automation, AI, support assignment, the
permission system or any project's behaviour, and it is **off in every project** until a Main Admin
switches it on (Main Admin → Projects → a project → Features → Google Sheets).

---

## 1. What it is for

A team keeps work in Google Sheets: order lists, customer follow-ups, collections. This module lets
them:

- connect the Google accounts those sheets live in, through Google's own sign-in screen — no service
  account, no sharing every sheet with a robot, no spreadsheet IDs typed by hand;
- find and open those sheets inside the app, and edit them there;
- record who did what, and for how long they actually worked.

### Sheets are shared team work

A spreadsheet is usually not one person's. A Lead creates it, shares it with several team members
who edit it, keeps editing it themselves, and shares it with a CTO or manager who only looks.

```
Daily Client Follow-up
  Editors:  Rudra (Lead) · Borhan · Istiyak · Khairul
  Monitor:  CTO
```

So the module never assumes any of these:

- **The Google account that owns the file is the person who works on it.**
- **The person who created the file is the one responsible for it.**
- **The Google account that connected the file to the app did the edits made through it.**

Every piece of work is attributed to the person who did it, or to nobody.

### Two kinds of activity are kept apart everywhere

| Kind | What it is |
|---|---|
| **Application activity** | Done in this app by a signed-in person. Exact: who, when, which tab and range, and time from real interaction. |
| **External Google activity** | Done in Google Sheets directly. Google says an edit happened and, sometimes, which Google account did it — never for how long, and never which cells (§3). |

And within application activity, **viewing is not working**. A CTO who keeps a sheet open for
30 minutes to review it has 30 minutes of viewing and 0 minutes of work, unless they change something.

---

## 2. Architecture

**Phases 1–7 run entirely in apps/web, in `apps/web/src/server/google/`.** That folder is the only
code that talks to Google:

- `oauth.ts` — configuration, the consent URL, PKCE and the sealed state.
- `api.ts` — the HTTP calls, with plain `fetch`. There is no `googleapis` SDK, the same choice as
  `packages/forge-client`.
- `accounts.ts` — the account store, and the only reader of tokens.
- `spreadsheets.ts` — the spreadsheet list (Phase 2).

- `editor.ts`, `editorAccess.ts` (Phase 3), `identity.ts` (Phase 4), `activity.ts`, `sessions.ts`,
  `settings.ts` (Phases 6–7), `reports.ts`, `reportTables.ts` (Phases 9–10).

**Phase 8 (external activity) is the one background poller, in the worker**
(`apps/worker/src/googleSheets/`). It carries its own two Google calls (token refresh, Drive Activity)
rather than a shared `packages/google-client` — §19 says why.

The rest follows the usual conventions:

- **Database-mediated.** The web and the worker never talk over HTTP.
- **Project-scoped.** Every table carries `projectId` and is read through the scoped client.
- **Owned by `GOOGLE_SHEETS`.** It is one entry in `packages/shared/src/projectFeatures.ts`, with
  `defaultEnabled: false`.

### Tokens are per account, per project

- **A project connects Google accounts.** People in the project work through them, each as
  themselves in the app.
- **Google sees the account, not the person.** Every edit made through the app appears in Google's
  own version history as the connected account whose token was used. Who actually pressed Save is
  recorded by the app (Phase 6), and that record is the source of truth for application work.
- **The person who connected an account (`connectedById`) is an audit fact**, never the account's
  owner and never the person responsible for its sheets.

---

## 3. What Google can tell us about who did what

Checked against Google's API reference on 9 Oct 2026, before Phase 2 (sources at the end of this
section). This decides every attribution rule in the module.

| Question | Where Google answers it | How reliable | What the module does |
|---|---|---|---|
| **Who did this edit in the app?** | Nowhere — the app made the call | **Exact.** The app knows the signed-in person, the time, the tab and the range | Records it (Phase 6) against that person. Never against the connected Google account |
| **Who has access to the file in Google, and as what?** | Drive `permissions.list` → per grantee: type, role (`owner` / `writer` / `commenter` / `reader`; shared-drive roles), `emailAddress`, `displayName` | **Good, but not always visible.** The file's `permissions` field is "only available if the requesting user can share the file". Whether a reader may call `permissions.list` is not stated and must be checked live | Shown beside the app's own members as a guide (Phase 5). **Never** turned into app membership automatically. Read only through an account whose `canShare` is true |
| **What may this connected account do?** | Drive `files.list` → `capabilities.canEdit` / `canShare` | **Exact** for that account | Stored per account and sheet (`GoogleSpreadsheetAccess`, Phase 2) |
| **Who changed the file last?** | Drive `lastModifyingUser` | **Weak.** One person for the whole file, only the latest change, "only populated when the last modification was performed by a signed-in user". Its email "may not be present … if the user has not made their email address visible" | Shown in the list as Google's statement, labelled "(Google)". **Never used to attribute work** |
| **Who edited the file outside the app, and when?** | Drive Activity API v2 `activity:query` → per activity: `actors[]`, `primaryActionDetail`, `timestamp` or `timeRange` | **Partial** (details below) | Phase 8. Attributed only through a verified identity link, otherwise **unattributed** |
| **Which cells did they change in Google?** | **Nowhere.** Drive Activity's `Edit` is "an empty message indicating an object was edited". The Sheets API has no edit history; per-cell history exists only in the Sheets UI | **Not available** | Recorded only as "edited the file at T". Ranges exist only for edits made through the app |
| **How long did they work in Google?** | **Nowhere** | **Not available** | External activity never contributes work time |
| **Who viewed the file in Google?** | Not in Drive Activity (no view action exists). Only the Workspace **Admin SDK Reports API** has Drive `view` events — administrator-only, Workspace domains only, 180 days | **Not available** to this app | Viewing is recorded only for viewing **in the app**. A CTO reading the sheet in Google directly is invisible, and the reports say so |
| **Version history with authors?** | Drive `revisions.list` → `lastModifyingUser` per revision | **Weak.** Needs writer access; "might be incomplete … older revisions might be omitted". Google files' revisions are merged | Not used |

### Drive Activity in detail (Phase 8)

- **Actor types:** `user`, `anonymous`, `impersonation`, `system`, `administrator`.
  - A `user` is one of:
    - `knownUser` — `personName` in the form `people/ACCOUNT_ID`, plus `isCurrentUser`, true when
      it is the account asking;
    - `deletedUser` — no fields;
    - `unknownUser` — "a user about whom nothing is currently known", no fields.
  - For `impersonation`, "information about the acting admin is not currently available".
- **Actions:** `create`, `edit`, `move`, `rename`, `delete`, `restore`, `permissionChange`, `comment`,
  `dlpChange`, `reference`, `settingsChange`, `appliedLabelChange`. **There is no "view".**
- **Grouping:** "a single Drive activity comprising one or more Actions by one or more Actors". With a
  consolidation strategy, "multiple Actors editing one item" become ONE activity over a time range.
  The module would query with no consolidation, and still treats an activity naming more than one
  actor as unattributable to any one of them.
- **Visibility:** "some activity on Drive might not be reported". The connected account sees history
  only for the period it had access.
- **Scope:** `drive.activity.readonly`, which is a restricted scope (§4).

**Turning `people/ACCOUNT_ID` into an email is not reliable.** Google does not document what the
People API returns for another person's account without a contacts or directory relationship.

**The one reliable bridge is the person's own Google sign-in.** When somebody signs in to the app
with Google (openid + email only), Google tells us their account id (`sub`). The plan rests on
`people/ACCOUNT_ID` and `sub` being the same number for the same account. That is very likely, but
**Google does not document it**, so before Phase 8 attributes anything it must be checked live:

1. A connected account edits a sheet.
2. Its own activity (`isCurrentUser: true`) shows `people/<id>`.
3. That `<id>` must equal the `sub` stored for that account.

If they differ, every external edit stays unattributed. Attributing work to the wrong employee is
worse than not attributing it.

### Edits made through the app show up in Google too

They appear in Drive Activity as the **connected account**. Phase 8 must not count them a second time
as external work: an external activity by the connected account itself (`isCurrentUser`), on the same
file, overlapping one of the app's own recorded writes, is linked to that write and not counted again.

### Sources

- Drive Activity v2: [activity.query](https://developers.google.com/workspace/drive/activity/v2/reference/rest/v2/activity/query),
  [DriveActivity](https://developers.google.com/workspace/drive/activity/v2/reference/rest/v2/activity/driveactivity),
  [Actor](https://developers.google.com/workspace/drive/activity/v2/reference/rest/v2/activity/actor),
  [User / KnownUser](https://developers.google.com/workspace/drive/activity/v2/reference/rest/v2/activity/user),
  [ActionDetail](https://developers.google.com/workspace/drive/activity/v2/reference/rest/v2/activity/actiondetail),
  [Edit](https://developers.google.com/workspace/drive/activity/v2/reference/rest/v2/activity/edit),
  [Impersonation](https://developers.google.com/workspace/drive/activity/v2/reference/rest/v2/activity/impersonation),
  [overview](https://developers.google.com/workspace/drive/activity),
  [data model](https://developers.google.com/workspace/drive/activity/v2/datamodel)
- Drive v3: [files](https://developers.google.com/workspace/drive/api/reference/rest/v3/files),
  [User](https://developers.google.com/workspace/drive/api/reference/rest/v3/User),
  [permissions](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions),
  [permissions.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/list),
  [roles](https://developers.google.com/workspace/drive/api/guides/ref-roles),
  [revisions](https://developers.google.com/workspace/drive/api/guides/manage-revisions)
- [People API people.get](https://developers.google.com/people/api/rest/v1/people/get);
  [Admin SDK Reports — Drive audit events](https://developers.google.com/workspace/admin/reports/v1/appendix/activity/drive)
- Scope classes: [Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

---

## 4. Google APIs and OAuth scopes

| Scope | Why | From phase | Google's class |
|---|---|---|---|
| `openid email profile` | Which account was connected: its stable id (`sub`), email and name | 1 | non-sensitive |
| `https://www.googleapis.com/auth/drive.metadata.readonly` | List the spreadsheets an account can see, with names and dates, **without opening them** | 1–2 | restricted |
| `https://www.googleapis.com/auth/spreadsheets` | Read and write cell values; add rows and columns | 1 (granted), 3 (used) | sensitive |
| `https://www.googleapis.com/auth/drive.activity.readonly` | Edits made outside the app | 8 — asked for at connect, **optional** (an account that unticks it still connects; its card says so) | restricted |
| `openid email` (a person's own sign-in) | Link a person's own Google identity to their app login — no offline access, no token kept | 4 | non-sensitive |

**Never ask for more than is used.** A grant missing either of the two required scopes is refused and
revoked (§9) — unless that Google account is connected to another project, whose access shares the
grant.

### Endpoints

| Phase | Endpoint | Fields read |
|---|---|---|
| 1 | `oauth2.googleapis.com/token` | Code exchange with a PKCE verifier; refresh |
| 1 | `oauth2.googleapis.com/revoke` | — |
| 1 | `openidconnect.googleapis.com/v1/userinfo` | — |
| 1–2 | Drive v3 `files.list`, `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`, all drives, newest first | `id, name, modifiedTime, webViewLink, shared, owners, lastModifyingUser, capabilities(canEdit, canShare)` — file details only, never contents, not even the sharing list |
| 3 | Sheets v4 `spreadsheets.get` | `sheets.properties` only (the tab list, no grid data) |
| 3 | `values.get` on a bounded window; `values.batchUpdate` (`USER_ENTERED`); `values.append`; `spreadsheets.batchUpdate` (`appendDimension` / `insertDimension` / `deleteDimension`) | — |
| 5 | Drive v3 `permissions.list` (only through an account that can share the file) | `type, role, emailAddress, displayName` |
| 8 | Drive Activity v2 `activity:query` (`itemName: items/<fileId>`, time filter, no consolidation) | — |

### What Google's verification means here

- **Internal app** (a Google Workspace organisation connecting its own accounts): no verification
  needed. This is the recommended setup.
- **External app, Testing status**:
  - only listed test users can connect;
  - Google expires their refresh tokens after **7 days**, so every account needs reconnecting weekly;
  - the settings page says this up front.
- **External app, in production**: `drive.metadata.readonly` and `drive.activity.readonly` are
  *restricted* scopes, so Google requires app verification and a security assessment.
- **If that is not an option**, the fallback is `drive.file` plus the Google Picker:
  - it is non-sensitive;
  - a person picks each sheet once (still no ID typed);
  - but the app can then never list everything an account can reach, and Drive Activity is not
    available.

  This is a scope change in `oauth.ts` and a different Phase 2. It is deliberately not built
  speculatively.

---

## 5. The shared-sheet model: who is who

### Three identities, linked explicitly, never guessed

```
Google identity  ──(the person signs in with Google)──▶  App user  ──(InternalTeamMember.userId)──▶  Team member
   people/<id>          UserGoogleIdentity                  User          existing link, per project       roster
```

- **App user → Team member** is the existing `InternalTeamMember.userId` (unique per project). It is
  reused, not duplicated. No new person model is created.
- **Google identity → App user** (Phase 4) exists only because the person proved it themselves, by
  signing in with that Google account (openid + email; no token is kept). It is never inferred from a
  matching email or name.
- Any missing link means "unattributed", never a guess.

### Google's permission and the app's membership are separate things

| | Google says | The app decides |
|---|---|---|
| What it is | Who may open or edit the FILE in Google | Who works on or monitors the sheet THROUGH THE APP, and whose time is counted |
| Where it lives | Drive sharing (shown, Phase 5) | `GoogleSpreadsheetMember` (Phase 5) |
| Example | Rudra = Editor, CTO = Viewer | Rudra, Borhan, Istiyak, Khairul = **EDITOR**; CTO = **MONITOR** |

Membership roles (Phase 5, built):

- **LEAD** — responsible for the sheet. Works on it like an editor, and **staffs** it: adds, re-roles
  and removes its editors and monitors (while holding `google_sheets.edit`). A Lead cannot create,
  change or remove a Lead — themselves included — so who is responsible stays a manager's decision
  and a Lead cannot hand it away by accident.
- **EDITOR** — may edit the sheet through the app (together with the `google_sheets.edit` permission).
  Their edits are work.
- **MONITOR** — may open the sheet read-only and follow its activity (together with
  `google_sheets.monitor` / `.report` for other people's figures). The editor is read-only for them,
  so a monitor cannot produce work time; their time is viewing.
- A monitor never becomes the owner. Members are app users, so a CTO who is not on the support roster
  can still be one.
- **Who changes members:** a person with `google_sheets.manage` (any change), or the sheet's Lead with
  `google_sheets.edit` (editors and monitors only). Both after the project's access level and status:
  a suspended project changes nothing.
- **A role is a fact about the app, not a permission.** An Editor whose role lacks
  `google_sheets.edit` is shown as "not able to work through the app yet"; membership never grants a
  permission.

Sheet contents are opened through the app only by members of that sheet, or by a manager
(`google_sheets.manage`). The list (Phase 2) shows names and dates to anyone with
`google_sheets.view`.

### Who gets credit for what

| Event | Attributed to | Never to |
|---|---|---|
| A change made in the app | The signed-in app user, and their team member **at that moment** (stored on the row) | The connected Google account, the file's owner, or its creator |
| A view in the app | The signed-in app user, as viewing | Work |
| An edit made in Google directly | The app user whose verified Google identity equals the single known actor | Anyone, when the actor is unknown, deleted, anonymous, an admin, or one of several |
| "Last modified by" in the list | Nobody — Google's statement, shown as such | — |

---

## 6. Data model

**No new person model.** `User`, `InternalTeamMember` and `InternalTeamMember.userId` are used as they
are. No spreadsheet contents are ever stored in PostgreSQL — only metadata, A1 ranges and timestamps.

### Built

**Phase 1 — `GoogleIntegrationAccount`** (migration `20261011090800_google_integration_account`):

| Column | Meaning |
|---|---|
| `projectId` | Owner project; `project_id_required()` default; immutable (trigger) |
| `googleSubject` | Google's stable account id. `@@unique([projectId, googleSubject])` — reconnecting revives the same row |
| `email`, `displayName`, `pictureUrl` | From Google at connect time |
| `grantedScopes` | Exactly what Google granted |
| `status` | `CONNECTED` / `NEEDS_RECONNECT` (Google refused the stored grant) / `DISCONNECTED` (by a person) |
| `refreshTokenCiphertext`, `accessTokenCiphertext`, `accessTokenExpiresAt` | `encryptSecret` envelopes. Null after a disconnect or a refused grant |
| `lastError` | The last problem, worded for the page |
| `spreadsheetCount`, `spreadsheetsCountedAt` | From the last list refresh. Capped at 10,000 and shown as "10,000+" |
| `connectedById` → `User` (SetNull), `connectedAt` | Who connected it, when. An audit fact, never ownership |
| `disconnectedAt`, `disconnectedByUsername` | Kept when disconnected |

**Phase 2 — `GoogleSpreadsheet` and `GoogleSpreadsheetAccess`** (migration
`20261011090900_google_spreadsheets`):

`GoogleSpreadsheet` has one row per Google **file** per project (`@@unique([projectId, googleFileId])`),
however many connected accounts reach it. It holds metadata only:

| Column | Meaning |
|---|---|
| `googleFileId` | The spreadsheet id in its URL |
| `name`, `webViewLink` | The link is kept only when it is https on a Google host |
| `modifiedTime` | Google's modified time for the file |
| `ownerName`, `ownerEmail` | Google's owner. A shared-drive file has none |
| `lastModifiedByName`, `lastModifiedByEmail` | Google's statement, display only (§3). The email is often absent |
| `sharedInGoogle` | Drive's `shared` |
| `isMonitored`, `monitoredAt`, `monitoredByUsername` | A manager's choice: the sheets whose work is tracked |
| `firstSeenAt`, `removedAt` | `removedAt` = no connected account reaches the file any more. **Never deleted**; cleared when one does again |

`GoogleSpreadsheetAccess` has one row per sheet × connected account. It holds `canEdit` and `canShare`
(Google's capabilities for THAT account), `firstSeenAt`, `lastSeenAt` and `removedAt`. Two
`same_project` triggers keep each row's sheet and account in its own project.

One sheet reachable through two accounts is one sheet with two paths, never two sheets. A row per
account is what made WhatsApp group setup fail to carry across numbers (CLAUDE.md).

**Phase 5 — `GoogleSpreadsheetMember`** (migration `20261011091000_google_spreadsheet_members`): one
row per **period** a person holds a role on a sheet — `spreadsheetId`, `userId` (an app login),
`role` (`LEAD` / `EDITOR` / `MONITOR`), `startedAt`, `endedAt`, `endReason` (`ROLE_CHANGED` /
`REMOVED`), `addedById`, `endedById`.

- History, never overwritten. A role change ends the open period and opens the next at the same
  instant (half-open periods: no gap, no overlap); removing ends it; adding back opens a new one. So
  a report reads who was a member, and in which role, AT THAT MOMENT — like `TeamMembership`.
- A partial unique index allows **one open period per person per sheet**, even against two
  simultaneous presses.
- `same_project` trigger on `spreadsheetId`; the three user columns point at platform users.

**Phases 4–8** (migrations `20261011091100` to `20261011091400`):

| Phase | Table | Shape |
|---|---|---|
| 4 | `UserGoogleIdentity` | Platform-level (no projectId): `userId`, `googleSubject` (unique — one login per Google account), `email`, `displayName`, `verifiedAt`. Written only by that person's own Google sign-in; unlinking deletes it, and activity already credited keeps its user |
| 6 | `GoogleSheetActivity` | Append-only. `kind` (`VIEW` / `WORK` / `OTHER`); `source` (`APPLICATION` / `EXTERNAL_GOOGLE`); `actionType`; `attribution` (`APPLICATION` / `ATTRIBUTED` / `UNATTRIBUTED` / `APPLICATION_ECHO`) + `unattributedReason`; tab (`tabId` + title snapshot), A1 `range` and `itemCount` (application only), `detail` (a structural change in words); `userId`, `teamMemberId`, `memberRole` (resolved at that moment and stored); `googleAccountId` (the carrier, never the person); `sessionId`; `occurredAt`; external: `externalKey` (unique per project), the actor as Google gave it, `echoOfActivityId` |
| 7 | `GoogleSheetWorkSession` + `GoogleSheetWorkSessionEvent` | One session per opened page (`clientKey`, unique per project), with the role, team member and `canWork` at the start; events `START`, `VIEW_SIGNAL`, `WORK_SIGNAL`, `CLOSE` stamped with the server's clock. **The events are the record**: time is computed from them at read time (`computeSheetTime`), never stored |
| 7–8 | `GoogleSheetsSettings` | Per project singleton: `inactivityMinutes` (default 5, 1–60), `externalActivityEnabled` (default on) |
| 8 | columns | `GoogleSpreadsheet.externalActivityCheckedThrough / CheckedAt / Error`; `GoogleIntegrationAccount.activityIdentityVerifiedAt / MismatchAt` |

**Action types:**

- **View:** spreadsheet opened, tab opened, refreshed, searched.
- **Work:** cell edited, range updated, rows added / deleted, columns added / deleted, tab renamed.
  Later, the other structural changes the editor supports.
- **External:** Drive Activity's create / edit / rename / delete / restore / comment /
  permission change. No range, and no time.

**Integrity.** Every relation between two project tables gets its `<Child>_<column>_same_project`
trigger in its migration (`projectIntegrity.integration.test.ts` enforces it).

---

## 7. Work time — and viewing time

**Not `last edit − first edit`, and not first open → last close.** Both count lunch, meetings and an
open laptop as work.

### Signals, sent by an open sheet page

- **`START`** — the page opens *and the tab is visible*.
- **`VIEW_SIGNAL`** — at most every 30 s, only if the person interacted since the last one (pointer,
  scroll, selection, switching tab), and only while `document.visibilityState === "visible"`.
- **`WORK_SIGNAL`**:
  - **While editing** — typing into a cell, at most every 30 s. Only a LEAD or EDITOR can, since a
    monitor's editor is read-only.
  - **On every change saved** — an edit, rows or columns added or deleted, a tab renamed.
- **`CLOSE`** — leaving the page. `navigator.sendBeacon` goes to a small route handler, because a
  Server Action cannot receive a beacon.
- **Nothing** is sent by a hidden tab, or by a visible tab nobody touches.

### The rule (threshold T = `inactivityMinutes`, default 5)

1. **Work time** is built from `WORK_SIGNAL`s only. Within a session, the gap between two consecutive
   work signals counts if it is ≤ T. A longer gap is a pause, and the next signal resumes. The first
   signal opens a stretch, the last one closes it, and nothing after the last one is credited.
2. **Presence** is built the same way from **every** signal (`START`, view, work).
3. **Viewing time** = presence − work time. It is time present and interacting, but not working.
4. **Per person, intervals are unioned across all sessions and sheets**, never summed. Two tabs open
   is one person working, not two (the double-count Support Activity once had per group).
5. A sheet's figures are the same union, per person, on that sheet.
6. A session that goes quiet is closed at its last signal — **lazily, when read**, so no background
   job is needed.

### Example report: Daily Client Follow-up

| Member | Role | Work time | Viewing time | Changes (app) | Edits in Google |
|---|---|---|---|---|---|
| Rudra | Lead | 2h 14m | 0h 20m | 184 | 3 |
| Borhan | Editor | 2h 48m | 0h 11m | 241 | 0 |
| Istiyak | Editor | 1h 40m | 0h 05m | 93 | 1 |
| CTO | Monitor | 0h 0m | 0h 30m | 0 | — |
| Unattributed | — | — | — | — | 4 |
| **Total** | | **6h 42m** | | | |

- Viewing time counts only viewing **in the app** (§3).
- "Edits in Google" are counts, never time.

### What it honestly measures

- **Interaction, not attention.** Reading without touching anything for longer than T shows as idle.
- **Precision is bounded by the signals.** Credited time can miss up to one interval at the end of a
  stretch, and never adds time that had no interaction.
- **External Google activity never contributes time.** Google does not report it, and the module will
  not invent it.

---

## 8. Permissions

These five keys are new, in a "Google Sheets" category. No existing key or level changed.

| Key | Allows |
|---|---|
| `google_sheets.view` | See the module's pages: accounts (read-only), the spreadsheet list; a sheet's contents when also a member |
| `google_sheets.edit` | Edit through the app — on sheets where they are a LEAD or EDITOR member (Phase 3); as a sheet's Lead, staff its editors and monitors |
| `google_sheets.manage` | Connect / disconnect / refresh accounts, mark monitored sheets, manage every sheet's members (including Leads), settings |
| `google_sheets.monitor` | See other people's live sessions and activity (Phases 6–7) |
| `google_sheets.report` | The employee and sheet reports and their exports (Phases 9–10) |

How the existing rules apply:

- **Administrator** receives all five on the next seed (as with every key).
- **Read Only** receives `google_sheets.view` by the existing rule ("every `.view` key").
- **Project access levels** narrow these exactly as they narrow every other key, and this module does
  not change that rule.
  - Under a **READ** level only `google_sheets.view` is usable. `monitor` and `report` are read-only in
    spirit but are not `.view` keys, and READ admits only `.view` and `.bulk_export`.
  - A person who should only read reports needs WRITE, with a role holding only view + report.
- **The `GOOGLE_SHEETS` feature must be on** in the project. It is checked in every action, route and
  page, and in the nav.

---

## 9. Security model

### Tokens

- **Encrypted at rest.** Tokens are stored only as `encryptSecret` envelopes: AES-256-GCM with a key
  id, the same rotatable scheme as AI provider keys, keyed by `AI_CREDENTIALS_ENCRYPTION_KEY`.
- **One reader.** They are read only in `server/google/accounts.ts`. Everything that leaves that file
  uses `PUBLIC_ACCOUNT_SELECT`: no token, no ciphertext. Tests assert that the page payloads carry
  neither.
- **Never in logs or URLs.** Tokens never appear in System Logs. Google's raw error text never goes
  into a URL; the callback redirects with a short code, and the page words it.

### The client secret

It lives only in the server's environment (`GOOGLE_OAUTH_CLIENT_SECRET`) and is used only in the
token request. The consent URL carries the client id, never the secret (tested).

### The OAuth flow

- **PKCE.** Authorization code with PKCE (S256), `access_type=offline`,
  `prompt=consent select_account`.
- **State.** A random state (32 bytes), the PKCE verifier, the project slug and the user id are
  **sealed** (encrypted and authenticated) into an HTTP-only, `SameSite=Lax` cookie. It is scoped to
  the callback path and lives 10 minutes.
- **Callback checks**, all of which must hold. The cookie is cleared on every answer, so a code is
  redeemed once:
  - the cookie opens (untampered, unexpired);
  - Google's `state` equals the sealed one;
  - the signed-in person is the one who pressed Connect;
  - they may still enter the project;
  - **inside the project**, they still hold `google_sheets.manage`, with the feature on.

### Grants

- **Required scopes, or nothing.** A grant without both required scopes is **revoked at Google** and
  refused. A grant without a refresh token is refused, with the fix.
- **A refused grant needs a person.** When Google refuses a stored grant (`invalid_grant` / 401), the
  account becomes `NEEDS_RECONNECT` and its dead tokens are wiped. It is never retried forever.
- **Disconnect is clean.** It revokes the grant at Google (best effort), wipes both tokens, keeps the
  row, and marks the sheets only it reached "No longer reachable".

### Isolation and audit

- **Projects are isolated.** The scoped client confines every query, and another project's account or
  sheet id is "not found". The same Google account, or the same Google file, in two projects is two
  independent rows.
- **Audit.** Connect, disconnect, monitoring changes and failures are written to System Logs with the
  actor and the row (never a token).
- **Links.** A spreadsheet link from Google is kept only when it is https on a Google host, because
  the page renders it as a link.

---

## 10. UI flow

**Settings → Google Sheets → Google Accounts** (`/settings/google-sheets`, Phase 1):

1. Each connected account: email, status (Connected / Needs reconnecting / Disconnected),
   "N spreadsheets accessible · checked … · View", who connected it and when, and any problem.
2. **+ Connect Google Account** (manage) goes to Google's consent screen, then back with
   "<email> is connected" or the reason it was not. The account's spreadsheet list is read straight
   away.
3. **Refresh**, **Disconnect** (confirmed), and **Connect again** for an account that needs it.
4. Without a server OAuth client, the page shows the four setup steps and the exact redirect URI.

**Google Sheets → Spreadsheets** (`/google-sheets`, Phase 2):

- **Columns:**
  - the spreadsheet (name, a "Shared" badge, its id, its owner);
  - last modified (date, and "by … (Google)" when Google says);
  - the Google accounts that reach it, with can edit / view only;
  - monitoring;
  - Open in Google Sheets ↗.
- **Search** by name or spreadsheet id; **filter** by Google account. The view chips are All /
  Monitored / Not monitored / No longer reachable, each with its count. Newest first, 50 / 100 / 500
  per page.
- **Manage only:** Monitor / Stop on each row, and **Refresh from Google** (every connected account,
  one after another; a failing account is named and the others still refresh).

**A spreadsheet** (`/google-sheets/<id>`, Phase 5) — open it from the list (its name or its Members
cell):

- **Members:** each person with their role, their linked team member (or "Not linked to a team member
  — link on Team Members"), whether they can work through the app, and since when / added by whom.
  People who staff the sheet change a role in place, remove someone (confirmed; history kept) and add
  someone (any active login that may enter the project; Lead only for a manager).
- **Earlier membership:** every closed period — who, which role, from when to when, and why it ended.
- **Shared in Google Drive** (for the people who staff it): "Show Google's sharing list" reads it live
  through a connected account that can share the file. Reference only — it never adds, changes or
  removes a member.

**On the same spreadsheet page** (Phases 3, 6–7):

- **The editor** at the top — tabs, a bounded grid, edit (LEAD / EDITOR members), paste, insert / append
  / delete rows and columns, Save, Discard, Refresh, Find, and a link to Google Sheets for everything else.
- **Open right now** and **Recent activity**, for people with `google_sheets.monitor` (or manage).
- Each member shows their linked Google identity, or that edits they make in Google cannot be credited.

**Google Sheets → Activity** (`google_sheets.monitor`): who is open now; the log by kind (work, viewing,
in Google), period and person.

**Google Sheets → Work Reports** (`google_sheets.report`): by employee and by spreadsheet, with drill-downs
and Excel / CSV export (§20).

**Google Sheets → My Google Identity** (`google_sheets.view`): link or unlink your own Google account (§17).

**Settings → Google Sheets**: the pause threshold, reading changes made in Google on or off, whether the
identity bridge is confirmed, and per account whether it allowed activity.

The editor is deliberately **not a spreadsheet clone**:

- It reads a bounded window (about 200 rows × 26 columns, paged).
- Save writes only the cells that changed, in one `values.batchUpdate`.
- Before writing, it re-reads those cells. A cell changed by someone else since it was loaded is shown
  and not overwritten; Google offers no version check on values.
- Formatting, charts, filters and anything beyond "type a value or a formula" stay in Google Sheets,
  one click away.

---

## 11. Phases

Each phase is built and verified separately:

- new tests confirmed to fail without the code;
- isolated suites;
- typecheck, lint and build;
- its migration named after the latest one and never auto-applied.

| # | Phase | Status |
|---|---|---|
| 1 | Connect Google accounts (OAuth, encrypted tokens, settings page, permissions, feature flag) | **Built** |
| 2 | Spreadsheet list (metadata, one sheet per file, reachability, monitored flag, search / filter) | **Built** |
| 3 | Sheet editor (view, edit, add / delete rows and columns, save, refresh, search, open in Google) | **Built** (§16) |
| 4 | Identity: a person links their own Google identity; the existing user ↔ team member link shown where it matters | **Built** (§17) |
| 5 | Sheet members: LEAD / EDITOR / MONITOR, with history; Google's sharing shown beside them | **Built** |
| 6 | Activity log: VIEW vs WORK, application vs external | **Built** (§18) |
| 7 | Sessions: work time and viewing time (§7) | **Built** (§18) |
| 8 | External Google activity (Drive Activity; worker poller) | **Built** (§19) |
| 9 | Employee report | **Built** (§20) |
| 10 | Sheet report: the shared-sheet member breakdown (§7) | **Built** (§20) |

Members (5) were built before the editor (3) because who may edit through the app is decided by
membership.

---

## 12. Phase 1 as built — connecting Google accounts

### Files

| Area | Files |
|---|---|
| Server | `apps/web/src/server/google/oauth.ts`, `api.ts`, `accounts.ts`; `server/actions/googleSheets.ts` |
| Routes | `app/p/[project]/api/google-sheets/connect/route.ts` (starts the flow); `app/api/google/oauth/callback/route.ts` (the one callback) |
| Page | `app/p/[project]/(dashboard)/settings/google-sheets/page.tsx` + `GoogleAccountList.tsx`; a Settings rail entry and a nav permission in `navigation.ts` |
| Shared | Five keys in `packages/shared/src/permissions.ts`; the `GOOGLE_SHEETS` feature in `projectFeatures.ts` |
| Database | `GoogleIntegrationAccount` + `GoogleAccountStatus`, migration `20261011090800_google_integration_account` |
| Config | `.env.example` and `docker-compose.yml` (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, both optional) |

### Setting it up on a server (once)

1. In Google Cloud Console, enable the **Google Drive API**, the **Google Sheets API** and the
   **Drive Activity API** (Phase 8).
2. Configure the OAuth consent screen. Choose **Internal** when the accounts belong to one Workspace
   organisation (§4).
3. Create an OAuth client of type **Web application**, with the authorised redirect URI
   `<NEXTAUTH_URL origin>/api/google/oauth/callback`. The settings page prints the exact value.
4. Put the client id and secret in `.env` as `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`,
   and recreate the app and worker containers.
5. Apply the migrations (`pnpm db:migrate:deploy`, or the `migrate` service). Then switch the feature
   on for the project, and give the people who connect accounts `google_sheets.manage`.

### Error codes (`?google_error=` on the settings page)

| Code | Meaning |
|---|---|
| `expired` | No usable state: too slow, another browser, or tampered |
| `state` | Google's state did not match |
| `denied` | Consent was refused, or no code came back |
| `session` | A different person is signed in now |
| `permission` | No manage permission, the feature is off, or the project can no longer be entered |
| `not_configured` | No OAuth client on the server |
| `missing_scopes` | Spreadsheet access was not granted; the grant was revoked |
| `no_refresh_token` | No offline access was granted |
| `google_refused` | The code could not be redeemed |
| `failed` | A server error, logged in System Logs |

### Tests

**`googleSheetsConnect.integration.test.ts`** (14 tests) runs the real routes and actions against the
isolated database, with a fake Google behind `fetch`:

- Connect is refused to view-only users and to a project with the feature off.
- The callback refuses a foreign state, a missing cookie, another person, an expired state and a
  consent refusal, and re-checks the permission inside the project.
- A partial grant is refused and revoked; a grant without offline access is refused.
- Tokens are stored encrypted, reconnecting reuses the row, projects are isolated, and no token
  reaches a page.
- Refresh, `invalid_grant` → NEEDS_RECONNECT, and disconnect are covered.

Each guard was removed in turn, and the suite failed for every one (17 of 17).

---

## 13. Phase 2 as built — the spreadsheet list

### Files

| Area | Files |
|---|---|
| Server | `server/google/spreadsheets.ts` (refresh, reachability, monitoring, the list query); `api.ts` `listDriveSpreadsheets` (replaces Phase 1's count) |
| Actions | `refreshGoogleSpreadsheetsAction` (one account; Settings' Refresh), `refreshAllGoogleSpreadsheetsAction`, `setSpreadsheetMonitoringAction`. Disconnect now also closes the account's paths |
| Callback | Reads the account's list right after connecting, best effort |
| Page | `app/p/[project]/(dashboard)/google-sheets/page.tsx`, `MonitorButton.tsx`, `RefreshSpreadsheetsButton.tsx`; a "Google Sheets" sidebar module |
| Database | `GoogleSpreadsheet`, `GoogleSpreadsheetAccess`, migration `20261011090900_google_spreadsheets` |

### Rules worth not undoing

- **Metadata only.** The refresh asks Drive for file details (`DRIVE_SPREADSHEET_FIELDS`). It never
  requests contents or the sharing list, and never calls the Sheets API. A test asserts that the only
  endpoint called is Drive `files.list`.
- **One sheet per file.** Each additional account that reaches a sheet is a path, never a copy.
- **A refresh that changes nothing writes nothing to the sheet rows.** Only the paths' `lastSeenAt`
  stamps move. Accounts see a file differently (Google hides an email from an account it is not
  visible to), so a listing that **omits** a detail never erases one already known: the owner always,
  the last modifier for the same version. Without that, two accounts would overwrite each other on
  every refresh.
- **Nothing is deleted.** A file an account stops listing loses that path. A file no account reaches
  is "No longer reachable", and comes back as the same row.
- **"Not listed" is decided by the set the listing named, never by timestamps**, so two overlapping
  refreshes cannot mark a seen sheet as gone.
- **A capped listing (10,000+) marks nothing unreachable**, because what it left out is unknown. A
  failed listing marks nothing either: the error is recorded on the account and shown.
- **Monitoring is the app's choice.** It survives every refresh, needs `google_sheets.manage`, and is
  logged. It changes nothing in Google.

### Tests

**`googleSheetsList.integration.test.ts`** (13 tests) runs against the isolated database with a fake
Drive. It covers:

- details stored and no sheet opened;
- one sheet with two paths;
- an unchanged refresh rewriting nothing;
- rename in place;
- losing a path versus losing the last path;
- revival as the same row;
- a capped listing removing nothing;
- disconnect closing paths;
- monitoring permission, persistence and audit;
- search by name and by id, the account filter and the view counts;
- project isolation;
- refresh permissions, and one failing account named while the others refresh.

**`googleOAuth.test.ts`** (12 unit tests) covers the listing: metadata fields only, paging, newest
first, parsing, the link check, and the cap.

Each guard was removed in turn, and the tests failed for every one (15 of 15).

`projectFoundation.integration.test.ts` (worker) now counts 89 project-scoped tables.

### Limitations

- **Not run against real Google yet** (no OAuth client exists). Every Google response in the tests is a
  fake modelled on the documented answers.
- **The list refreshes when somebody asks**: on connect, Settings → Refresh, or Refresh from Google.
  There is no background refresh, deliberately — that is worker work, Phase 8.
- **Monitoring marks sheets but tracks nothing yet.** Tracking arrives with the activity log and
  sessions (Phases 6–7).
- **No Members or Settings column yet.** Membership is Phase 5, and a column with nothing behind it
  would be a dead control.
- **"Open" opens the sheet in Google** until the in-app editor exists (Phase 3).
- **An account lists at most 10,000 spreadsheets**, newest first.

---

## 14. Validating against a real Google account (local)

The tests run against a fake Google. This is the procedure to check Phases 1, 2 and 5 against a real
one, on your own machine. **It never touches the live database:** the repository's root `.env` points
at the live stack's database, so everything here uses the throwaway test database on port 5433 and an
env file of its own. Your client secret stays in that file on your machine.

### A. Google Cloud (once)

1. <https://console.cloud.google.com> → create a project (for example "Softify Assist local check").
2. **APIs & Services → Library** → enable **Google Drive API**, **Google Sheets API** and **Drive
   Activity API**.
3. **Google Auth Platform** (formerly "OAuth consent screen"):
   - **Branding** — an app name and your support email.
   - **Audience** — **Internal** if every account you will connect belongs to your Google Workspace.
     Otherwise **External**, left in **Testing**, with each Google account you will connect added
     under **Test users**. Testing tokens expire after 7 days, which is fine for a check.
   - **Data access** — add `openid`, `…/auth/userinfo.email`, `…/auth/userinfo.profile`,
     `…/auth/drive.metadata.readonly`, `…/auth/spreadsheets` and `…/auth/drive.activity.readonly`.
4. **Clients → Create client** → type **Web application** → **Authorized redirect URIs**:
   `http://localhost:8670/api/google/oauth/callback` — exactly, port included. No JavaScript origin
   is needed. Keep the client ID and secret on your machine.

### B. The local env file

Create **`apps/web/.env.development.local`**:

- Git ignores it.
- **Only `next dev` reads it.** Builds, `next start` and the test suites do not.
- **Delete it afterwards (F).** While it exists, every `next dev` in `apps/web` uses the throwaway
  database.

Do not use `node --env-file` instead: `next dev` hands Node's flags to a child process, and Node
refuses `--env-file` there.

```
DATABASE_URL="postgresql://support_automation_test:support_automation_test@localhost:5433/support_automation_test?schema=public&connection_limit=5"
NEXTAUTH_URL=http://localhost:8670
NEXTAUTH_SECRET=<a long random string>
AI_CREDENTIALS_ENCRYPTION_KEY=<32 random bytes, base64>
GOOGLE_OAUTH_CLIENT_ID=<your client id>
GOOGLE_OAUTH_CLIENT_SECRET=<your client secret>
```

Make each random value with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### C. Start it (PowerShell, from the repository root)

```powershell
docker compose -f docker-compose.test.yml up -d --wait postgres-test
cd packages/db
$env:DATABASE_URL = "postgresql://support_automation_test:support_automation_test@localhost:5433/support_automation_test?schema=public"
npx prisma migrate deploy          # the throwaway test database only
$env:SEED_ADMIN_USERNAME = "admin"; $env:SEED_ADMIN_PASSWORD = "<choose one>"; $env:SEED_ADMIN_EMAIL = "admin@local.test"
npx tsx prisma/seed.ts
cd ../../apps/web
npx next dev -p 8670               # its first lines say "Environments: .env.development.local"
```

- Open <http://localhost:8670> and sign in as `admin`.
- Main Admin → Projects → **ISP Digital** → Features → switch on **Google Sheets**.
- Do not run the test suites while validating. They share this database, create and delete fixtures,
  and switch the feature off when they finish.

### D. The checks

| # | Do | Expect |
|---|---|---|
| 1 | Settings → Google Sheets → **+ Connect Google Account**. Accept every permission ("Google hasn't verified this app" → Continue, in Testing) | "<email> is connected"; "N spreadsheets accessible" matches the Sheets you can see in Drive, including ones shared with you and in shared drives |
| 2 | Google Sheets → **Spreadsheets** | Each sheet once, with its name, date, owner and "Shared" badge |
| 3 | Rename a sheet in Google, then **Refresh from Google** | The same row, with the new name |
| 4 | Create a sheet, and trash another, then refresh | The new one appears; the trashed one moves to **No longer reachable** |
| 5 | Connect a second Google account that shares one sheet with the first | That sheet is listed once, with both accounts |
| 6 | **Disconnect** an account | Its card says Disconnected. Sheets only it reached move to No longer reachable. The app is gone from that account's <https://myaccount.google.com/permissions> |
| 7 | **Connect again** with the same account | The same account row (no duplicate), and its sheets come back |
| 8 | Remove the app at <https://myaccount.google.com/permissions>, then **Refresh** | The account shows **Needs reconnecting** after that one refresh |
| 9 | Connect, and untick the Drive or Sheets permission on Google's screen | "Google did not grant access to see and edit spreadsheets"; nothing is stored |
| 10 | Main Admin → create a project, switch Google Sheets on, connect the **same** Google account there | It has its own account row and its own sheets. Disconnecting it in one project leaves the other connected |
| 11 | Open a sheet → **Members**: make yourself Lead, add another login as Editor and one as Monitor | Members listed with roles; earlier periods kept after a role change |
| 12 | On that sheet → **Show Google's sharing list** | Google's sharing appears; the members above do not change. If no connected account can share the file, it says so instead. That also settles §3's open question for your account type |

### E. Database checks (read-only)

```powershell
docker exec -it support_automation_test-postgres-test-1 psql -U support_automation_test -d support_automation_test
```

```sql
-- Tokens are envelopes ("v2."), never a raw Google refresh token ("1//").
SELECT "projectId", email, status, left("refreshTokenCiphertext", 3) AS envelope, "spreadsheetCount" FROM "GoogleIntegrationAccount";
-- One row per file per project; unreachable ones kept.
SELECT "projectId", count(*), count(*) FILTER (WHERE "removedAt" IS NOT NULL) AS unreachable FROM "GoogleSpreadsheet" GROUP BY 1;
-- Which account reaches what, and what Google lets it do.
SELECT s.name, g.email, a."canEdit", a."canShare", a."removedAt" FROM "GoogleSpreadsheetAccess" a
  JOIN "GoogleSpreadsheet" s ON s.id = a."spreadsheetId" JOIN "GoogleIntegrationAccount" g ON g.id = a."googleAccountId";
-- Members as history.
SELECT s.name, u.username, m.role, m."startedAt", m."endedAt", m."endReason" FROM "GoogleSpreadsheetMember" m
  JOIN "GoogleSpreadsheet" s ON s.id = m."spreadsheetId" JOIN "User" u ON u.id = m."userId" ORDER BY m."startedAt";
```

### F. Afterwards

```powershell
docker compose -f docker-compose.test.yml down -v   # deletes the throwaway database, test tokens included
```

Delete **`apps/web/.env.development.local`** — otherwise the next `next dev` keeps using the
throwaway database and your OAuth client. Delete the OAuth client in Google Cloud too, if you no
longer need it.

---

## 15. Phase 5 as built — sheet members

### Files

| Area | Files |
|---|---|
| Rules | `packages/shared/src/googleSheetMembers.ts`: roles, `roleCanWork`, `decideMemberChange`, `roleAt`, `membersAt` (unit-tested) |
| Server | `server/google/members.ts` (every membership write, `getSheetMembers`, `canStaffSheet`, `resolveSheetActor`); `server/google/sharing.ts` + `api.ts` `listDrivePermissions` (Google's sharing, read-only) |
| Actions | `server/actions/googleSheetMembers.ts` (add, change role, remove, read Google's sharing) |
| Team Members | `linkTeamMemberLogin` now records every link / unlink in System Logs; attribution follows the link |
| Pages | `google-sheets/[spreadsheetId]/page.tsx` + `SheetMembersPanel.tsx` + `GoogleSharingPanel.tsx`; a **Members** column on the list |
| Database | `GoogleSpreadsheetMember` + `GoogleSheetMemberRole` + `GoogleSheetMemberEndReason`, migration `20261011091000_google_spreadsheet_members` |

### Rules worth not undoing

- **Nobody is a member by default.** Not the file's owner in Google, not its creator, and not whoever
  connected the Google account. Reading Google's list creates no member (tested).
- **Every membership write goes through `members.ts`, which applies `decideMemberChange` itself**, so
  no action can skip it.
- **Attribution is `resolveSheetActor`:**
  - It answers with the signed-in user who acted, their role on the sheet at that moment
    (`roleAt`), whether that role works, and their team member through the explicit login link only.
  - A login with no link stays unlinked, even when a roster member has the same name (tested).
  - Phase 6 stores this answer on each activity row when it happens, so a later relink never rewrites
    the past.
- **Google's sharing is reference.** It is read live through an account that can share the file. It
  is shown only to people who staff the sheet, and never stored or copied into members.

### Tests

**`packages/shared/src/__tests__/googleSheetMembers.test.ts`** (7 tests) covers:

- the roles, and that a monitor never works;
- who may make which change;
- half-open role periods.

**`apps/web/src/__tests__/googleSheetMembers.integration.test.ts`** (20 tests) runs the
*Daily Client Follow-up* story against the isolated database:

- **Staffing:** nobody is a member by default; a manager makes Rudra Lead; Rudra adds three editors and
  the CTO as monitor; Rudra stays a working member; an Editor without the edit permission is shown as
  unable to work.
- **Refusals:** a Lead cannot touch Leads, themselves included. Editors, monitors and viewers change
  nothing. Outsiders, deactivated logins and other projects' logins cannot be added. One membership
  per person, even with two simultaneous adds.
- **History:** role changes and removals are kept as history, and the role at a past moment is
  answered correctly.
- **Attribution:**
  - it is the acting login and its linked team member, never the owner or the connected account;
  - there is no name-guessing;
  - linking is audited and followed;
  - reading Google's list creates no member.
- **Google's sharing:** it is shown to staffers only and changes no role (Google says the CTO is a
  writer; the app keeps the CTO a Monitor). An account that cannot share is never asked; a refusal
  is worded.
- **Projects:** another project's sheet is unreachable; a suspended project changes no member.

Each guard was removed in turn, and the tests failed for every one (17 of 17: 13 integration, 4 rule
mutations).

`projectFoundation.integration.test.ts` (worker) now counts 90 project-scoped tables.

### Limitations

- **The team member is the link as it stands when asked.** `InternalTeamMember.userId` keeps no
  history of its own, which is why Phase 6 must store the answer on every activity row as it happens.
- **A login linked to no team member** is credited as the login only, and the page says so beside
  that person.
- **Nothing records work yet.** Membership decides who may edit (Phase 3) and how time counts
  (Phases 6–7). Until those exist, it is the roster those phases will read.
- **Google's sharing list is not stored,** so each look is a call to Google.
- **No real-Google validation yet.** It is pending your run of §14.

---

## 16. Phase 3 as built — the sheet editor

### Files

| Area | Files |
|---|---|
| Rules | `packages/shared/src/googleSheetEditor.ts`: A1 notation, the bounded window, `planSave` (the conflict rule), edit and structure validation, `decideEditorAccess` (unit-tested) |
| Google calls | `server/google/api.ts`: `getSpreadsheetTabs`, `batchGetValues`, `batchUpdateValues` (USER_ENTERED), `batchUpdateSpreadsheet` |
| Server | `server/google/editor.ts` (read a window, save, insert/append/delete rows and columns, search); `server/google/editorAccess.ts` (who opens, who edits — one reading for page, actions and signals) |
| Actions | `server/actions/googleSheetEditor.ts` |
| Page | `google-sheets/[spreadsheetId]/SheetEditor.tsx`, at the top of the spreadsheet's page |

### Rules worth not undoing

- **Who opens, who edits** (`decideEditorAccess`):
  - contents open for the sheet's members, and for a Google Sheets manager (read-only unless they add
    themselves as an Editor — work is credited to members);
  - changes need a LEAD or EDITOR role, the edit permission, and a writable project;
  - a Monitor never edits, whatever their permissions.
- **Only someone who may edit receives what is TYPED in the cells** (formulas). Everyone else gets what
  Google shows.
- **Save writes only what still holds what was loaded.** The server re-reads the changed cells and
  `planSave` writes only those unchanged since loading. A cell changed in Google meanwhile comes back as
  a conflict, in red, with what it holds now; saving again is a deliberate overwrite. One
  `values.batchUpdate`, one range per cell, so nothing else is touched.
- **A delete re-reads the row or column first** and refuses when it no longer holds what the person was
  looking at. Rows are positions, so a row inserted above meanwhile would otherwise make "delete row 12"
  delete the wrong row.
- **Writes go only through an account Google lets edit the file** (`canEdit`). A view-only path says so.
- **Bounded.** A window is 200 rows × 26 columns, paged. Search reads at most 200,000 cells of a tab and
  returns at most 200 matches, and says when it stopped short. One save is at most 2,000 cells.
- **Paging or switching tab never drops unsaved changes** — it asks for Save or Discard first, and
  leaving the page warns.
- Formatting, charts, filters and anything beyond a value or a formula stay in Google Sheets, linked.

---

## 17. Phase 4 as built — a person's own Google identity

### Files

| Area | Files |
|---|---|
| OAuth | `oauth.ts`: a sealed `purpose` (`CONNECT` / `IDENTITY`); `IDENTITY_SCOPES` = `openid email` |
| Server | `server/google/identity.ts` (link, list, unlink, `identitiesForUsers`) |
| Routes | `app/p/[project]/api/google-sheets/identity/route.ts` (start); the one callback branches on the purpose |
| Page | `google-sheets/identity/page.tsx` + `IdentityList.tsx` — **Google Sheets → My Google Identity**; each member on a sheet shows their linked Google account |
| Database | `UserGoogleIdentity` (platform, no projectId), migration `20261011091100_google_user_identity` |

### Rules worth not undoing

- **Linked only by the person signing in with that Google account.** Never from a matching email or name,
  never by somebody else.
- **Who you are, nothing more.** `openid email`, no offline access, the account chooser every time.
- **No token is kept, and nothing is revoked.** Google revokes a WHOLE grant (this app × that Google
  account), and the same Google account is often also connected to a project — revoking would disconnect
  it. The access token from the sign-in is simply dropped.
- **One Google account, one login.** A second login is refused (`linked_elsewhere`).
- **The purpose is sealed in the state.** An identity sign-in cannot connect an account, and a connection
  never links an identity. Linking needs only the view permission; connecting still needs manage.
- **Disconnecting never revokes a grant another project still uses** (a Phase 1 fix made here): the
  tokens are wiped, and Google is told only when no other project has that Google account connected.
  The same rule covers the missing-scopes refusal.

---

## 18. Phases 6–7 as built — the activity log, work time and viewing time

### Files

| Area | Files |
|---|---|
| Rules | `packages/shared/src/googleSheetActivity.ts` (action types, kinds, attributions, reasons); `googleSheetTime.ts` (`computeSheetTime`: §7's rule) — unit-tested |
| Server | `server/google/activity.ts` (`recordAppActivity`, `listActivity`); `server/google/sessions.ts` (`recordSignal`, `recordSaveSignal`, `listLiveSessions`); `server/google/settings.ts` |
| Route | `app/p/[project]/api/google-sheets/signal/route.ts` — START / VIEW / WORK / CLOSE (a beacon on leaving) |
| Pages | **Google Sheets → Activity** (`google_sheets.monitor`): who is open right now and the log, filtered by kind, period and person; on each spreadsheet, "Open right now" and "Recent activity"; Settings → Google Sheets → "Work time and changes made in Google" |
| Database | `GoogleSheetActivity` (`20261011091200_google_sheet_activity`); `GoogleSheetWorkSession`, `GoogleSheetWorkSessionEvent`, `GoogleSheetsSettings` (`20261011091300_google_sheet_sessions`) |

### Rules worth not undoing

- **Every application row is credited to the signed-in person**, with their team member (login link)
  and sheet role resolved AT THAT MOMENT and stored on the row — never to the Google account that
  carried the call. The account is kept beside it as "via".
- **No cell value and no search text is stored.** A row holds the tab, the A1 range and a count.
- **Viewing ≠ work.** Opening, switching tab, refreshing and searching are VIEW; a saved change is WORK.
  Paging is not logged.
- **Signals are stamped with the server's clock.** A signal faster than the interval is dropped, a
  hidden or untouched page sends nothing, and time is built from gaps, never a count — so sending more
  signals never adds time.
- **A work signal from someone who cannot work is recorded as viewing** — a monitor, or anyone without
  the edit permission. A save is itself a work signal, recorded by the server.
- **The events are the record.** `computeSheetTime` turns them into time when read; nothing stores a
  derived number. Per person, stretches are UNIONED across sessions and sheets.
- **Sessions are never closed by a job.** A quiet session simply stops being live; CLOSE only stops
  further signals. The signal route accepts same-origin requests only.
- **Application activity is recorded on every sheet** — it is the audit of what the project's Google
  access was used for. "Monitored" decides which sheets Google itself is read for (Phase 8).

---

## 19. Phase 8 as built — changes made in Google directly

### Files

| Area | Files |
|---|---|
| Worker | `apps/worker/src/googleSheets/api.ts` (token refresh, `activity:query`), `driveActivity.ts` (pure: parsing, keys, `decideAttribution`, the bridge, echoes), `externalActivityProcessor.ts` (the loop, every minute, three sheets per project per tick, each sheet at most every 15 minutes) |
| Scope | `drive.activity.readonly` is asked for at connect, **optional** — the account card says whether it was allowed |
| Settings | "Read changes made in Google directly" (on by default; the whole feature is off until a Main Admin switches it on) |
| Database | `20261011091400_google_external_activity`: the sheet's read cursor and last error, the account's bridge stamps, the setting |

**Why not `packages/google-client`, as first planned:** the worker needs two calls (refresh, query). A new
package means a new build step in both Dockerfiles and the test image, for two functions. They live in
the worker; the dashboard's `api.ts` remains the only Google client the web uses.

### Rules worth not undoing

- **Only monitored, reachable sheets, only through an account that allowed activity.** A sheet with no
  such account records why instead of being read.
- **Crediting is conservative** (`decideAttribution`). One actor, a known user, whose Google account a
  login linked itself, AND the identity bridge verified for the project. Several actors, a deleted,
  unknown or anonymous user, an administrator, an impersonation or Google itself is UNATTRIBUTED, with
  the reason.
- **The bridge is checked, not assumed.** Google does not document that `people/<id>` equals sign-in's
  `sub`. When a connected account's OWN change (`isCurrentUser`) names an id equal to its `googleSubject`,
  the project's bridge is VERIFIED; a different id is a MISMATCH, after which nothing in that project is
  credited until somebody investigates. Per project.
- **Google's record of the app's own save is an echo** (`APPLICATION_ECHO`, linked to the application
  row): the connected account, within three minutes of an application change on the same sheet. Never
  counted again.
- **Counts only.** External rows carry no range and no time; they never add work time.
- **Idempotent.** A deterministic `externalKey` per Google record, unique per project, and every read
  overlaps the last by ten minutes. Past rows are never re-credited.
- **Failures are worded on the sheet**, never thrown: a refused grant marks the account NEEDS_RECONNECT;
  a 403 says to check that the Drive Activity API is enabled. A read with more than 5,000 changes says
  the oldest were not read.

---

## 20. Phases 9–10 as built — the reports

### Files

| Area | Files |
|---|---|
| Model | `packages/shared/src/googleSheetReports.ts`: `computeEmployeeReport`, `computeSheetReport` (unit-tested) |
| Server | `server/google/reports.ts` (`loadSheetReport`: one loader, periods on Dhaka days, 92 days at most); `server/google/reportTables.ts` (the tables, built once for page and file) |
| Page | **Google Sheets → Work Reports** (`google_sheets.report`): By employee / By spreadsheet; Today, Yesterday, 7 and 30 days, this month, a custom range; monitored sheets only; drill into a person (day by day, sheet by sheet) or a sheet (§7's member breakdown) |
| Export | `app/p/[project]/api/google-sheets/report-export/route.ts` — Excel (Summary + tables) and CSV, durations in decimal hours |

### What the figures are

- **Work time / viewing time** — `computeSheetTime`, per person unioned across sheets. A sheet's total is
  the sum of its people's own time on it (person-hours).
- **Changes (app)** and **Cells changed** — application WORK rows, exact.
- **Edits in Google** — external changes, credited or not, never echoes, never comments or sharing
  changes; counts, never time. Unattributed ones have their own line.
- **Role** in a sheet breakdown is the role at the end of the period.

### Tests (Phases 3–10)

- Unit (no database): `packages/shared` `googleSheetEditor.test.ts` (19) and `googleSheetTime.test.ts` (12,
  including the reports); worker `googleDriveActivity.test.ts` (12).
- Integration (isolated database, fake Google keeping a real grid): web
  `googleSheetsWork.integration.test.ts` (18 — access, save and conflicts, deletes that moved, structure,
  search, the log, signals and the route, live sessions, both reports and the exports) and
  `googleIdentity.integration.test.ts` (8); worker `googleExternalActivity.integration.test.ts` (9).
- **Each guard was removed in turn and its tests failed for every one: 45 of 45.** The web tests load
  `@support-automation/shared` from its built `dist/`, so a shared rule was mutated in `dist/` for them.
- A browser pass on the throwaway database (Google answered from memory) covered the editor, save,
  the row menu, search, the monitor's and a non-member's views, Activity, Work Reports, My Google
  Identity and Settings, at desktop and phone width (no horizontal scroll) and in dark mode.

---

## 21. Testing it live on a server

1. **Google Cloud**, in the OAuth client's project:
   - enable **Google Drive API**, **Google Sheets API** and **Drive Activity API**;
   - Google Auth Platform → **Data access**: add `openid`, `…/auth/userinfo.email`,
     `…/auth/userinfo.profile`, `…/auth/drive.metadata.readonly`, `…/auth/spreadsheets` and
     `…/auth/drive.activity.readonly`;
   - **Audience**: Internal for one Workspace; otherwise External in Testing, with every Google account
     that will connect OR link itself listed under Test users (tokens expire after 7 days in Testing);
   - **Clients → Web application** → authorised redirect URI `https://<server>/api/google/oauth/callback`
     (Settings → Google Sheets prints the exact value).
2. **The server's `.env`**: `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, then recreate the
   `app` and `worker` containers (`docker compose up -d --no-deps --force-recreate app worker`).
3. **In the app**: Main Admin → Projects → the project → Features → **Google Sheets** on. Give people the
   keys they need (§8).
4. **Connect** an account (Settings → Google Sheets), **Monitor** a sheet, open it, make yourself **Lead**
   and add an Editor and a Monitor. Edit, save, add and delete rows, search.
5. Each person links **My Google Identity**. Edit a monitored sheet in Google directly with the connected
   account; within about 15 minutes the bridge shows **Confirmed** in Settings and changes made in Google
   by linked people are credited to them.
6. **Work Reports** shows the time and counts; export them.
