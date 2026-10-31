# Project client codes

V6, 31 Oct 2026. Replaces the installation-wide `CL-000041` codes with per-project codes: `0001` in a customer's
primary project, `N0001`, `NE0001`, `VIP0001` in its other projects. Code: `packages/shared/src/clientCodes.ts`
(rules, pure), `packages/db/src/index.ts` (series and allocation, raw SQL), `apps/web/src/server/clientCodes.ts`
(typed codes, aliases, conversion), Main Admin → Project → **Client codes** (`/admin/projects/<id>/client-codes`).
Migration `20261101090000_client_code_series` (additive).

## The rules

- **A code is what people read; `Client.id` is who the client is.** Changing a code never touches the client's id,
  subscriptions, invoices, receipts, payments, allocations, chat links, notes or history. Issued invoices and receipts
  are never rewritten. APIs and global actions identify a client by project + id, never by code alone.
- **One series per project** (`ProjectClientCodeSeries`, one live row). A customer's FIRST project is its **primary**:
  numbers only, stored explicitly (`isPrimary`), never inferred from how many projects are active. The original
  installation is one customer whether its projects carry no customer or the founding customer's id.
- **Every other project has a letter prefix** no other project of the same customer holds: suggested from the slug's
  letters (`N`, then `NE`, `NEX` …), then the slug's initials, then the first letter plus another letter. A slug or
  name with no Latin letters gets no guess: the admin types one. Prefixes are reserved for good — a retired series
  keeps its prefix — and enforced by a unique index on (tenant, prefix). Two customers may both show `0001`.
- **Codes grow, never wrap or clip**: `9999`, `10000`. Serials are `NUMERIC(38,0)` in the database and `bigint` /
  decimal text in code — never a JavaScript number. A code longer than 40 characters fails with an actionable error.
- **Allocation is one atomic `UPDATE … RETURNING`** on the live series inside the creating transaction; the row lock
  serialises concurrent creates. A code already used in the project — as a code or an alias, any case — is skipped.
  A number is never reused: a failed create, an archived or deleted client leaves a gap. Never `MAX()+1`.
- **A prefix change is a new version** of the series (`version + 1`, its own namespace, from 1 unless a first number is
  given). Codes already issued stay. The number width can only grow; the next number can only move forward. The primary
  project's codes stay numbers only. Renaming a project changes nothing.
- **Choosing or changing a client's code is privileged** — the existing key `clients.manage_settings`:
  - on Add client, a typed code;
  - on Edit client, **Change code**, its own logged step. The general edit refuses a different code.
  The old code becomes an alias (`MANUAL_CHANGE`). A typed code must be free in the project and must not have another
  project's form (`NE0042` belongs to the project holding `NE`; digits only belong to the primary project).
- **Aliases** (`ClientCodeAlias`): former codes and the codes a file gave a client. They are:
  - unique per project, whatever the case;
  - append-only (a trigger refuses UPDATE), and removed only with their client;
  - searched by the client list, matched by imports and shown on the profile and Edit page ("formerly CL-000041").

## Import (Smart Import and the classic import)

A mapped "Client code" column:
- **finds an existing client** by its current code or any alias;
- on a NEW client, by default, the client gets the project's next code and the file's code is kept as an
  `IMPORT_SOURCE` alias — searchable, and what a re-import of the same file matches;
- **"Use the file's client codes as the new clients' codes"** (Match columns, for `clients.manage_settings` only,
  checked again at confirmation) makes the file's code the client's code, exactly as written. A code already used,
  or with another project's form, fails that row with the reason.

Codes are text everywhere: `000007` is never `7`. The import template marks the column as text. XLSX exports write
text cells. A CSV is text too, but a spreadsheet program opening it may still read `0001` as `1` — import a CSV as text
(Data → From Text/CSV → column type Text) when the leading zeros matter.

## Converting existing codes (Main Admin, previewed)

Saving a series never renames a client. Existing `CL-` codes stay until a Main Admin converts them for one project.
1. **Preview** (always available, writes nothing). Clients are numbered in creation order (id breaks ties) from the
   series' next number, skipping any code in use. Archived clients are converted too and keep their number.
   - Options: codes in the old generated form (on by default) and custom codes (off — usually real references).
   - The pattern `CL-000041` cannot prove a code was generated; the preview lists every one for review.
   - **Export full preview (CSV)** has every row, before → after: keep it with the backup.
2. **Apply** needs `CLIENT_CODE_CONVERSION_ENABLED=true` on the app (off by default), the project's name typed, and
   the preview's fingerprint. In ONE transaction holding the series row, it:
   - recomputes the plan and refuses if anything changed since the preview ("Preview again");
   - writes an alias, the new code and a timeline entry per client;
   - moves the series past every number used.
   It is logged as a WARN System Log entry whose correlation id is the batch id.
3. **Recovery**: `scripts/revert-client-code-conversion.sql` (psql, `-v batch=… -v apply=0` previews, `apply=1`
   reverts). A client goes back only if it still has the code the batch gave it; the series is not lowered.

## Admin guide (short)

- **New project**: Main Admin → Create project → *Client codes*.
  - The first project of a customer is numbers only.
  - Any other project shows a suggested prefix, the prefixes already reserved, and the next three codes. Change the
    prefix, the minimum digits or the first number before creating.
- **Existing project**: Main Admin → the project → *Client codes* → *Manage client codes*. Change the prefix (a new
  series), raise the digits, or move the next number forward. The history lists every series.
- **Remove the CL- codes**:
  1. On the same page, *Preview (changes nothing)* → check the list → *Export full preview (CSV)*.
  2. Take a database backup.
  3. Set `CLIENT_CODE_CONVERSION_ENABLED=true` and restart the app.
  4. *Apply this conversion*, typing the project's name.
  5. Turn the variable off again afterwards.

## Edit client

`/clients/<id>/edit` is the only place the client form edits; the 360° profile is a read view. Every **Edit client**
(profile header, cards, the All Clients row menu) goes there; an old `?edit=1#edit-client` link redirects to it. The
page has:
- section links;
- an unsaved-changes warning (closing the tab, or Cancel);
- **Save changes** and **Save & view client**;
- the code with Copy and, for the privileged, **Change code**.

Quick actions (assign, notes, links, renew, payment) stay on the profile.

## Known limits

- Primary-project transfer is not offered: the primary stays the customer's first project. Moving it would change
  what a numbers-only code means.
- Tenant migration (moving a project to another customer) is not supported by this feature. A project's series stays
  under the customer it was created for.
- Search matches aliases by substring on the upper-cased code. The list does not show which alias matched.
- The conversion runs as one transaction per project: large projects (tens of thousands of clients) hold the series
  row for its duration, so creates in that project wait until it ends.
