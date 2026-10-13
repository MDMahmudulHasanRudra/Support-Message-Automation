# Client Management (CLIENT_CENTER)

One client database for a project, whatever channel the client uses. **Phases 2 and 3 are built**
(records, CRUD, duplicates, list, details, import/export, timeline, per-channel consent data).
Phases 4–8 (sending, campaigns, reminders, notices, tasks, dashboard) are **not** — see "Not built".

## What it is, and is not

- A **project feature**, `CLIENT_CENTER`, **off by default** for every project. A Main Admin switches it on
  (Main Admin Portal → the project's features). Off: the pages 404/redirect, every action refuses, the sidebar
  hides it. Nothing runs in the worker for it.
- **Billing is manual (stage 4A).** Staff type due dates, an optional amount and a status; there are no
  invoices, no ledger and no payment connection, and "paid" is a person's statement (see "Client billing"
  below). Nothing is invented: no default currency, no placeholder amount.
- **Nothing is sent.** Channel references and consent are data. Consent is recorded per channel
  (UNKNOWN / OPTED_IN / OPTED_OUT) for the phases that will send; today it neither sends nor blocks anything.

## Data (migration `20261012100000_client_center`, additive, safe on a live database)

`Client`, `ClientChannel` (one row per phone / email / WhatsApp number / WhatsApp group / Messenger /
Instagram / Telegram / other reference, with its own consent), `ClientNote` (internal only),
`ClientActivity` (the timeline: what happened and who did it, never a note's text),
`ClientImportJob`. All project-scoped: registered in `PROJECT_SCOPED_MODELS`, `projectId` defaults to
`project_id_required()`, immutable-project triggers on all five, same-project triggers on every
relation between two project-owned tables (`Client_assignedMemberId`, `Client_assignedTeamId`, and
`clientId` on channels/notes/activity). Codes (`CL-000123`) come from the `client_code_seq` sequence.
Tags are a lower-cased `String[]` on the client (GIN index), not a table.

## Rules worth not undoing

- **Duplicates are shown, never merged.** A match is a shared identifier — a phone or WhatsApp number
  (one "phone" group; a local `01…` Bangladeshi number gets `88` so it matches `+8801…`), an email, another
  channel reference, or the client code. Never a similar name. Shown before a client is created; creating
  anyway is a separate button. Archived clients are matched too. There is no merge action.
- **Archive, then delete.** Archiving keeps everything; restoring brings back the previous status. Only an
  ARCHIVED client can be permanently deleted (`clients.delete`); the deletion is a System Log entry with a
  count and codes, never names or contact details.
- **Shared rules live in `packages/shared/src/clients.ts`** (normalisation, validation, duplicate matching,
  import column mapping) and **`apps/web/src/lib/clientFilters.ts`** — one filter builder used by the list,
  "select all N matching", the export and the bulk actions, so "export the 312 on screen" is those 312.
- **Import** is upload → preview (auto column mapping, editable) → confirm with a duplicate policy
  (Skip / Update / Create anyway) → report. The confirmation is claimed with one conditional update, so
  pressing it twice imports once. A bad row is reported, the rest are imported. The file's rows are deleted
  from the job when it ends. **Limit:** it runs inside the request, up to 2,000 rows, 2 MB; a durable
  background import is a later extension. An import left PROCESSING by a restart can be closed after 10
  minutes ("Mark as failed"); re-uploading with Skip or Update finishes it safely.
- **Export** needs `clients.export` (separate from viewing), follows the list's filters, is capped at 5,000,
  is formula-safe (CSV too), and is logged without the clients. Phones export as digits.

## Permissions (new keys, nobody granted anything by the migration)

`clients.view` (read-only roles get it like every other `.view`), `clients.create`, `clients.update`
(edit, channels, tags, assignee, consent, notes, bulk edits), `clients.archive` (archive/restore),
`clients.delete`, `clients.import`, `clients.export`. Every action checks its own key on the server.

## The spreadsheet library (`xlsx`)

`apps/web` reads and writes CSV/XLSX with SheetJS. The npm registry still serves `xlsx@0.18.5` as its latest
release, which carries GHSA-4r6h-8v6p-xvw6 (prototype pollution, fixed in 0.19.3) and GHSA-5pgg-2g8v-p4x9
(ReDoS, fixed in 0.20.2); SheetJS publishes its patched releases only from its own CDN. The dependency is
therefore `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (SheetJS's documented install method), pinned in
`pnpm-lock.yaml` with its sha512 integrity, so a changed tarball fails the install. Trade-offs: an install
(including the Docker build's `pnpm install`) needs to reach `cdn.sheetjs.com` as well as the registry, and
`pnpm audit` matches advisories by registry name and version, so it reports 0.20.3 as clean but would not
notice a future advisory for a tarball URL on its own — re-check SheetJS's changelog when upgrading. Version
0.20 has no runtime dependencies (the 8 transitive packages 0.18.5 pulled in are gone from the lockfile).
Behaviour change worth knowing: `sheet_to_json` now returns a JS `Date` for a number cell with a date format;
files written by the exports are unchanged (numeric serial + format).

The import's own protections do not rely on the library being safe: 2 MB file limit, parse stops at the row
limit (`sheetRows`), 240-column cap, 4 M total characters, per-cell 1,000 characters, field names that would
reach the prototype dropped, errors logged by code only. `clientsValidation.integration.test.ts` pins them,
plus a guard that fails if the installed SheetJS is older than 0.20.2.

## Client billing (stage 4A, migration `20261013100000_client_billing`)

`ClientDue` (a Dhaka calendar day, optional amount, currency, status UNPAID / PARTIALLY_PAID / PAID /
WAIVED / CANCELLED, paid amount, note), `ClientDueEvent` (the audit: append-only, the database refuses an
UPDATE) and `ClientBillingCurrency` (the project's enabled currencies, **empty to begin with**). Same
project-isolation machinery as the rest of the module. Rules worth not undoing:

- **Keys:** `clients.view_billing` and `clients.edit_billing`. Neither ends in `.view`, so Read Only does not
  receive amounts or dates; `.view_billing` counts as a read key for a READ access level and a suspended
  project, so billing can be looked at there but never changed.
- **A currency is required only when an amount is present**, and only from the project's list. A currency
  typed without an amount is dropped. A due keeps the currency it was saved with when the list drops it.
- **A settled due is never deleted** (cancel it). Deleting a CLIENT deletes its dues and events by cascade
  (the confirmation says so).
- **The timeline says THAT billing changed, never an amount or a date** (the timeline needs only
  `clients.view`); amounts live in `ClientDueEvent`, shown with `clients.view_billing`.
- **Overdue and "next due" are derived at read time** from open dues against today in Dhaka (`summarizeDues`),
  never stored. A due today is upcoming.
- **An edit is conditional on the row as it was read** (`updatedAt`), so two people editing one due cannot
  silently overwrite each other.
- Pages: the Billing card on a client and **Clients → Dues** (`/clients/dues`, with the currency list).
  The client list does not yet show a next-due column.
- **Rollback (verified on a throwaway database, then re-applied cleanly):** delete the two permission rows,
  drop `ClientDueEvent`, `ClientDue`, `ClientBillingCurrency`, the type `ClientDueStatus` and the function
  `client_due_event_immutable()`, and delete the migration's `_prisma_migrations` row. It destroys every due,
  so use it only before real dues exist; after that roll forward.

## Linked WhatsApp chats (stage 4B, migration `20261013110000_client_chat_link`)

`ClientWhatsAppChatLink`: a person's statement that a one-to-one chat on an account IS a client. Key
`clients.link_whatsapp_chat` (an authorized admin's key, apart from `clients.update`; granted to nobody by the
migration; Read Only does not get it). Rules worth not undoing:

- **Manual, one chat at a time, confirmed.** Only a chat the account ALREADY holds (a stored message with no group
  and an `@c.us` / `@lid` id) can be linked: never a group, never a number typed from memory. No automatic link, no
  "link all", no link from an import.
- **A number match is only a suggestion.** A chat whose number equals one of the client's WhatsApp numbers is
  marked "Suggested: same number" and listed first; it links nothing. A `@lid` carries no number, so it is never
  suggested (an admin can still link one deliberately).
- **One active link per (account, chat)**, enforced by a partial unique index, so two admins linking one chat
  at once end with one link. A removed link is kept (`unlinkedAt/By`) and frees the chat. A CHECK constraint
  keeps a group id out of the table.
- **Audit:** the client timeline says a chat was linked or removed (never the number); a System Log entry
  records the ids. Deleting a client removes its links.
- **A link enforces nothing yet** and nothing is sent because of one: a later stage reads it to address an
  individual campaign. Visible to anyone who can open the client; changed only with the key.
- Not built: linking from WhatsApp Chat's contact panel (only from the client page).
- **Rollback (verified on a throwaway database, then re-applied cleanly):** delete the permission row, drop
  `ClientWhatsAppChatLink` and the migration's `_prisma_migrations` row. Use only before real links exist.

## Not built (deferred, nothing here depends on them)

Sending of any kind, due reminders, campaigns and the bulk messaging centre, message templates, reminder policies and the
scheduler, notices and approvals, tasks and follow-ups, the dashboard and reports, saved filters and
segments, automatic or manual **merge**, billing integration, email/SMS providers, WhatsApp 1:1 sending
policy. Decisions still open: email/SMS provider and credentials; whether WhatsApp may
message individuals (this product's rule today is answer-only, never first-contact); notice approval;
expected client and campaign volume.

## Tests

`packages/shared/src/__tests__/clients.test.ts` (pure rules),
`apps/web/src/__tests__/clients.integration.test.ts` (CRUD, permissions, feature switch, duplicates, project
isolation, archive/delete, notes, channels, consent, bulk),
`apps/web/src/__tests__/clientsImportExport.integration.test.ts` (import preview/confirm/policies/idempotence,
export permissions, filters, formula safety, cap, isolation),
`packages/shared/src/__tests__/clientBilling.test.ts` and `apps/web/src/__tests__/clientBilling.integration.test.ts`
(billing rules, permissions, currency list, audit, isolation),
`packages/shared/src/__tests__/clientChatLinks.test.ts` and `apps/web/src/__tests__/clientChatLinks.integration.test.ts`
(chat-link rules, permission, one active link, suggestions, timeline, isolation). Web integration tests run only through
`pnpm --filter @support-automation/web test:isolated` (the throwaway `postgres-test` database).

## Deploy and rollback

Deploying applies the migration (new empty tables, a sequence, seven permission rows; the billing migration adds three more empty tables and two rows) and ships the code;
the feature stays off until a Main Admin enables it per project.

**Rollback, verified** on a throwaway database with a client, channel, note, activity, import job, a project
feature row and a role grant present (it ran in one transaction and the migration then re-applied cleanly):

```sql
BEGIN;
DELETE FROM "ProjectFeature" WHERE key = 'CLIENT_CENTER';
DELETE FROM "Permission" WHERE key LIKE 'clients.%';   -- role grants cascade
DROP TABLE "ClientActivity", "ClientNote", "ClientChannel", "Client", "ClientImportJob";  -- triggers go with them
DROP TYPE "ClientDuplicatePolicy", "ClientImportStatus", "ClientConsentStatus", "ClientChannelKind", "ClientSource", "ClientStatus";
DROP SEQUENCE "client_code_seq";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261012100000_client_center';
COMMIT;
```

It touches nothing outside the module (staff, teams, projects and every other table are intact). **It destroys
every client record**, so use it only before real clients exist. Once they do, roll FORWARD: switch the feature
off per project (data kept), fix, redeploy. A code-only rollback is also safe: the tables are inert to old code.
