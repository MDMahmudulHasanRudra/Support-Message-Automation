# Smart Bulk Import (Clients)

Status: built on `rudra`, behind the project feature `CLIENT_SMART_IMPORT` (off by default and never switched
on by a plan). With it off, Clients → Import is exactly the import that existed before.

Import up to **5,000 clients** from **any** Excel/CSV file (up to **15 MB**). No template is needed: the person
says, field by field, where each client field comes from.

## 1. Audit of the import that existed (23 Oct 2026)

| Area | What existed | Kept / changed |
|---|---|---|
| Upload | Server Action, 2 MB, 2,000 rows, first sheet only, `rows` JSON on the job | New: an authenticated Route Handler, 15 MB / 5,000 rows, sheet and header-row choice. The old path is untouched. |
| Mapping | `autoMapColumns` (synonyms), one column → one field (`remapClientImport` refused a column used twice) | Kept for the old path. New mapping v2: from-file (with an optional fallback column), same value, sample value, empty. One column may feed several fields. |
| Rules | `buildImportRows` + `resolveRows` + `findInFileDuplicates` (packages/shared, server) | **Reused unchanged.** Mapping v2 only decides each field's TEXT; every rule after that is the existing one. |
| Writes | `createRow` / `updateRow`, one transaction per row | Reused: split into `writeImportedClient(tx, …)` so the new processor can record the row's outcome in the SAME transaction. The old path calls them exactly as before. |
| Processing | Inside the confirm request; a restart left the job PROCESSING until closed by hand | New: a background processor in the app process (`instrumentation.ts`), batches of 25, a 60 s lease, resumes after a restart. |
| Duplicates | Skip / Update / Create policy; matches read once before the run | Same policies. The new processor re-reads matches per row INSIDE the row's transaction, under an advisory lock on each identifier, so two imports cannot both create the same client. |
| History | `ClientImportJob` list, clear history (never clients) | Same table and page. New columns are additive; old jobs read as before. |

Limits found: the 2 MB Server Action ceiling, no per-row state (so no editing, no resume, no truthful progress), a
mapping that could not reuse a column, no wrong-file checks beyond "needs a Name column".

## 2. Decisions

1. **The file is parsed in the upload request, the rows are staged in Postgres** (`ClientImportRow`, one row per
   file row: source cells, the person's corrections, ignored, outcome). Not one JSON column: per-row edits,
   paging, filtering and per-row idempotency need rows. The uploaded file is also kept privately on the media
   volume (`imports/<projectId>/<jobId>`, never served) only so another sheet or header row can be chosen; it is
   deleted when the import is confirmed, discarded or expires.
2. **Validation is derived, never stored.** Every review read recomputes it from the staged rows, the mapping and
   the database (the project's own rule: a stored derivation drifts). It is cached per job revision for 30 s.
3. **Every change bumps `revision`; confirming names the revision the person reviewed.** A confirmation from a
   stale tab is refused, so what is imported is what was reviewed.
4. **The background processor runs in the APP container**, started from `instrumentation.ts`, not in the WhatsApp
   worker: the import's business logic already lives in the app, and a 5,000-row import must not compete with
   message collection. No Redis, no queue library: a conditional-update claim and a lease.
5. **Row-level idempotency.** A row's client write and its `outcome` change commit in one transaction, and the
   outcome change is conditional on the row still being PENDING; if it is not, the transaction rolls back. A
   retry, a restart or a second process can therefore never write a row twice.
6. **Cancel stops between batches.** Committed rows stay committed and are reported as such; nothing is ever
   rolled back or deleted by a cancel.
7. **Sample values are opt-in per field** ("Use sample value"). They are shown before they are chosen, labelled
   as samples in the preview, and never applied by themselves. On an identifier field (phone, email, WhatsApp,
   code, channels) the same value on every row makes every row the same client — the mapping editor says so,
   and the review shows those rows as repeats rather than hiding it.
8. **Uncertain column matches are suggestions.** Exact synonym matches are applied; a "looks like" match is
   offered with one click and never applied silently.

## 3. Job state machine

```
           upload ok                     confirm(revision)                claim
 (none) ───────────► PREVIEW ─────────────────────────────► QUEUED ───────────────► PROCESSING
                     │  ▲ map / edit / sheet: revision+1     │ cancel                 │ batches of 25
                     │  └───────────────┘                    ▼                        │ cancel request → stops before next batch
                     │ discard          ┌──────────────── CANCELLED ◄─────────────────┤
                     ▼                  │                                             ▼
                 CANCELLED              │  retry (failed / not-attempted rows only)   COMPLETED | PARTIAL | FAILED
                 EXPIRED (7 days)       └─────────── QUEUED ◄─────────────────────────┘
```

Row outcomes: `PENDING → CREATED | UPDATED | SKIPPED | INVALID | FAILED`, `IGNORED` (the person excluded it).
A job's counters are read from its rows (`groupBy`), so progress is the database's own count, never an estimate.

## 4. Threat model (uploads are untrusted)

| Threat | Control |
|---|---|
| Oversized upload | Content-Length checked before reading; 15 MB file cap; proxy body cap 17 MB |
| Zip bomb in .xlsx | Central directory read BEFORE parsing (`inspectXlsxZip`): ≤ 2,000 entries, ≤ 120 MB uncompressed total, ≤ 100:1 ratio on large entries |
| Huge sheet | `sheetRows` stops parsing at 5,002 rows; ≤ 100 columns; ≤ 5,000 characters per cell; ≤ 20 M characters in all |
| Macros / formulas / external links | Never evaluated: cached values only (`cellFormula: false`); a workbook carrying `vbaProject.bin` is refused |
| Spoofed type | .xlsx must be a zip with `[Content_Types].xml`; .csv must be text (no NUL bytes) |
| Formula injection on export | The problem-rows file prefixes `= + - @` cells with `'` |
| Formula-looking values stored | A name or company starting with `=` or `@`, or `+`/`-` followed by a letter, is an invalid row |
| SQL injection | Prisma only; destination fields are a fixed list; a mapping naming an unknown field is refused |
| XSS | React escaping only; no HTML is rendered from file content |
| URLs in data | Stored as inert text; never fetched |
| Cross-project access | The project-scoped client on every read and write; new tables carry `projectId` with same-project and immutable triggers |
| Permissions | `clients.import` on every action and route, plus the feature; subscriptions only with the existing subscription right |
| Logs | Counts, ids and the file name only — never a row's values |

## 5. Retention

Staged rows: deleted 7 days after an import finishes (or immediately when a draft is discarded). Drafts not
confirmed within 7 days: EXPIRED, rows and file deleted. The history keeps counts and up to 200 row errors.

## 6. What a person sees

1. **Clients → Import Clients** (with the feature on) is "Smart Bulk Import": choose Quick (recognised columns are
   matched, straight to the check) or Advanced (map every field), drop a file. The upload shows real bytes sent;
   reading the file shows an honest "reading…" (it has no percentage).
2. **Match columns**: every client field, grouped, with four choices — *From file* (a column, and an optional
   "if empty, use" column), *Same value* (typed, or picked for status / subscription type / duration unit),
   *Sample* (the software's sample, shown before it is chosen; roster fields use this project's own first team
   and person), *Leave empty*. A preview of the first values under each field; the file's columns on the side,
   showing which fields each one feeds. Possible matches are buttons, never applied by themselves. Saved
   mappings (presets) can be applied, saved (personal or shared) and deleted by their creator.
3. **Check rows**: tiles (rows, ready, new, existing, need fixing, repeats / left out), filters, search, 25 / 50 /
   100 rows per page. Every cell can be corrected in place (Enter saves, Escape cancels); a corrected cell is
   marked; a row can be left out, brought back, or reset to the file. "Set a field for these rows" sets one
   non-identifying field on the rows a filter shows, after showing how many. Problems are listed under their
   row; "Download rows that need fixing" gives them with reasons. What blocks the import, and what needs a
   tick, is said above the Import button, which names how many clients it will write.
4. **Import**: live counts from the server (created, updated, skipped, not imported, waiting), "live from the
   server · time", "Reconnecting…" when the connection drops. Stop (after the current batch), or — while still
   queued — go back to the review. At the end: view clients, download the rows not imported, retry the rows
   that failed or were never attempted.

## 7. Tests and measurements (24 Oct 2026, throwaway database)

| Suite | Result |
|---|---|
| `packages/shared/src/__tests__/clientSmartImport.test.ts` — mapping modes, one-to-many, fallback, corrections, Bangla / international names, invalid phone / email / date / status, formula / link-only / control-character names, inert script text, sanitising (unknown field, column, prototype keys, invalid constants), wrong-file checks, 5,000 / 5,001 rows, columns, cell size, header detection, zip inspection (bomb, total size, macros, encryption, Zip64, not a workbook, OLE/password, truncated), export escaping | 46 passed |
| `apps/web/src/__tests__/smartImport.integration.test.ts` — upload (CSV, xlsx numbers and dates, 5,000 ok, 5,001 / >15 MB / renamed / binary CSV / other type refused, storing nothing), permission and feature off, Scenario B, C, D, stale revision, formula and XSS values, problem-rows download (text cells, no formulas), bulk set limits, presets, sheet choice, Scenario G restart, two processors + two imports of one client, Scenario F cancel (between runs and mid-run), queued → back to review, SKIP / UPDATE matches, held project waits, Scenario H project boundary, expiry sweep, discard | 23 passed |
| Break-tests: the conditional row settle, the per-identifier lock + in-transaction re-read, the revision check, the mid-run cancel check, the zip inspection | each removed in turn → its test failed |
| Browser walkthrough (headless Chromium against an isolated dev server): upload → map (fallback, same value, sample) → check → correct a cell by keyboard → import → live progress → done; dark mode; 390 px phone (quick mode, review, mapping) | completed; no horizontal scroll, nothing clipped |

Benchmark (`SMART_IMPORT_BENCH=1`, synthetic rows, local Docker Postgres):

| Step | Time | Memory |
|---|---|---|
| Upload + read + stage 5,000 rows (1.2 MB .xlsx) | 1.5 s | rss ≈ 205 MB |
| First check of 5,000 rows | 1.4 s | +29 MB heap |
| Next page (cached) | 46 ms | — |
| Import 5,000 new clients (processor) | 130 s (≈ 26 ms / client) | rss ≈ 361 MB |
| Upload + read + stage a 14.5 MB .xlsx (5,000 rows, long notes) | 3.3 s | rss ≈ 366 MB |

## 8. Known limits

- One import is processed at a time per app process, about 26 ms per client: 5,000 clients take ~2 minutes.
  Others wait in the queue (shown as "waiting to start").
- A workbook is read inside the upload request (at most two at once). Its size is bounded before it is opened
  (zip directory, rows, columns, cells) but reading cannot be interrupted part-way.
- Choosing another sheet needs the upload kept on the media volume (`MEDIA_STORAGE_DIR`, present in Docker).
  Without it, the button is hidden and a second sheet means uploading again.
- Rows that were INVALID when the import ran are not retried: correct them in a new import (download them).
- Undo is per row ("Undo every correction on this row"), not per keystroke.
- The browser walkthrough is a script run for this release, not a committed end-to-end suite (the repository has
  no browser test runner).

## 9. Deploy and rollback

Deploy (app and migration; the WhatsApp worker's behaviour is unchanged):
```
docker compose build app worker migrate
docker compose run --rm migrate          # 20261024090000_client_smart_import
docker compose up -d --no-deps --force-recreate app worker
```
Then switch it on per project: Main Admin → the project → Features → "Clients — Smart Bulk Import" (it needs
Client Management). No plan switches it on.

## 10. Rollback

Switch `CLIENT_SMART_IMPORT` off: the old import is back, nothing else changes. The migration is additive (two
enum values, columns with defaults, two tables); the old code never reads them.

## 11. Review grid and flexible expiry (24 Oct 2026)

**Root cause of what was missing.** The review showed only fields that were mapped or corrected, so an empty
field could not be filled; errors were row-level sentences, so a whole row looked wrong for one cell; and the
import's own subscription rule (`validateSubscription`) silently prefers a duration over an explicit expiry, needs
a start date, and has no notion of separate year/month/day columns or a month without a day.

**Review grid.** Every import field is always a column, in the official template's order (`SMART_REVIEW_ORDER`,
pinned against `IMPORT_TEMPLATE_COLUMNS` by a test). Every cell is editable (click or Enter; Enter saves, Escape
cancels; the arrow keys move between cells; a date picker for the two date fields; "back to the mapped value" per
cell, "undo every correction" per row). Each problem is a structured `FieldIssue` on the field it concerns
(`fieldIssues`, `clientSmartImport.ts`; team / staff / seller / country / currency by `rosterFieldIssues` on the
server): red for an error, amber for a warning, nothing for an empty optional cell — only that cell, never the row.
The import's verdict on the whole row stays the authority, and a refusal no single field explains is still shown.
A row that needs fixing also lists its problems under it (visible when a column is hidden or scrolled away).
Sticky header and first columns, horizontal scrolling inside the grid, a "Columns" picker (all shown by default,
the choice kept per browser). Server paging is unchanged (25 / 50 / 100 rows).

**Expiry (`packages/shared/src/clientSmartExpiry.ts`).** Every row ends with ONE exact `YYYY-MM-DD` or a problem:

| Method | Input | Result |
|---|---|---|
| A — complete date | 2027-07-24 · 24/07/2027 · 24 Jul 2027 · an Excel serial | that date (the import's own `parseImportDate`, day first, month-first never guessed) |
| B — separate parts | Expire Year / Month / Day columns (synonyms auto-matched; a month may be a name) | composed; leap years checked; a missing or two-digit year, a month outside 1–12 and a day the month does not have are cell errors |
| C — start + duration | Start date, Duration, Duration unit | the subscriptions' own calendar-aware `addDuration` (31 Jan + 1 month = 28/29 Feb); shown with "Calculated from Start date + 9 months" |
| D — expiry, no duration | an exact expiry and a start date | the term ends on that date |
| D — expiry, no start | an exact expiry and NO start date | **"Expiry on record"** on the client (`Client.recordedExpiryDate` / `recordedExpiryService` / `recordedExpiryAt`, migration `20261024120000_client_recorded_expiry`): shown on the profile under Current subscription, labelled as not a term. No start date is invented and no subscription, state, renewal or due is created. Written only for a person allowed to manage subscriptions, like a term. |
| E — month + year | July 2027 · Jul-2027 · 2027-07 · 07/2027, or year + month parts | kept in review until the day is given, unless "Use the last calendar day of the month" is explicitly chosen in the mapping |

**Conflicts.** An explicit expiry that equals Start date + Duration is accepted. One that differs is an error on
both the Expiry date and Duration cells unless the mapping explicitly says "use the file's expiry" (the duration
is dropped, so the stored term has no contradicting duration) or "use the calculated expiry". Typing an expiry on
the review screen for a row that has a duration clears that row's duration and says so. The original import
(`validateSubscription`'s precedence) is unchanged.

**Mapping editor.** An "Expiry date — how your file gives it" panel: Complete date / Separate year-month-day /
Start date + duration / Month + year, auto-detected from the mapped columns and changeable; the part columns, the
day policy and the conflict rule appear only where they apply. Mapping v2 gains the three part keys and
`options` (`expiryMode`, `monthYearPolicy`, `expiryConflict`); old mappings read unchanged.

**Tests (throwaway database).** `clientSmartExpiry.test.ts` (42: every method, leap years, month ends, year
transitions, ambiguous and impossible dates, conflicts, expiry-only, field attribution, mapping);
`smartImportExpiry.integration.test.ts` (9: column order against the template, empty cells editable, cell-level
issues, correction + undo revalidated, 1 / 9 / 12-month terms imported with the right end dates, parts, impossible
day, expiry-only recorded with no term and no due, no right → nothing written, conflict blocked then resolved,
typed expiry clears duration, month+year last-day policy, no duplicate term on re-import). Break-tests: a
conflict resolved by default, a day invented by default, the expiry-only path removed, and the composed-expiry
issue check — each removed → its test failed. A browser walkthrough (desktop, dark, 390 px) on a mixed file.

**Known limits.** A recorded expiry is shown on the client profile only (not on lists or reports, by design — it
is not a term). Choosing a conflict rule applies to every row; a single row is resolved by correcting a cell.


## 12. Smart Import V5 (31 Oct 2026) — Visual Mapping, phones, locale, amounts

`docs/smart-import-v5/README.md` is the release write-up (screenshots, limits); this section is the rulebook.

**Finding first.** The "approved horizontal Visual Mapping grid" did not exist anywhere in this repository, on
any branch or worktree, or in the design folder supplied with the request. Before V5 the mapping screen was the
vertical field list only. V5 builds the grid and makes it the default; nothing was "restored".

**Visual Mapping grid (`MappingGrid.tsx`, `mappingView.ts`, `lib/smartMappingPreview.ts`).**
- The first mapping screen is ALWAYS the grid: Get Assist fields across the top (grouped, required marked), the
  Excel-column picker under each (searchable, keyboard), the fallback / constant control under that, then up to 8
  REAL staged rows aligned under each field, and under each value what will be stored (E.164, derived country /
  currency / language, a refused value in red). Previews come from `ClientImportRow` rows of the same import
  (`loadSmartMappingContext.previewRows`), never from a re-read of the file, so they are the rows the import runs on.
- The vertical "Detailed view" stays as a secondary toggle over the SAME mapping state. The choice is remembered
  per browser (`readMappingView` defaults to "grid" whatever was stored that is not "detailed").
- One save path for both views (`mappingToSave`), pinned by a test — the first version silently dropped
  `fillLocale` on save. "Save mapping and review rows" moves to the editable review.
- From File / Same value / Sample / Leave empty, fallbacks, the expiry panel, suggestions and saved mappings are
  unchanged and available in both views.

**Which sheet ("0 rows").** Root cause: the import always opened the FIRST sheet, and real workbooks often start
with a cover or instructions sheet — every row was then "empty". Now each sheet is scored (`scoreSheet`: recognised
headers × 10 + data rows, capped) and the best one opens, with a notice naming it and why; "Change sheet or header
row" still overrides. A one-sheet file is unchanged.

**Phones (`lib/clientLocale.ts`, libphonenumber-js).** `normalizePhone(raw, country)` returns VALID / AMBIGUOUS /
NEEDS_COUNTRY / DAMAGED / INVALID. `966…` and `00966…` become `+966…`; a `+` is never doubled and a code never
repeated; a local number is read in the row's country, else the project's default country; Excel damage
(`8.80171E+12`, a lost leading zero that cannot be put back with certainty) is DAMAGED and goes to review, never
guessed; several numbers in one cell are split (`;`, `|`, a new line, a comma before another number, ` / `). Only a VALID number is stored as
E.164 in `ClientChannel.value`; anything else is kept exactly as written and flagged. Matching an existing client
also tries the old digits form (`legacyMatchKey`), so numbers stored before V5 still match — removing it fails a
test.

**Country, currency, language.** Precedence: the file's value > what the person typed in review > derived from a
VALID phone (only when "Fill an empty country, currency and language from the phone" is ticked — on by default) >
the project's default country > left for review. Labels: From Excel / Manually selected / Auto selected / Needs
review. A derived value only ever fills an EMPTY field: on an existing client it never replaces a stored value
(`derivedSkip`, break-tested). The review shows an auto value in blue with an "Auto" tag, and each phone with
"Saved as +…" when the stored form differs from the cell.

**Amounts (`packages/shared/src/clientImportMoney.ts`, `MoneyPanel.tsx`).** No amounts / one amount column + a
currency (column or fixed) / one column per currency (auto-detected from headers). Header and cell aliases:
RAND→ZAR, TK→BDT, KSH→KES, USA→USD and every ISO code; an ambiguous word (rial, riyal, din/dinar, dirham/dh, $/dollar, rs/rupee, kr,
shilling, franc, peso, ¥, ﷼) must be confirmed by the person and is never guessed. Cells such as `SAR30.00`, `dh30.00`,
`Rial4.000`, `din8.000`, `din2.550`, `7.35`, `500/-` are read exactly as text; zero records nothing; a row with
amounts in several currencies is a review WARNING that must be acknowledged before importing (`MONEY_MULTIPLE`); an
unreadable amount is MONEY_PROBLEM on that row.
- **What importing does with them: records only.** Each amount lands in `Client.importedAmounts` (JSON: currency,
  amount as text, the column, the original cell, the file) and is shown on the profile under "Amounts recorded at
  import" to viewers with `clients.view_billing`. It is NEVER a due, invoice, receipt, payment or balance, never
  converted, never summed across currencies. Re-importing the same file does not duplicate (file | column |
  original). An integration test asserts no billing row exists after an import with amounts.

**Kept columns.** A column no field reads can be ticked (up to 20) and is stored as a custom field named after its
header; on an update only that custom field is replaced. Unticked columns are not imported, as before.

**Project lists.** Category, tags and business type are matched to Settings → Client Lists (name or alias, case-
insensitive) and stored in the list's own spelling; a value not on a list is kept as typed (a list never blocks an
import). A Plan column is matched to a plan's name/aliases only when mapped to Service. The legacy auto-match of a
"Plan" header to Category is unchanged on purpose: mapping it to Service makes every row a subscription that then
needs a start date.

**Tests.** shared: `currencyCatalog`, `clientImportMoney`, `clientConfiguration`, `moneyPrecision`; web:
`smartMappingGrid` (10), `clientLocale` (10), `smartImportSheets` (4), `smartImportV5.integration` (6),
`clientConfiguration.integration` (12). Break-tests: `legacyMatchKey`, `derivedSkip`, `mappingToSave`.

**Migrations.** `20261031090000_client_configuration`, `20261031100000_client_imported_amounts` — additive only.
