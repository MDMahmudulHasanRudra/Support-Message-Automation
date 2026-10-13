# Client Management (CLIENT_CENTER)

One client database for a project, whatever channel the client uses. **Phases 2 and 3 are built**
(records, CRUD, duplicates, list, details, import/export, timeline, per-channel consent data).
Phases 4–8 (sending, campaigns, reminders, notices, tasks, dashboard) are **not** — see "Not built".

## What it is, and is not

- A **project feature**, `CLIENT_CENTER`, **off by default** for every project. A Main Admin switches it on
  (Main Admin Portal → the project's features). Off: the pages 404/redirect, every action refuses, the sidebar
  hides it. Nothing runs in the worker for it.
- **No billing.** No invoices, balances or due dates exist in this module, and none are invented: the
  company's billing lives in its own system and is not connected (the client page says so). When a billing
  source is chosen it is read, not copied into a second ledger.
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

## Not built (deferred, nothing here depends on them)

Sending of any kind, campaigns and the bulk messaging centre, message templates, reminder policies and the
scheduler, notices and approvals, tasks and follow-ups, the dashboard and reports, saved filters and
segments, automatic or manual **merge**, billing integration, email/SMS providers, WhatsApp 1:1 sending
policy. Decisions still open: billing source; email/SMS provider and credentials; whether WhatsApp may
message individuals (this product's rule today is answer-only, never first-contact); notice approval;
expected client and campaign volume.

## Tests

`packages/shared/src/__tests__/clients.test.ts` (pure rules),
`apps/web/src/__tests__/clients.integration.test.ts` (CRUD, permissions, feature switch, duplicates, project
isolation, archive/delete, notes, channels, consent, bulk),
`apps/web/src/__tests__/clientsImportExport.integration.test.ts` (import preview/confirm/policies/idempotence,
export permissions, filters, formula safety, cap, isolation). Web integration tests run only through
`pnpm --filter @support-automation/web test:isolated` (the throwaway `postgres-test` database).

## Deploy and rollback

Deploying applies the migration (new empty tables, a sequence, seven permission rows) and ships the code;
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
