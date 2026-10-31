# Client Configuration Center (Settings → Client Lists)

Smart Import V5, 31 Oct 2026. Route: `/p/<slug>/settings/clients/configuration`, in the Settings rail under
**Clients**. Part of the `CLIENT_CENTER` feature (no feature flag of its own). Code: `server/clientConfiguration.ts`
(reads), `server/actions/clientConfiguration.ts` (writes), `settings/clients/configuration/ConfigurationCenter.tsx`,
pure rules in `packages/shared/src/clientConfiguration.ts`.

## What it is for

One place per project for the values people otherwise type again and again, slightly differently each time:
tags, categories, business types, services & plans, currencies, countries and languages. Add / Edit Client offers
them as searchable choices, and Smart Import matches a file's values to them.

## Rules worth not undoing

- **A list never takes a value away from a client.** Archiving hides an entry from pickers; clients keep the value.
  Renaming or merging an entry renames that value on every client that carries it, in the same transaction, and
  the result says how many clients changed. Tags keep their order and are never duplicated.
- **A list never blocks an import or a form.** A value not on the list is kept as typed. "Add used values" turns
  the values clients already carry into entries in one click, so nothing typed before the list existed is lost.
- **Matching is name or alias, case-insensitive** (`matchCatalogEntry`), and stores the entry's own spelling. Names
  are unique per project and kind regardless of case (a `lower(name)` unique index), so "VIP" and "vip" cannot
  both exist. Tags are lowercase, as they always were (`normalizeTag`).
- **Plans are suggestions, never billing.** A plan has an optional parent service, a default kind (paid / free /
  trial), a default duration and unit, prices per currency (exact decimal TEXT, never a float) and aliases. Choosing
  one on Add Client fills the subscription fields; it creates no invoice, due or payment. The person can still type
  an exact expiry instead of a duration.
- **Currencies: every ISO 4217 code, no cap.** The old 30-currency limit is gone; a new code must be a real ISO code
  (`isIsoCurrency`). Favourites come first in every picker. No conversion between currencies anywhere.
- **Countries** may carry a favourite flag and the currency / language to suggest for that country when the project
  differs from the general rule (CLDR / `country-to-currency`). A suggestion fills only an empty field.
- **Languages** are every ISO 639-1 language by name; a client has one preferred language plus any number of
  additional ones (`Client.additionalLanguages`).
- **Permission.** The page and every change need `clients.manage_settings` (the existing Client Module settings
  key) in the URL's project — including "+ Create …" from the client form (`quickCreateCatalogEntry`). Anyone who
  can open Add / Edit Client sees the lists as choices. Every change is a System Log entry. The page is "Full only"
  in `SECTION_RULES`.
- **Country names are made on the server.** ICU differs between Node and the browser ("Falkland Islands" /
  "Falkland Islands (Islas Malvinas)"), so naming countries in a client component broke hydration on Add Client.
  `ClientFormContext.countries` carries the server's names.

## Data

Migration `20261031090000_client_configuration` (additive):
- `ClientCatalogEntry` (kind TAG / CATEGORY / BUSINESS_TYPE, name, aliases, colour, archivedAt);
- `ClientServicePlan`;
- `ClientCountrySetting` (one row per project and country);
- `Client.businessType`, `Client.additionalLanguages`;
- `ClientBillingCurrency.favorite`.

All three tables are project-owned: `projectId` required, `enforce_project_immutable` triggers, registered in
`PROJECT_SCOPED_MODELS`. Migration `20261031100000_client_imported_amounts` adds `Client.importedAmounts` (see
SMART_IMPORT.md §12).

## Tests

`packages/shared/src/__tests__/clientConfiguration.test.ts` (names, aliases, plan validation, defaults) and
`apps/web/src/__tests__/clientConfiguration.integration.test.ts` (12, throwaway database): permission refused,
projects kept apart, rename propagates (order kept, no duplicate), merge, archive keeps values and refuses a
same-name-other-case entry, add used values, plan prices in each currency's decimals, more than 30 currencies and
ISO only, country settings, System Log, the form stores business type and other languages while a paid plan with
an exact expiry creates no invoice, a formula-like business type is refused.
