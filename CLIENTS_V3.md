# Clients V3 — subscriptions, billing, payments, WhatsApp groups and the 360° register

Status: **built on `rudra`, not deployed.** Migration `20261017100000_clients_v3` (additive). Feature `CLIENT_CENTER`
stays **off by default**; everything here lives inside it. Extends `CLIENT_CENTER.md` (records, dues, chat links,
email), which still describes the parts this did not change.

## 1. What changed for the person using it

| Page | Route | What it is now |
|---|---|---|
| All Clients | `/clients` | A 360° register: identity (photo, code, "Returning"), country with flag, phone with a WhatsApp mark, service, expiry with "N days left", subscription state, outstanding **per currency** (billing viewers only), sold by, linked WhatsApp group. Five KPI cards (total with "+N this month", linked groups, renewal attention, outstanding per currency, returning); view chips (All, Active, Renew soon, Trial, Expired, Overdue, Inactive, Archived) with counts; a filter bar whose drop-downs apply themselves; row actions (view, renew, WhatsApp, and a ⋯ menu with edit, payment, links, archive and — for someone allowed — delete). |
| Add client | `/clients/new` | A guided form: photo (resized in the browser, re-checked and stripped on the server), identity, worldwide phone (E.164) with country/currency **suggestions**, Team → staff → seller from the real roster, an existing WhatsApp group picked by account and **confirmed**, an optional first subscription. Every ordinary field optional unless the project requires it; a client with nothing but a code needs a separate press. |
| Client page | `/clients/<id>` | A profile header (photo, code with copy, status, country, "Repeat customer"; Edit / Renew / Record payment / Open WhatsApp group, Archive and Delete under ⋮), six fact cards, then tabs as URL state (`?tab=`): **Overview** (client information, current subscription with term progress, team & ownership, billing summary per currency, WhatsApp, recent payments, recent activity, subscription history; `?edit=1` opens the editor), Subscriptions, Billing, Payments, WhatsApp & channels, Activity & notes. A tab the viewer may not see falls back to Overview; billing figures are still read only with `clients.view_billing`. |
| Subscriptions | `/clients/subscriptions` | Every client's current term, soonest expiry first. Six KPI cards and chips (All, Active, Renew soon, Trials & demos, Expired, Paused); filters for service, seller, team and country; a days-left bar; View plus a ⋯ menu (Renew, Pause/Resume, Cancel on profile, Delete); bulk delete for someone allowed. |
| Billing List | `/clients/dues` (route kept) | Invoices with number/type, client, service, seller, due, billed, collected, remaining, status; KPI cards and view chips with counts; column chooser; filters; **Pay selected** with an editable amount per invoice; Create bill; Delete (single or selected) for someone allowed. |
| Payments & Receipts | `/clients/payments` | Every receipt, the invoices it settled, collected per currency, and **Reverse** (with a reason). KPI cards, Recorded / Reversed / All chips with counts, filters for method, currency and received dates; Delete (single or selected) for someone allowed. |
| Settings → Client Module | `/settings/clients` | Sub-module switches, required fields, renewal window, default country for local numbers. |

| Import Clients | `/clients/import` | Three steps (17 Oct 2026, see §Import): **download the template** (or "Template with my clients"), fill it in (a guide on the page and inside the file), drop the file to preview. |

Unchanged: channels and consent, notes, the personal chat links, Email settings, Chat V1/V2, workers, AI. The export gained columns (country, currency, team, seller, service, start, expiry,
subscription state, linked groups) — never an amount.

### Delete (17 Oct 2026)

- **Who.** The Administrator (Main Admin) by default; anyone else only when an Administrator gives their role
  "Delete Anything in Clients" (`clients.delete`) on Permission Modules. `canDeleteClientRecords` is the one rule and
  `caps.canDelete` carries it to every page; a control is rendered only for that viewer and the action checks again.
- **Only an Administrator can give it.** `clients.delete` is in `ADMIN_GRANTED_KEYS`: `adminGrantRefusal` refuses
  anyone else ADDING it to a role (keeping it on a role that has it is not refused). It is not project-assignable, so
  a project role or a Lead never carries it, and the `ProjectRole_no_platform_keys` CHECK refuses it in the database.
  Migration `20261017200000_clients_delete_admin_granted` removed it from every role that is not a Main Admin role —
  under the previous rule it granted nothing, so nobody lost anything they could do.
- **What can be deleted** (`server/actions/clientDeletes.ts`): clients (as before), subscriptions, invoices, payments
  and notes, single or selected. Each delete is on the client's timeline and in the System Log.
  - A subscription: the current term is recomputed under the client lock; its invoices stay, unlinked.
  - An invoice: refused while a recorded (unreversed) payment settles it — reverse or delete that payment first.
  - A payment: an unreversed one is first taken off the invoices it settled (exactly what a reversal does).
  - A note: the timeline says a note was deleted, not what it said.
- **Archive, cancel, pause and reverse stay the everyday tools**; every delete dialog says so.
- Tests: `clientDeletes.integration.test.ts` (7). Mutation-checked: anyone-may-delete, no grant gate, refusing to keep
  the key, no current-term recompute and no payment unwind each fail a test. The settled-invoice guard is two layers (a
  pre-check and a conditional delete); removing either alone is covered by the other, removing both fails the test.

### Import (17 Oct 2026)

- **The template is built for the project** (`server/clientImportTemplate.ts`, `GET /api/clients/import/template`,
  `clients.import`). It has four sheets. **Clients** comes first, because the import reads the first sheet. **Example**
  holds three fictional rows. **How to fill** describes every column with an example and its accepted values.
  **Lists** feeds the drop-downs: Status, Subscription type, Duration unit, this project's ACTIVE teams and staff,
  countries, and currencies with the project's billing currencies first.
  - Each column has a tip (an input prompt). The header and first column are frozen.
  - Phone and code columns are text, so leading zeros survive. Date columns are `yyyy-mm-dd`.
  - Enum drop-downs refuse other values. Roster, country and currency drop-downs only warn, because a phone number
    or a two-letter code is also accepted.
  - SheetJS CE cannot write validations or styles, so `server/xlsxWriter.ts` writes the OOXML itself, with no new
    dependency.
- **"Template with my clients"** (`?data=current`) also needs `clients.export`. It holds what the list's default
  view shows this person: the same `buildClientWhere`, non-archived, capped at 2,000. It is logged like an export.
  Edit the rows, re-upload, and choose Update.
- **The headers map themselves.** Every template header is a synonym in `CLIENT_IMPORT_FIELDS`. Another program's
  headers map too: Mobile, Join.Date, Exp.Date and Assign2Emp. (header normalisation trims after replacing dots).
- **V3 columns are imported:** Country, Preferred currency, Team, Assigned staff, Sold by, Service / plan,
  Subscription type, Start date, Duration, Duration unit, Expiry date.
  - **Parsing is pure** (`packages/shared/src/clientImportExtras.ts`):
    - Dates are day-first or ISO, with month names, or an Excel date serial. Month-first (10/31/2026) is never guessed.
    - A subscription is accepted or refused whole.
    - A duration with no unit is in months.
  - **Resolution is on the server** (`server/clientImportExtras.ts`), against this project's roster:
    - A name the roster does not know, a shared name ("write their phone number instead"), an inactive member, a
      disabled team, or staff outside the chosen team refuses the row with that sentence. It is never a guess.
  - **Subscriptions are imported only for someone who may sell them** (`clients.manage_subscriptions` with the
    sub-module on). Anyone else imports the clients without them, and the preview says so beforehand.
  - **A re-imported file adds no second term** (same service, start and end).
- **The template checks itself while it is filled in** (17 Oct 2026, `xlsxWriter` `highlights` / `between` / `autoFilter`):
  filter arrows on the header; red when a row has no Name, an expiry is before its start, or a duration is not a whole
  number; amber for a phone or email twice in the file, or a service with no start date. Duration accepts only a whole
  number 1–1000; the date columns warn on a non-date (a day-first date typed as text still imports). These are
  conditional-format rules and validations — no cell holds a formula.
- **Note column** → the client's first internal note; on Update the same note is never added twice.
- **Preview:** the columns that match no field are named ("Zone, Server are not imported"), and **Download problem rows**
  (`/api/clients/import/<jobId>/problems`, only while a preview — the rows are deleted afterwards) gives every refused
  row with a Problem column first and the file's columns after, ordered as the template. Fix, upload, only they import.
  The stored rows are jsonb, which does not keep column order; the route restores it.
- **Clearing import history** (`clearClientImports`): the Clients delete rule (Administrator, or `clients.delete`).
  Never a PROCESSING import or a preview from the last day; the clients an import brought in are never touched. Knowledge
  Base import history has the same Clear for an Administrator (`clearKnowledgeImports`), and its entries stay
  (`AiKnowledgeItem.importId` is SetNull). Broadcast history is deliberately NOT clearable: its rows are the record of
  mass sends and part of the never-twice guard for a job/group pair.
- Tests: `clientImportClear.integration.test.ts` (5); mutation-checked (delete rule, running/fresh kept, note
  once, Administrator-only knowledge clear, problem rows only while a preview).

## 2. Gap analysis (the V3 brief vs. what existed)

| Brief | Before | Now |
|---|---|---|
| Service / plan, expiry, subscription state, trials, renewals, returning customers | Nothing | `ClientSubscription` + `Client.currentSubscriptionId`; state derived at read time |
| Outstanding by currency, invoice number/type, seller per invoice, collected/remaining | `ClientDue` with a typed paid amount | New nullable `ClientDue` columns; numbers from `client_invoice_seq` |
| Single and batch payments, reversal, audit, idempotency | Paid amount typed by hand | `ClientPayment` + `ClientPaymentAllocation`, one transaction, row locks, idempotency key, DB guards |
| WhatsApp **group** linking | Only `WHATSAPP_GROUP` as a free channel reference | `ClientWhatsAppGroupLink`, one owner per group, history |
| Photo | None | `ClientPhoto` (bounded, stripped) + authorised route |
| Team / seller from the real roster | Assignee by id, no team/member consistency, no seller | Seller on client, subscription and invoice (id + name/team snapshot); team ⇄ member checked; disabled team refused |
| Column chooser | Fixed columns | `ListViewPreference` per person per project, sanitized against permissions |
| Per-project sub-module switches, required fields | None | `ClientModuleSettings`, enforced in every action |
| International phone, country | Bangladesh-only normalisation | `libphonenumber-js` (E.164), country from the number only when certain; old rule still accepts local `01…` |

Not built, deliberately (see §9): DRAFT invoices, tax/discount/quantity columns, invoice PDF, reminders, a sales
report, sub-module visibility in the sidebar (the pages explain the switch instead).

## 3. Rules worth not undoing

- **A subscription's expiry is not a debt.** Terms (`ClientSubscription`) and money (`ClientDue`, `ClientPayment`) are
  separate tables. A sale may raise its invoice in the same step (`kind: SUBSCRIPTION`/`RENEWAL`, `subscriptionId`),
  and that is the only link. "Outstanding" counts open invoices only.
- **State is derived, never stored** (`packages/shared/src/clientSubscriptions.ts`). The service runs while
  today < `endDate` (Dhaka). Only *which* term is current is stored (`currentSubscriptionId` = latest-ending
  uncancelled term, recomputed under the client row lock on every change) so expiry can be sorted and filtered in SQL.
  `subscriptionStateWhere` (lib/clientFilters.ts) is the SQL twin of `termState`; a test runs both over the same rows.
  A future-dated renewal reads ACTIVE (the term it follows is running); a future first term reads "Starts later".
- **Renewal starts where the old term ends**, or today when it has lapsed. The old term is kept; the new one is
  `isRenewal` with `renewedFromId`. "Returning" = any `isRenewal` term.
- **Money is integer minor units** (`toMinor`/`fromMinor`, BigInt). Storage is `Decimal(12,2)`; a currency with fewer
  decimals (JPY) refuses more; one with three (KWD/OMR) is held to two (§9). Amounts are never added across currencies
  and no exchange rate exists anywhere.
- **A payment is all-or-nothing, per client and currency.** `planPayments` refuses the whole batch on any bad line
  (overpayment, settled/waived/cancelled due, no amount, wrong decimals, duplicates). One submission key →
  `<key>:<n>` per payment, unique per project: a double press records once, also when both presses race. Dues are
  locked `FOR UPDATE` in id order, so two people paying the same invoice cannot both succeed.
- **Recorded money is immutable.** The database refuses changing a payment's client, currency, amount, number, date
  or method, un-reversing it, updating an allocation, or allocating to a due of another client or currency
  (`client_payment_guard`, `client_payment_allocation_immutable`, `client_payment_allocation_matches`). A mistake is
  **reversed** with a reason; its invoices get the amount back as owed. A hand edit of an invoice may not drop its paid
  amount below what unreversed receipts settled, nor change its currency or remove its amount.
- **A group link is data.** It never joins a group, sends, starts a session or touches `isMonitored` / AI flags (a
  test counts `OutboundMessage` and `WorkerCommand` rows before and after). One ACTIVE owner per WhatsApp group id per
  project (partial unique index) — keyed on the WhatsApp id, so two of our numbers in one group cannot hand it to two
  clients. Only an ACTIVE synced group of the chosen account can be linked. A later sync that misses the group never
  removes a link; the UI shows "group inactive" instead. Unlinking keeps the row. "Open chat" goes to this project's
  own `/chat/account/<account>/<group>`, never `wa.me`. Personal chat links (`ClientWhatsAppChatLink`) are untouched and
  still refuse `@g.us`.
- **Photos are thumbnails, never files.** The browser shrinks to ≤256 px WebP; the server sniffs the type from the
  bytes, caps size (200 KB) and dimensions (16–1024 px), strips EXIF/XMP/text/comment blocks, and stores the result in
  `ClientPhoto` (CHECK-enforced bound). Served only by `/p/<slug>/api/clients/<id>/photo` after session → project →
  `clients.view` + `CLIENT_CENTER`, with `nosniff` and a sandbox CSP; another project's id is a 404.
- **Columns are presentation.** A billing column is not offered without `clients.view_billing`, the read model does
  not select billing figures for such a viewer, a saved preference is re-sanitized on every read, and a billing
  filter (`due=`) from a non-billing viewer is ignored rather than answered (the count would leak who owes money).
- **Sub-modules are refused on the server.** `ClientModuleSettings` (no row = everything on, nothing required).
  Payments need Billing. Each action calls `subModuleOff(...)`; the pages say the module is off.
- **Required fields never relax a technical rule**, and a code-only client needs `confirmBlank` (a separate button).
- **Sellers are roster ids with a snapshot.** A new sale needs an ACTIVE `InternalTeamMember` of this project; its
  name and current team are copied onto the term, so a later transfer never rewrites history. A NEW assignment to a
  disabled team, an inactive member, or a member outside the chosen team is refused; an existing one may stay.

## 4. Data contract (migration `20261017100000_clients_v3`)

New tables (all project-scoped, `projectId` defaults to `project_id_required()`, immutable-project trigger,
same-project triggers on every project-owned relation):
`ClientSubscription`, `ClientPhoto`, `ClientPayment`, `ClientPaymentAllocation`, `ClientWhatsAppGroupLink`,
`ClientModuleSettings`, `ListViewPreference`. New enums `ClientSubscriptionKind`, `ClientDurationUnit`,
`ClientDueKind`, `ClientPaymentMethod`. New sequences `client_invoice_seq`, `client_receipt_seq`.

New nullable columns: `Client.country, preferredCurrency, soldByMemberId, currentSubscriptionId, photoUpdatedAt`;
`ClientDue.invoiceNumber (unique per project), kind, issuedDate, service, subscriptionId, soldByMemberId`.
No backfill: older dues have no invoice number and show "Older due"; they still take payments.

Permission keys (granted to nobody; Administrator gets them through the seed): `clients.manage_subscriptions`,
`clients.link_whatsapp_group`, `clients.manage_settings`. Existing keys keep their meaning: billing figures need
`clients.view_billing`, invoices and payments `clients.edit_billing`.

Actions: `server/actions/clientSubscriptions.ts` (create, renew, pause/resume, cancel), `clientPayments.ts` (record,
reverse), `clientGroupLinks.ts` (search, link, unlink), `clientExtras.ts` (photo, settings, columns, client search),
`clients.ts` (create/update extended), `clientBilling.ts` (numbered invoices, allocation guard).

## 5. Tests (all on the throwaway database)

- `clientImportTemplate.integration.test.ts` (8) covers:
  - permissions;
  - the workbook (sheets, headers that self-map, project-only drop-downs, prompts, frozen panes, date format);
  - Example rows importing with zero errors, and "with my clients" scope and logging;
  - V3 columns and the Excel date serial, every roster refusal, re-import idempotence, and import without the
    subscription permission.

  Four guards were mutation-checked; each removal fails a test.
- `packages/shared` `clientImportExtras.test.ts` (7) covers the date, unit and kind parsers, whole-term
  validation, and the other software's headers.

- `packages/shared/src/__tests__/clientsV3.test.ts` — 27: calendar maths (month ends, leap years), validation, state,
  current-term choice, minor units, currency decimals, batch planning (split by client/currency, every refusal),
  reversal, outstanding per currency, column sanitising, settings, photo sniff/size/strip, group-link refusals.
- `apps/web/src/__tests__/clientsV3.integration.test.ts` — 29: subscriptions (roster seller + snapshot, refusals,
  renewal dates, pause/cancel once, SQL state filter = `termState`, switch off), invoices and payments (numbering,
  sale + invoice, partial/full, batch split, all-or-nothing, double press incl. concurrent, race on the same invoice,
  decimals, future date, reversal, DB guards, hand-edit guard, cross-project), group links (no sends/flags changed,
  one owner across our numbers, history, every refusal, CHECK), form (blank guard, E.164, required fields, roster
  rules, client + term + group in one transaction), photos (strip, bound, route permission, cross-project 404, fake
  image), register (columns per person/project, billing hidden and billing filter ignored, seller/country/returning
  filters, expiry sort, nothing of A in B).
- **Mutation check:** 14 deliberate breaks of the protected code; **13 caught**. The 14th (removing the early
  idempotency lookup) is still caught by the database's unique key, which is the intended second layer.
- Unchanged suites still green: all Clients, Billing, Chat links, Import/Export, Validation, Email, project
  sections/navigation (323 role sets), raw-SQL project filter (web + worker), Phase-7 trigger catalogue (worker).

## 6. Performance (throwaway Postgres, 3,000 clients, 6,000 invoices, 600 group links, warm, mean of 5)

| Query | ms |
|---|---|
| Register page 1 (50 rows, with billing) | 150 |
| Register sorted by expiry | 107 |
| Register `state=EXPIRING` / `due=overdue` / phone search | 79–82 |
| Register KPI tiles | 14 |
| Billing List page 1 / its KPIs | 41 / 18 |

One query per page for rows (relations selected, not fetched per row), one grouped query for billing figures, one for
"returning". Indexes added: `Client(projectId, country)`, `Client(currentSubscriptionId)`,
`ClientSubscription(clientId, endDate)`, `(projectId, endDate)`, `ClientDue(subscriptionId)`, payment and link indexes.

## 7. RBAC and isolation audit

Every new action checks its own key with `checkPermission` and the sub-module switch; reads go through the
project-scoped client; the four raw queries (client lock, due lock, sequences) name `"projectId"` or touch no table.
Pages: `/clients/subscriptions` (`clients.view`, manage `clients.manage_subscriptions`), `/clients/dues` and
`/clients/payments` (`clients.view_billing`, manage `clients.edit_billing`), `/settings/clients`
(`clients.manage_settings`, Full only). Section rules updated so project roles with page selections work. Database:
cross-project references refused by triggers; payment rows protected by guards. Read Only gets none of the new keys.

## 8. Compatibility

- **ClientDue:** existing dues untouched; they gain nothing until edited; payments can be recorded against them when
  they have an amount and currency. The Billing card on a client still edits a due; editing is now refused only where
  it would contradict recorded receipts.
- **Client import:** unchanged (it still requires a name and reads the same columns). Clients created by import simply
  have no subscription until one is added.
- **Personal chat links:** unchanged table, key and rules.
- **Old form posts** (without the V3 fields) keep the stored country/currency/seller.

## 9. Limitations and decisions for the owner

1. **Three-decimal currencies** (KWD, BHD, OMR, JOD) are held to two decimals because storage is `Decimal(12,2)`.
   Widening to `Decimal(15,3)` is a table rewrite of `ClientDue`; decide before those currencies carry real money.
2. **No DRAFT invoice state, tax, discount or quantity.** A due is issued when saved. Tell me if drafts are needed.
3. **One group, one client** (the default the brief suggested). Shared groups (a reseller group serving several
   clients) would need an explicit "shared" mode.
4. **Sub-module switches do not hide sidebar entries**; the page explains the module is off and every action refuses.
5. **Country flags are not shown** — Windows renders flag emoji as letters.
6. Reminders, campaigns, a sales/collection report and invoice documents are later stages (`CLIENT_CENTER_PLAN.md`).

## 10. Deploy and rollback (not executed)

Follow `DEPLOY.md`: back up → `docker compose run --rm migrate` (applies `20261017100000_clients_v3`) → rebuild
`app`. The worker is not affected by this change. Then, per project that should use it: Main Admin → project features
→ `CLIENT_CENTER` on; give roles the new keys; optionally Settings → Client Module; add currencies on the Billing List.

Rollback: code-only rollback is safe (old code ignores the new tables/columns). Schema rollback — only before real
subscriptions/payments exist — is spelled out at the top of the migration file. After that, roll forward.
