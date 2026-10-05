# WhatsApp Chat — multi-account separation, workspace UX and user attribution: audit

**Progress:** phases 0–11 are built locally on `rudra`. Nothing is pushed or deployed. Migration
`20261009090000_outbound_user_activity_index` is not applied to any live database. CLAUDE.md
("One WhatsApp account at a time") and REPORTS.md §10 describe the result.

Audit written 5 Oct 2026, before any change. It describes the code as it was then, decides what
changes, and records why. All work is local on `rudra`: nothing is pushed or deployed, and no
production migration is run.

## 1. Current behaviour

| Area | Where | What it does today |
|---|---|---|
| Route | `app/p/[project]/(dashboard)/chat/` | `/chat` (index), `/chat/[groupId]` (conversation), `/chat/archived` |
| Frame | `chat/layout.tsx` | Loads the conversation list and categories once, renders the left pane, polls every 4 s (`AutoRefresh`) |
| List query | `server/chatInbox.ts` `getChatConversations(search?)` | Every active, unarchived group of the **project** — every account mixed — ranked pinned-first, then newest message (one `LATERAL` probe per group), `LIMIT 300` |
| Thread | `getChatThread(groupId)` | The group row's messages (newest 80) plus the outbound rows for the **WhatsApp chat id**, from every account |
| Reply | `server/actions/chat.ts` `sendChatMessage` | Writes one `OutboundMessage` (`MANUAL_REPLY`, `createdById` = session user). It can "reply as" any other account's row for the same WhatsApp group (`sendAs`) |
| Search | `server/actions/chatSearch.ts` | Server search over every group of the project (all accounts) beyond the loaded 300 |

The list rows show each conversation's account label, so two accounts' copies of one WhatsApp group
appear as two rows side by side.

## 2. Reusable components

- `ConversationList` (search, keyboard, density, filter rail, selection mode, bulk bar, rows).
- `Composer` (drafts, saved replies, auto-grow), `MessageThread` (runs, author badges, queued
  bubbles), `ThreadScroller`, `MarkWaitingButton`, `CategoryManager`.
- `chatOrganisation.ts` bulk actions, which already report "updated / unchanged".
- The report framework (`/reports/<id>`, `BuiltReport`, CSV/Excel through one builder).

## 3. Account filtering today

There is none. Every query is project-scoped (the scoped Prisma client plus `"projectId"` in raw SQL),
never account-scoped:
- the list, the search and the archive mix accounts;
- category counts count every account's groups;
- the thread shows other accounts' queued and failed sends to the same WhatsApp group, because
  outbound rows are read by `chatId` alone;
- the pending badge also counts by `chatId` alone.

## 4. Category / filter today

- **Filters:** All, Waiting, Seen-unanswered and the shared `ChatCategory` folders.
- **The rail:** 11 px chips in a sideways-scrolling rail at the top of the 19 rem list pane.
- **Filtering:** done in the browser over the loaded rows only.
- **Counts:**
  - All = `conversations.length`, so it can never exceed **300**. It is the render limit
    presented as a total.
  - Waiting and Seen-unanswered count only the loaded 300, so a waiting group older than the
    300th is uncounted and unreachable from the filter.
  - Category counts come from the server and include every account.

## 5. Bulk functionality today

A **Select** mode turns rows into toggles. "Select all N" covers the filtered rows plus search matches
beyond the loaded window. The bulk bar offers:
- Pin / Unpin;
- move to a category / Remove category;
- Mark as read / Mark as waiting;
- Archive.

There is also "Mark all N read" on the Waiting filter. The actions take group row ids and check only
the project (scoped client). Selection is not cleared when the filter changes.

## 6. Outbound attribution today

- `OutboundMessage.createdById` → `User` is already written by the chat send
  (`sendChatMessage`) and by the template test send (`sendTemplateTestMessage`). Both are
  `MANUAL_REPLY`. The template test's idempotency key starts `template-test:`.
- The thread labels an outgoing message as one of three authors:
  - AI (`aiFallbackDecision`);
  - Rule (`ruleId`);
  - PERSON (everything else) — which wrongly includes the AI handover mention, the
    "unable to understand" holding reply and broadcasts.
- A person's name is never shown.
- `OutboundMessage.accountId` is always set. `groupId` + `groupNameSnapshot` are set for manual and
  broadcast rows. `providerMessageId` links a send to its WhatsApp echo, indexed since
  `20261008090000`.

## 7. User / session identity

- `getSession()` / `requireSession()` read the session cookie server-side and return
  `{ userId, username, name, … }`. `checkPermission` returns it.
- `User` rows are never deleted (`isActive` soft delete). `username` is set only at creation and is
  unique, so it is a stable identity. `name` can be edited.

## 8. Message storage

- `Message` holds one row per account per WhatsApp message (`@@unique([accountId, whatsappMessageId])`).
- Our own sends come back as `OUTGOING` echoes.
- `OutboundMessage` is the send queue and the only record of who pressed send.

## 9. Report infrastructure

`reportCatalogue.ts` lists each report. `server/reports/index.ts` maps it to a builder and an existing
permission. `projectFeatures.ts` holds its route, and `navigation.ts` its icon.

- The generic page and exports render a `BuiltReport`.
- Common filters: period (≤92 days), Team, member, groups, account.
- A report can add selects; their params must be in `REPORT_EXTRA_PARAMS` so presets, links and
  exports carry them.
- The page always shows the Team/member pickers and help text about stored group messages.

## 10. Required changes and decisions

| # | Change | Decision |
|---|---|---|
| A | **The account lives in the URL path**: `/chat/account/<accountId>/…` | A path segment is the only state a Next layout can read, and the list lives in the layout (it keeps scroll between conversations). A cookie was rejected: every tab shares it, so one tab switching account would silently repaint another tab's list with the other account — the cross-account mix this work removes. `proxy.ts` already states the rule: a cookie never decides where a request reads. |
| B | `/chat` with one account redirects to it; with several it shows an account chooser, which forwards to the account last used in this browser (`localStorage`, a convenience only — the URL stays the authority) | The operator always sees which account they are in, and nothing is mixed |
| C | Old links (`/chat/<groupId>` from Unanswered, Response Time, AI Activity, Team Report…) redirect to the group's own account URL; `/chat/archived` redirects to `/chat` | No link breaks |
| D | A conversation URL whose group belongs to another account redirects to that group's own account | The list and the open conversation can never be from two accounts |
| E | Every list, count, search, category count, archive and thread query is filtered by `accountId` on the server | Account isolation server-side, not in the browser |
| F | **Counts are real**: one SQL statement computes All, Waiting and Seen-unanswered over **every** active group of the account, beside the ranked 300; category counts are per account | "All 300" was the render limit; the list still renders at most 300 and says "showing 300 of 742" |
| G | A filter whose count exceeds what is loaded fetches its full list from the server (`listConversationView`) | Waiting and category views are complete, not "whatever happened to be in the top 300" |
| H | The workspace header spans both panes: account selector → search → filter chips; then the list; the bulk bar sits above the list | Prominent, in the order the operator reaches for them, two rows tall |
| I | Selection clears on account switch (the list remounts per account) and on filter change; Select all = what the filter shows | Spec §13 |
| J | Bulk actions take the account and refuse rows of another account (reported, not silently dropped) | Server-side, never trusting the selection |
| K | **Reply goes through the open conversation's account only.** `sendChatMessage(accountId, groupId)` checks: account in the project, group belongs to that account, group active, account connected, `messages.reply`. The cross-account "Reply as" picker is removed | Spec §4: never send through another account. Replying from a second number means switching the account selector to it, which opens that number's own copy of the group. A disconnected account's composer names the other connected accounts in the group as a link, not a hidden send path |
| L | The thread reads outbound rows for **this account** only; echoes are attributed by an exact `providerMessageId` lookup | No other account's queued/failed bubbles leak into a thread; attribution is exact, never "the newest 80 outbound rows" |
| M | **Attribution reuses `OutboundMessage.createdById`** — no new table, no new column | It already records the authenticated user for every manual send. `User` is never deleted and `username` never changes, so `name (@username)` is stable. A name snapshot column was rejected: it duplicates data and would need back-filling |
| N | **Sender type is derived, one shared function** (`packages/shared/src/outboundAttribution.ts`), used by the thread AND the report: HUMAN_USER (`MANUAL_REPLY`; source chat or template test), BROADCAST (`GROUP_BROADCAST`, by the job's creator), AI (an AI fallback decision), RULE_AUTOMATION (a rule), SYSTEM (other automated sends: handover mention, holding reply) | One source of truth; UI attribution = report attribution. BROADCAST is kept apart because a bulk send is not a manual conversation reply |
| O | New report **WhatsApp Chat User Activity** (`/reports/whatsapp-user-activity`, category Team & Employee, key `messages.view` — it shows message text, which is the chat's own key). Filters: period, account, groups (common) + software user + sender type (selects). Overview → user detail (`?user=`) → group drill-down (`&groups=`) → every message. CSV = messages | Same framework; no new permission |
| P | Two optional `BuiltReport` fields: `usesMemberFilters: false` hides the Team/member pickers (they describe WhatsApp team members, not software users) and `sourceHelp` replaces the help text | Additive; every existing report renders exactly as before |
| Q | Duty-based insights are **not** shown | Duty belongs to `InternalTeamMember`; a software `User` has no link to one (Employee → User exists, Employee → team member does not). Matching by phone would be an inference presented as fact |

## 11. Database changes

One index, nothing else:
- `OutboundMessage(projectId, actionType, createdAt)` — the report's WHERE shape (project + manual
  sends + period).
  - The existing `[chatId, createdAt]`, `[accountId, status, sentAt]` and `[sentAt]` indexes
    cannot serve it.
  - The table grows with every auto-reply.
  - It follows the `IF NOT EXISTS` + `CONCURRENTLY` note pattern of `20261008090000`.

No index is needed for the chat list:
- `Message(groupId, timestampWa)` serves the per-group probe.
- `WhatsAppGroup(accountId, isActive)` serves the account filter.
- `OutboundMessage(chatId, createdAt)` serves the answered check.

## 12. Performance

- The count statement probes each active group of ONE account. The old ranking query already probed
  every active group of the PROJECT, across all accounts, so per poll this is the same or less work.
- The "answered by a queued reply" check runs only for groups whose newest message is a customer's
  (a `CASE` guards the `EXISTS`).
- Filtered views are fetched only when their count exceeds what is loaded.
- The thread's attribution lookup is one `IN` query on the new `providerMessageId` index.

## 13. Regression risks

| Risk | Guard |
|---|---|
| Old `/chat/<id>` links | Redirect route + test |
| Waiting semantics | Unchanged definition, now computed in SQL. The "answered by a queued reply" check still reads any account's outbound to the WhatsApp group — a customer answered from another number in the group was answered; documented |
| AI takeover pause | A reply now always goes out from the conversation's own account. Other accounts' copies of the group are still paused, as the cross-account path did, because our send reaches them as an unknown participant |
| Main Admin Workspace | The account segment travels inside the rewritten path unchanged |
| Bulk actions | Existing behaviour plus the account check |
| Project isolation | Every raw query keeps `"projectId"`; the account is looked up through the scoped client, so another project's account id is "not found" |
