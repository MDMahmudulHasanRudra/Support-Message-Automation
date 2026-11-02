# Client CRM & Billing V7 — documents, renewals, client messages

Status: **built on `feature/client-crm-billing-v7` (from `main` 15055e2), not merged, not deployed.** Everything lives
inside the existing `CLIENT_CENTER` feature (off by default). Two additive migrations:
`20261101130000_email_purpose_client_message` and `20261101130100_client_crm_v7`. Extends `CLIENTS_V3.md`
(subscriptions, invoices, payments), `CLIENT_CODES.md` and `CLIENT_CENTER_PLAN.md` (decisions 1–23 still apply).

## 0. Audit — what was already there (verified on `main`, 1 Nov 2026)

| Area | Already correct | Gap found → what V7 did |
|---|---|---|
| Client codes, alias, conversion | `0001` / `N0001` series, aliases, privileged change | None. Untouched. |
| Edit client | Own page `/clients/[id]/edit`, sections, sticky Save / Save & view, dirty guard + `beforeunload` | Breadcrumb and an "On this page" section rail on wide screens. Form engine untouched. |
| Client 360° profile | Header, fact cards, tabs as URL state | Message client button; Open WhatsApp when no chat is linked; Renewal offers card (Subscriptions tab); Messages to the client (Activity tab, kept apart from internal notes). |
| All Clients list | Chips, filters, columns, selection, bulk status/assign/tags/export | Smart views: Unassigned, Recently added, No WhatsApp, Renewal pending, Follow-up due. Row actions: Open WhatsApp, Message client, View billing, Add note. Bulk email. |
| Subscriptions | Add, renew, pause, resume, cancel, history, current-term pointer | **Gap: Renew could create two terms from one term** (double press or two people). Fixed: a term is renewed once, under the client lock. Renewal workspace + offers. |
| Billing List | Register, KPIs, filters, Pay selected, Create bill, Delete | **Gap: the ⋯ menu had only "Open client" and "Delete".** Now: View invoice, Edit/print/download, Payment reminder, Open client, Delete. Invoice number links to its page. Bulk reminder email. |
| Invoice detail | None (invoices only inside the profile's Billing tab) | `/clients/dues/[id]`: figures, the document as it prints, payments applied (reversed kept, marked), history, internal note, messages. Edit and Record payment reuse the existing actions and guards. |
| Invoice / receipt documents, PDF | None | Versioned Invoice & Receipt setup; printable HTML; server PDF. |
| Payments & receipts | Register, reversal, delete for admins | `/clients/payments/[id]` money receipt (reversed receipts say so); receipt number links to it. |
| Email | SMTP settings, outbox, worker, TEST purpose only | `CLIENT_MESSAGE` purpose; worker re-checks channel on + verified + opt-out at send time. |
| Templates | Notification Templates (team alerts), Saved Replies (operator shorthand) | Client Communication Templates — a separate library (§6). |
| Multi-currency | BigInt minor units; never summed across currencies; 3-decimal currencies refused, never rounded | No change (see §9). Documents and offers use the same functions. |

Product patterns consulted (interaction patterns only, no visual identity copied): invoice/receipt as a read view with
Print / Download beside it, versioned branding that does not rewrite issued documents, renewal pipelines with
offer → follow-up → accepted → renewed states, template variables with live preview, and bulk sends with an explicit
review-and-approve step.

## 1. What changed for the person using it

| Page | Route | What it is |
|---|---|---|
| Invoice | `/clients/dues/[id]` | Total / Paid / Balance / Due cards, the document preview (Print, Download PDF, open in a tab), payments applied, subscription, internal note (never printed), history, messages. Edit invoice and Record payment for billing editors. |
| Money receipt | `/clients/payments/[id]` | Amount, invoices settled, the receipt document, Reverse (with a reason), messages. A reversed receipt is marked everywhere. |
| Renewals | `/clients/subscriptions/renewals` (tab of Subscriptions) | Renewing soon / Expired (terms) and Offer prepared / sent / awaiting / accepted / renewed / declined / Follow-up due (offers). Prepare offer, record contact, mark awaiting, accept, decline, follow-up, withdraw, Renew from an accepted offer. |
| Bulk email | `/clients/messages` | Batches waiting for approval / approved / closed; Approve and queue, Reject, Cancel; each recipient's state. |
| Message Templates | `/clients/templates`, `/clients/templates/[id]` | The library, the editor (click-to-insert variables, live sample preview), versions. |
| Invoice & Receipt | `/settings/clients/documents` | Business details, logo, signature, titles, payment instructions, terms, footer, colour, A4/Letter, live preview, version history. |
| Open WhatsApp | `/clients/[id]/whatsapp` | The best route to the client on WhatsApp (§2). |

## 2. WhatsApp quick access (no change to the WhatsApp engine)

1. **Linked personal chat** → straight into this project's WhatsApp Chat; the ordinary composer replies.
2. **Unlinked, existing chat with exactly the client's number** on one of this project's accounts → offered to an admin
   with `clients.link_whatsapp_chat` ("This is the client — link and open"), through the existing audited link action.
   More than one such chat → nothing is offered; the admin chooses on the WhatsApp tab.
3. **Usable number, no conversation** → WhatsApp's own click-to-chat (`https://wa.me/<digits>`), labelled as
   external. Opening it sends nothing; Get Assist never starts a conversation (decision 5).
4. **No usable number** → the reason and an Edit client link.

Get Assist does not send a first message to a personal chat: the existing transport answers chats only, and that rule
is unchanged.

## 3. Documents (invoices and money receipts)

- **A document is a view of existing records**, computed once in `server/clientDocuments.ts` with the Billing List's own
  functions (`remainingOn`, `invoiceState`, `formatMinor`). The HTML (`clientDocumentHtml.ts`) and the PDF
  (`clientDocumentPdf.ts`) only lay out those strings.
- **One line per invoice** (service, kind, service period) — invoices have no quantity, discount or tax columns
  (CLIENTS_V3.md §9). No tax amount is ever printed; the business's tax/VAT number may be printed as a fact about the
  business. Whether a document meets a country's tax-invoice rules is for the business to confirm.
- **Versioned branding.** `ClientDocumentSettingsVersion` is append-only (trigger); each save is a new version. A
  document uses the newest version saved at or before it was issued (invoice creation / payment recording); a document
  issued before any setup uses the first version ever saved (`effectiveSettingsVersion`). Images are
  `ClientDocumentAsset` rows addressed by SHA-256 (append-only), PNG/JPEG sniffed from the bytes, ≤ 256 KB (CHECK).
- **Served only by** `/p/<slug>/api/clients/documents/<invoice|receipt>/<id>?format=html|pdf`: session → project →
  `clients.view_billing` (+ CLIENT_CENTER) → Billing on → the row through the scoped client (another project's id is a
  404). HTML has a CSP with no script and no remote resource; everything user-typed is escaped. A PDF download is
  recorded in the System Log.
- **PDF uses the PDF standard fonts** (pdf-lib 1.17.1, no font files). They cover Latin script only, so a document
  containing Bengali, Arabic or another script is refused as PDF (422) and the page says to use Print → Save as PDF,
  which the browser draws exactly. Nothing is drawn wrongly.
- Notes typed on an invoice or a payment are staff notes and are **not printed**.

## 4. Renewal offers

- `ClientRenewalOffer` + append-only `ClientRenewalOfferEvent`. One OPEN offer per term (partial unique index).
- **An offer is never money owed**: prepared, sent, accepted or declined, no `ClientDue` is created. A price is
  optional (amount + currency together, CHECK) and needs `clients.view_billing` to propose.
- Transitions (`nextOfferStatus`): contact (any open offer; the first moves it to "sent"), awaiting, accept, decline
  (reason required), withdraw (reason required), follow-up date. Each is a conditional update on the status read.
- **Renew from offer** — only from ACCEPTED: the offer is claimed ACCEPTED → RENEWED and the new term is created in the
  SAME transaction (`createTermInTx`, the write Add/Renew already used). An invoice is raised only if the person ticks
  it (offer price, chosen due date, `clients.edit_billing`). The payment is recorded separately, with its own receipt.
- **A term is renewed once** (all paths): a second renewal of the same term is refused under the client lock.

## 5. Smart views

All Clients chips: Unassigned (`assigned=none`), Recently added (`smart=recent`, 30 days), No WhatsApp (`smart=nowa`:
no WhatsApp channel and no linked chat), Renewal pending (`smart=renewal`: an open offer), Follow-up due
(`smart=followup`). One filter builder (`lib/clientFilters.ts`) serves the list, select-all, export and bulk actions.

## 6. Client Communication Templates and one-to-one messages

- `ClientMessageTemplate` (+ append-only `ClientMessageTemplateVersion`): name (unique per project), category,
  channel (Any / Email / WhatsApp / Messenger / Instagram), language, subject, body, Draft / Active / Archived, version.
  **Plain text only.** Unknown variables and stray `{{`/`}}` are refused (browser and server); activation re-validates.
- **Variables** (`MESSAGE_VARIABLES`): client name/code/company, your business name, support phone/email, service,
  expiry date, days left, offer amount/duration/valid-until, invoice number/amount/amount due/due date, currency, receipt
  number, payment amount/date. Values come only from THIS client's records; a related record that is not this client's is
  ignored. **Money variables are filled only for viewers with `clients.view_billing`.** A body line made only of empty
  variables is dropped; missing variables are listed before sending.
- **Message client** (profile, Billing List row, invoice, receipt, renewals): choose a template, edit the words, then
  - **Email** — queued into the existing `EmailOutbox` (`CLIENT_MESSAGE`), one per press (submission key), only while the
    channel is ON and verified, never to an opted-out address. State shown is the outbox's: queued, accepted by the mail
    server, failed, unknown — never "delivered".
  - **WhatsApp** — "Copy and open chat" (linked conversation) or "Open in WhatsApp" (click-to-chat). Recorded as
    PREPARED (`ClientMessage`), never as sent. The database refuses a queued message on any channel but email.
  - **Copy text** — recorded as prepared.
- Messenger / Instagram: templates can be written for them, but nothing is sent through Meta from here: a channel
  conversation needs the provider's own identity and window rules (OMNICHANNEL.md), and campaigns there are excluded
  (decision 7).

## 7. Bulk email (prepared by one person, approved by another)

From All Clients (selected clients) or the Billing List (selected invoices → reminder per invoice):
1. **Prepare** (`clients.send_messages`): each recipient is rendered now and checked — no address, opted out, consent
   not recorded (UNKNOWN is never consent for a bulk send, decision 11), archived, or an address already in the batch →
   SKIPPED with the reason. At most 500. Nothing is queued.
2. **Approve** (`clients.approve_messages`) by a **different** person within **24 hours** (decisions 8, 9; CHECK
   `ClientMessageBatch_no_self_approval`). Consent and address are checked again; each eligible message gets one outbox row
   (`batch:<batch>:<message>` idempotency key). A late batch is closed EXPIRED. Reject (reason) / Cancel (preparer) send nothing.
3. The worker sends at the project's own per-minute/per-day pace and re-checks opt-out and consent per message.

No WhatsApp bulk sending exists or was added.

## 8. Timeline

New `ClientActivity` types: `RENEWAL_OFFER_PREPARED`, `RENEWAL_OFFER_UPDATED`, `MESSAGE_PREPARED`, `MESSAGE_QUEUED`
(plus the existing subscription and billing entries). The timeline still never carries an amount. Messages to the
client are listed separately from internal notes.

## 9. Money and currencies

Unchanged and re-verified: integer minor units, no floating point, no rounding, nothing added across currencies, no FX.
Storage stays `Decimal(12,2)`: a real third decimal (KWD/OMR/BHD/JOD) is refused, not rounded — widening the ledger is a
separate decision (CLIENTS_V3.md §9). Offer prices use the same validation as invoices.

## 10. Permissions

Two new keys (granted to nobody; the Administrator gets every key through the seed; Read Only gets neither):
`clients.send_messages` (prepare/send to clients, prepare a bulk email) and `clients.approve_messages` (approve or reject a
bulk email). Reused: `clients.view_billing` (documents, money), `clients.edit_billing` (edit/pay, invoice on renewal),
`clients.manage_subscriptions` (offers), `clients.manage_settings` (templates, Invoice & Receipt setup),
`clients.link_whatsapp_chat` (link a found chat). Section rules cover the new pages and the documents route.

## 11. Data contract (migration `20261101130100_client_crm_v7`)

Eight project-owned tables, each with `projectId` default `project_id_required()`, the immutable-project trigger and a
`*_same_project` trigger on every project-owned relation: `ClientRenewalOffer`, `ClientRenewalOfferEvent`,
`ClientMessageTemplate`, `ClientMessageTemplateVersion`, `ClientMessageBatch`, `ClientMessage`,
`ClientDocumentSettingsVersion`, `ClientDocumentAsset`. Enum `ClientRenewalOfferStatus`. CHECKs as listed in the
migration. Append-only (UPDATE refused, DELETE allowed so client/customer deletion still works): offer events, template
versions, setup versions, assets. Actor columns keep id + name with no foreign key. Added to `PROJECT_SCOPED_MODELS`.
`EmailPurpose.CLIENT_MESSAGE` is its own migration (an enum value cannot be used in the transaction that adds it).

No existing table, column or row is changed. Rollback statements are at the top of the migration (before real use).

## 12. Tests

- `packages/shared/src/__tests__/clientCrmV7.test.ts` (20): offer validation and transitions, template validation and
  rendering, click-to-chat, email eligibility (single vs bulk), batch approval rules, message states, document settings,
  version choice, image sniffing, standard-font coverage, file names.
- `apps/web/src/__tests__/clientCrmV7.integration.test.ts` (16, isolated DB): offers create no due; renew from offer once
  (concurrent); renew a term once (sequential and concurrent); keys and money visibility; cross-project; documents
  (escaping, CSP, PDF bytes, 403/404, Bengali → 422); branding version per document, stale save refused, append-only,
  image sniffing; receipt part-payment and reversal; templates (unknown variable, versions, stale edit); preview (own
  values only, other client's invoice ignored, money hidden); one email per press, opt-out, unverified channel; WhatsApp
  prepared only; bulk (consent, duplicates, other project, self-approval refused by action and CHECK, re-check at
  approval, double approval, 24 h expiry, cancel/reject).
- `apps/worker/src/__tests__/emailOutbox.integration.test.ts` (+2): client message only while on and verified; opt-out
  after queueing and bulk consent refused at send time.
- **Mutation-checked**: removing the renew-once guard, the consent re-check at approval, the per-document branding version,
  HTML escaping, or the worker's client-message check each fails a test.

## 13. Deploy (staging first; not executed)

`DEPLOY.md`: back up → `docker compose run --rm migrate` (applies the two migrations) → rebuild `app` **and `worker`**
(the worker knows the new email purpose; deploy both together). Then, per project: give roles the new keys, add templates,
fill Settings → Invoice & Receipt, and test email (Settings → Email) before any client email.

Rollback: code rollback is safe while no CLIENT_MESSAGE row exists (an old worker cannot read that enum value, so deploy
app and worker together). Schema rollback before real use: the statements at the top of the migration.

## 14. Not built / known limits

- Automatic reminders (scheduled reminder rules) — not built: decision 10 requires an admin's approval for every reminder
  send, so reminders are prepared by people (Follow-up due, Overdue, Bulk email) rather than sent by a job.
- WhatsApp first-contact or bulk sending, Messenger/Instagram sending from templates — not built (decisions 5, 7).
- Invoice line items, discounts, tax calculation, credit notes / replacement invoices — not built (no ledger change).
- PDF for non-Latin scripts — use Print → Save as PDF. Amount in words — not printed.
- A stamp image (only logo + signature). Saved filter views on the client list — the existing column preferences only.
- Live provider verification: SMTP is exercised only against a fake server in tests.
