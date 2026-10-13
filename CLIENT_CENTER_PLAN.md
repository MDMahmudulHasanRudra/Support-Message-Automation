# Client Center — Phase 4 plan (manual billing, Email, SMS interface, WhatsApp recipients, mandatory approval)

Status: **plan only — nothing implemented, committed, deployed or enabled.** Revised 13 Oct 2026 (twice) with Rudra's confirmed
decisions and the second review's proposals. Extends `CLIENT_CENTER.md` (Phases 2–3, built). Anything not yet decided is in §14 as an open question; this
document does not decide it silently.

## 0. Confirmed decisions (recorded exactly)

Billing and modules
1. **Billing is manual.** Authorised staff type each client's due date (and optionally an amount and a payment status). No
   ISP Digital integration or sync, no payment gateway, no automatic payment confirmation.
2. **Email:** an SMTP-based module, to be built. Credentials are configured **later**, through the existing
   secret-encryption mechanism and secure configuration practice.
3. **SMS:** a **provider-independent interface only**. No specific gateway, no real SMS sending, until a provider is
   selected and credentials are configured.

WhatsApp
4. **Group campaigns and individual campaigns are different things** and stay distinct everywhere (data, preview, approval,
   worker). A group recipient gets the group message; an individual client gets only their own one-to-one conversation;
   one is never converted into the other.
5. **Individual campaigns send only into an existing, safely identifiable conversation.** A campaign never starts a new one.
6. **An authorised admin must manually link an existing WhatsApp chat to the correct client.** Ambiguous identities are
   never linked automatically.
7. **Messenger and Instagram are excluded from campaigns for now.** Their existing functionality is untouched.

Approval and consent
8. **Every campaign or notice needs approval by a different authorised admin than the submitter. Self-approval is not
   permitted.**
9. **Approval expires after 24 hours.** An expired campaign needs fresh approval before anything is sent.
10. **Every due-reminder send needs admin approval.** There is **no** one-time approval of a recurring reminder policy that
    then sends future reminders by itself.
11. **Consent:** campaign sends are **blocked when consent is unknown or explicitly opted out.** Missing consent evidence is
    never treated as consent.
12. **Currency and amount:** multiple currencies are supported. The due amount may be blank; when it is, the amount is
    **omitted** from the message — never shown as a fabricated figure or zero.

Resolved at review (13 Oct 2026) — these four answered former open questions and are now decisions
13. **Consent evidence is mandatory.** Recording OPTED_IN requires a **source** (how consent was obtained) **and a note**; the
    system records who, when and for which channel automatically. Without them OPTED_IN cannot be saved. UNKNOWN and
    OPTED_OUT block sending. Consent history is kept, not overwritten (§4.4).
14. **Groups need their own explicit authorization.** A client's consent never authorizes a group send (the whole group sees
    the message). An admin must mark each WhatsApp group as **authorized for campaigns** (off by default); the approver sees
    each group's name and member count (§3.3).
15. **Chat-link suggestions are allowed; linking never is automatic.** An exact number match may be shown as a *possible*
    match; a link exists only after an admin confirms that specific chat for that specific client (§3.4).
16. **Single-admin projects:** self-approval never exists. With no second authorized approver the campaign simply stays
    PENDING_APPROVAL until the 24-hour approval window lapses; sending requires a second approver account (§4.3).

Adopted from the second review (13 Oct 2026) — recorded here; the details marked **open** stay in §14 until you confirm them
17. **Only authorized admins may manually link a WhatsApp chat to a client, and only authorized admins may authorize a group
    for campaigns.** No other role, and no automatic path, can do either (§3.3, §3.4, §8). Which permission key(s) express
    "authorized admin" is **open** (§14 Q3, Q14).
18. **Telegram is excluded from V1 campaigns** (with Messenger and Instagram). Its existing inbox, replies and AI are unchanged.
19. **V1 sends immediately; there is no scheduling.** Approval queues the campaign at once; nothing waits for a later start time
    (§4).
20. **Currencies come from a configurable supported-currency list** kept per project. A currency is required **only when an
    amount is present** (§2). The initial list contents are **open**: none is assumed.
21. **A blank amount removes the entire amount-only message line**; nothing is shown in its place (§5). How a template that puts
    the amount inside a sentence behaves is **open** (§14 Q8).
22. **Who can see campaigns is decided on the server by permissions**, never by the page (§7, §8). The exact visibility rule per
    permission is **open** (§14 Q13).
23. **The approver can refresh a group's member count before approving.** If a group's identity or campaign authorization
    cannot be verified, or its member count is still unknown, **approval is blocked and the reason is shown.** A member count
    is **not** evidence of consent and never substitutes for the group authorization (§3.3, §4.3).

Standing constraints (unchanged): no change to existing roles or permission levels; only the minimum new permission keys;
project isolation and feature flags preserved; `CLIENT_CENTER` stays off by default; nothing is enabled, deployed,
committed or pushed without approval; **no message is sent in development, tests, previews or implementation.**

## 1. What the repository actually has (verified 13 Oct 2026)

| Capability | Found? | Detail |
|---|---|---|
| Email module | **No** | No dependency, code, setting, env variable or permission. `NotificationType` is `TEAMS \| WHATSAPP`. To be built (decision 2). |
| SMS module | **No** | Nothing. Only an interface is planned (decision 3). |
| WhatsApp outbound queue | Yes | `OutboundMessage`: one send path, `idempotencyKey @unique`, global and per-client rate limits, kill switch, live membership check. |
| Group sends | Yes | `GROUP_BROADCAST` + `GroupBroadcastJob`: human-confirmed, own pacing in `GroupBroadcastSettings` (delay, per-minute, per-job, retries, duplicate cooldown), live `verifyGroupMembership`, stop and kill-switch states. |
| Individual (1:1) sends | Only as a reply | `MANUAL_REPLY` into a chat the account already has a stored message in (`sendPersonalChatMessage`); the worker re-checks live with `verifyPersonalChat` (`@c.us`/`@lid`, the chat must exist). The product rule is "answer, never start". |
| Messenger / Instagram / Telegram | Yes (Omnichannel) | `ChannelMessage` queue with Meta's window rules. Not a campaign channel in this phase. |
| Consent data | Yes (Phase 3) | `ClientChannel.consentStatus` UNKNOWN / OPTED_IN / OPTED_OUT, with source, note and timestamp. **Every channel starts UNKNOWN**, so under decision 11 nothing is sendable until staff record consent. |
| Notification-template precedent | Yes | `renderNotification` drops a line whose only content was an empty variable; reused in §5 for blank amounts. |
| Approval precedent | Partly | `LeaveRequest` (`decidedByUserId`, `decidedAt`). Nothing for outbound messaging. No self-approval policy exists, so none is added. |

## 2. Manual billing and due dates

**Model** (project-scoped; same-project triggers; `projectId` default `project_id_required()`):

- `ClientDue`: `clientId`, `dueDate` (a Dhaka calendar day, `@db.Date`), `amount` (`Decimal(12,2)`, **nullable**),
  `currency` (ISO 4217 code taken from the project's **supported-currency list**; **nullable; required only when an amount is
  present; no default is assumed**), `status`
  (`UNPAID | PARTIALLY_PAID | PAID | WAIVED | CANCELLED`, **typed by staff**), `paidAmount` (nullable), `note`,
  `createdBy/At`, `updatedBy/At`, `statusChangedBy/At`. Dues are kept as history; a paid due is not overwritten.
- `ClientDueEvent`: append-only audit (`type`, `from`/`to` JSON of the changed fields, `actorUserId`, `at`), **separate from
  `ClientActivity`**, because the timeline is readable with `clients.view` while amounts and dates must need the billing key.
- "Next due date" and overdue flags in the client list are **derived** from unpaid dues and shown only to billing viewers.
- No automatic confirmation of payment anywhere: "paid" is a person's statement, recorded with who and when.
- **Supported-currency list (decision 20):** a per-project, admin-configurable list of enabled ISO 4217 codes
  (built as `ClientBillingCurrency`: `code`, `enabled`, `addedBy`). **It ships empty; the plan assumes no currency.** The due form offers only
  enabled codes, and entering an amount needs one; with an empty list a due can still be saved without an amount. A currency
  removed from the list stays on the dues that already use it (shown as entered) and is simply not offered for new ones.
  Who may edit the list and the initial contents are **open** (§14 Q11). Stage 4A built it so that **`clients.edit_billing`
  edits the list** (an assumption pending Q11) and the list ships empty.
- Nothing is invented: no currency default, no placeholder amount.

## 3. Channels

### 3.1 Email (SMTP) — module to build
- **Design:** SMTP through a mail library (`nodemailer` is the intended choice; re-verify its version and advisories with
  `pnpm audit` when it is added, as was done for `xlsx`). SMTP keeps the module provider-neutral.
- **Settings:** one `EmailSettings` row per project: host, port, TLS mode, username, **password encrypted with the existing
  `encryptSecret`** (never sent back to the browser), from name/address, reply-to, enabled, send limits.
- **Credentials are future operational steps, not part of this work:** (1) obtain the SMTP host/port/user/password from the
  mail provider; (2) the sender domain's SPF/DKIM/DMARC records are set at the DNS host, outside the repository, and decide
  whether mail lands in spam; (3) an authorised admin enters the settings on the Email settings page (encrypted on save);
  (4) a test send to the admin's own address; the channel is shown **connected only after that test succeeds**; (5) limits
  are set to the provider's actual allowance. Until then Email is "not connected" and unavailable to campaigns.
- **Queue:** `EmailOutbox` (QUEUED → SENDING → ACCEPTED / FAILED / UNKNOWN) drained by one overlap-guarded worker loop, modelled
  on `channel-outbound`: idempotency key, bounded retries with backoff for temporary errors only, **no retry after a timeout
  whose outcome is unknowable** (UNKNOWN; "send again" needs a person's confirmation), permanent failures never retried.
- **Honest status:** SMTP only says the server *accepted* the message, so the state is **ACCEPTED**, never "delivered".
  Delivery or bounce tracking would need provider webhooks and is not part of this plan.
- One recipient per message (no shared To/CC/BCC), so no client sees another's address.
- Skipped when the project is suspended/archived or the feature is off, like every other worker loop.

### 3.2 SMS — provider-independent interface only
- An `SmsProvider` interface (capabilities, address validation, `send`, status mapping) with **no implementation**, plus a
  channel entry that reads "SMS — not connected (no provider selected)". No credentials table, no gateway client, no
  worker loop, no SMS permission beyond what campaigns already use.
- Recipient resolution, consent gating, approval and the campaign state machine treat SMS exactly like email, so that adding a
  gateway later is one implementation of the interface plus its settings — **real sending is dependent on a future gateway
  selection** and credentials (§14).
- A fake provider exists **only inside tests**; it is never registered in the application.

### 3.3 WhatsApp — group campaigns versus individual campaigns
A campaign has exactly one **audience type**, chosen first and fixed for the campaign: `WHATSAPP_GROUPS`,
`WHATSAPP_INDIVIDUALS`, `EMAIL` (and later `SMS`). **A campaign never mixes group and individual recipients**, so the
preview, the approval, the counts, the worker checks and the audit all describe one kind of send.

| | Group campaign | Individual campaign |
|---|---|---|
| Recipient | a `WhatsAppGroup` selected by staff | a **client** with an admin-created chat link |
| Resolves to | that group's `whatsappGroupId` on one chosen account that has the group | the **linked** one-to-one `chatId` on the linked account |
| Send-time gates | account CONNECTED and in the project; live `verifyGroupMembership`; existing broadcast pacing and duplicate cooldown; kill switch | account CONNECTED and in the project; the link still exists; the chat still exists on the account (live `verifyPersonalChat`); the account already has a stored conversation in it (never starts one); consent OPTED_IN; client not blocked/archived; kill switch; per-client limit |
| Never | converted to an individual send | converted to a group send, or sent to an unlinked number |

**Group authorization (decision 14).** A group may be a campaign recipient only if it is **authorized for campaigns**:
- `CampaignGroupAuthorization` (project-scoped): `whatsappGroupId`, `authorizedBy/At`, `revokedBy/At`. Default: **no group is
  authorized.** Authorization is per group, by an authorized admin, audited, and revocable; revoking stops any unsent
  campaign rows for that group (they are SKIPPED, which only reduces the audience).
- Client consent is **not** used for group sends: a group is not a person with an opt-in, and consent from one client says
  nothing about the other members who will read the message. A group linked to a client as a *channel* gets no shortcut: it
  is still sendable only if it is authorized for campaigns.
- The preview and the approver's screen show, for every group, its **name, account and member count** (`participantCount`;
  shown as "unknown" when it has not been fetched, never guessed) so the approver sees how many people will read it.
- Everything else for groups is unchanged: approval by a different admin, 24-hour expiry, frozen list, kill switch, live
  `verifyGroupMembership`, existing pacing and duplicate cooldown.
- **Only authorized admins may authorize a group** (decision 17); authorizing and revoking are audited. The permission that
  defines "authorized admin" is open (§14 Q14).
- **Approver's member-count refresh (decision 23).** On the approval screen each group has a **Refresh member count** action
  that uses the existing on-demand participant-count worker command (no new browser call). Approval of a campaign that
  includes a group is **blocked, with the reason shown**, while any of these holds: the group is not found in this project;
  its campaign authorization is missing or revoked; the account that would send is not connected or not in the group; or the
  member count is still unknown. The count is shown only to inform the approver of the audience size — **it is not evidence of
  consent and does not stand in for the group authorization or for any consent**. How fresh a count must be is open (§14 Q15).

The worker refuses any row whose `chatId` suffix disagrees with its audience type (`@g.us` only for group campaigns;
`@c.us`/`@lid` only for individual ones). The audience type is part of the approval hash and the idempotency key.

### 3.4 Linking a WhatsApp chat to a client (decision 6)
- **Manual, by an authorized admin only (decision 17), one chat at a time**, from the chat's contact panel in WhatsApp Chat or from the client's
  page: the admin picks the **account** and an **existing** personal chat and confirms the client it belongs to.
- **No automatic linking, including by exact number match.** A number that equals a client's WhatsApp number does not link
  itself. It **may be shown as a "possible match"** (decision 15): the linking dialog lists chats on the chosen account whose
  number equals one of the client's WhatsApp numbers, marked as a suggestion only. Each link is a separate admin
  confirmation naming the client and the chat; there is no "link all" action and no link from a bulk import. `@lid` chats
  carry no number, so they are never suggested; an admin can still link one deliberately.
- `ClientWhatsAppChatLink` (project-scoped): `clientId`, `accountId`, `chatId` (`@c.us`/`@lid` only), `linkedBy/At`,
  `unlinkedBy/At`. **One active link per `(accountId, chatId)`**: a chat already linked to another client cannot be linked
  again until that link is removed, so an ambiguous identity cannot be created. Every link and unlink is audited.
- A client with no active link is **rejected** from an individual campaign with the reason "no linked WhatsApp chat". A
  linked chat that no longer exists on the account, or where the account has no stored conversation, is rejected with
  its own reason.

### 3.5 Messenger, Instagram and Telegram
Excluded from V1 campaigns (decisions 7 and 18): the audience selector does not offer them, and the worker has no campaign path to them.
Their conversations, inboxes, replies, AI and queues are unchanged.

## 4. Mandatory approval

### 4.1 Objects
- `MessageTemplate` (name, audience type, subject for email, body, variables; project-scoped).
- `Campaign`: `kind` (`CAMPAIGN | NOTICE | DUE_REMINDER`), category (informational / important / urgent / emergency),
  `audienceType`, subject, body, `status`, `version`, `contentHash`, creator, `submittedAt/By`, `approvedAt/By`,
  `approvedHash`, **`approvalExpiresAt` (= `approvedAt` + 24 h)**, `rejectedAt/By/reason`, `queuedAt`, `cancelledAt/By`,
  `completedAt`.
- `CampaignRecipient`: the **frozen snapshot** taken at submit (target type, client or group reference, resolved address,
  a hash of that resolution, the consent value seen), plus status (`PENDING | QUEUED | SENT | ACCEPTED | FAILED | SKIPPED |
  CANCELLED | EXPIRED`), reason, attempt count and the outbound/outbox row it produced.
- `CampaignEvent`: append-only audit (CREATED, EDITED, SUBMITTED, APPROVED, REJECTED, APPROVAL_INVALIDATED,
  APPROVAL_EXPIRED, QUEUED, RECIPIENT_SKIPPED, CANCELLED, COMPLETED) with actor, time and hashes, in the project.
  **No message text, subject or address is written to an event or to `SystemLog`**; ids and counts only.

### 4.2 Workflow
1. Draft: choose the audience type and channel, write the message (template or free text).
2. Select the recipients: groups, individual clients, or a permitted client filter. A filter is resolved **once, at submit,
   into an explicit list**; the campaign never re-resolves a filter later.
3. Preview the **exact message** (rendered per sample recipient, with every variable filled), the **full recipient list**
   with rejected recipients and reasons, the channel and the counts. Estimated send duration at the current pacing is shown.
4. Submit for approval (`campaigns.create`).
5. A **different** authorised admin approves or rejects (optional rejection reason).
6. On approval the campaign is queued **immediately** through the existing channel infrastructure (§6); there is no scheduled
   or delayed start in V1 (decision 19) — only then does any row exist in a
   send queue.
7. Status, timestamps, approver, rejection reason and per-recipient results are shown on the campaign page.

### 4.3 State machine
```
DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ APPROVED ──queue──▶ SENDING ─┬─▶ COMPLETED
  ▲                  │   └─reject─▶ REJECTED ──edit──▶ DRAFT                  ├─▶ PARTIALLY_FAILED
  │                  └─withdraw─▶ DRAFT                                       └─▶ FAILED
  └── any material edit of a PENDING_APPROVAL or APPROVED campaign ──▶ DRAFT (approval cleared)
APPROVED / SENDING ──24 h after approval, rows still unsent──▶ unsent rows EXPIRED, campaign EXPIRED (needs fresh approval)
CANCELLED from DRAFT / PENDING_APPROVAL / APPROVED / SENDING (remaining rows stop; sent messages cannot be recalled)
```
- **Material change** = the canonical hash of {audience type, channel, subject, body, category, the sorted recipient
  snapshot (target type + id + resolved-address hash)} changes. (There is no schedule field in V1.) Editing the title or an internal note is not
  material. Any edit to a `PENDING_APPROVAL`/`APPROVED` campaign returns it to DRAFT, clears approver/time/hash and writes
  APPROVAL_INVALIDATED. Re-approval is always by a different admin than the (re-)submitter.
- **Approval expiry (decision 9):** the 24-hour window is fixed, not a setting. It is enforced **server-side at three
  points**: when approving (the submission must not be older than the approver's view), when queueing (`now <=
  approvalExpiresAt`), and again by the worker immediately before each row is claimed for sending. A row not sent by
  expiry is marked EXPIRED, never sent; fresh approval requires re-submit (a new snapshot is taken, because
  clients, consent and links may have changed meanwhile). The estimated duration shown at submit must fit inside the
  window; a campaign whose pacing cannot finish within 24 hours is refused at submit with that explanation.
- **Approval checks (server-side, never only in the UI):** one conditional `UPDATE … WHERE id AND status =
  'PENDING_APPROVAL' AND contentHash = :shown AND version = :v` (count must be 1). It requires `campaigns.approve`, the
  feature on, a writable project, `approver ≠ submitter` (compared by user id, no override), and a hash recomputed from
  the stored snapshot that equals the one the approver was shown, **and, for a group campaign, every group verified as in
  decision 23** (found, authorized, account connected and in the group, member count known). A double click, a stale tab or two admins at once
  approve once. Reject, cancel and withdraw are likewise server-checked conditional updates.
- **Idempotency:** the queueing step runs in one transaction and creates one outbound/outbox row per recipient with the key
  `campaign:<campaignId>:<recipientId>`; calling it twice creates nothing new. A campaign cannot be queued from any state
  but APPROVED.
- **Send-time re-checks only ever reduce the audience** (client became blocked or archived, consent became opted-out or
  unknown, link removed, chat gone, group left): the recipient is SKIPPED with a reason and the approval is **not**
  invalidated, because no new person can receive a message the approver did not see.
- Unauthorised users cannot approve, edit after submission, queue, send or cancel somebody else's campaign.

### 4.3a Single-admin projects (decision 16)
There is no self-approval and no setting that allows it. If the only user holding `campaigns.approve` is the submitter,
the campaign shows **"waiting for a second authorized approver"** and stays `PENDING_APPROVAL`; the approve action refuses
the submitter's own request server-side. It is never sent. If nobody else approves within the approval window it lapses
(the submission expires and must be submitted again). Sending from such a project requires you to give a second person the
`campaigns.approve` permission; the plan changes no role to make that happen.

### 4.4 Consent (decision 11)
- A recipient is sendable only if its channel's `consentStatus` is **OPTED_IN** at submit **and again at send time**.
  **UNKNOWN blocks. OPTED_OUT blocks.** The preview lists blocked recipients with the reason; nothing treats "no evidence"
  as consent.
- Consent starts as UNKNOWN for every channel (imports included), so before any client campaign can go out staff must record
  it per channel on the client page.
- **Evidence is mandatory (decision 13).** Saving OPTED_IN requires a **source** — how it was obtained (the proposed
  vocabulary: WRITTEN, VERBAL, SIGNED_FORM, CLIENT_MESSAGE, OTHER; the final list is open, §14 Q5a) — **and a note**, checked
  server-side in `setClientChannelConsent`, not only in the form. **Who, when and which channel** are recorded by the system.
  Changing to OPTED_OUT or UNKNOWN needs no source but is recorded the same way.
- **Consent history is append-only** (`ClientConsentEvent`: channel, from, to, source, note, actor, time). The current
  value on `ClientChannel` is a convenience; the events are the proof, and a later change never erases the earlier record.
- **Existing OPTED_IN rows created in Phase 3 have no structured evidence.** They are **not** rewritten or downgraded by a
  migration; they are treated as **unproven and blocked for campaigns** until someone re-records them with source and note.
  (Phase 3 has no real clients, since the feature has never been enabled.)
- Consent applies to **client** recipients (individual WhatsApp, email, SMS). It is not used for groups (§3.3).

### 4.5 Notices
The same state machine, approval, expiry, consent and audit. Category and priority order the queue only; **EMERGENCY
changes nothing about approval, consent, limits or the different-admin rule.**

### 4.6 Due reminders (decision 10)
- **Every reminder send is approved by a different admin. There is no "approve this policy once" and nothing that sends
  future reminders on its own.**
- A reminder configuration may only **propose**: when a due date approaches, a worker pass may create a `DUE_REMINDER`
  campaign in `DRAFT`/`PENDING_APPROVAL` containing the clients it found, for an admin to review. It never queues or sends.
  A proposal that nobody approves within its window sends nothing and is not retried by itself.
- Each proposal has the same frozen snapshot, preview, 24-hour approval expiry and hash rules; a due that is edited, paid,
  waived or cancelled before approval invalidates the proposal for that client (the row is SKIPPED at send time).
- Because status is manual (decision 1), "still unpaid" is whatever staff last recorded. The system does not claim more.
- Not decided and therefore **not built in Phase 4**: when proposals are generated, how reminders are numbered per due, who is
  alerted that one is waiting, and the stop rules (§14 Q7). The proposal table and worker pass come only after those answers.

## 5. Message variables and blank amounts (decision 12)
- Variables read only recorded data: `{{client_name}}`, `{{client_code}}`, `{{company_name}}`, `{{due_date}}`,
  `{{due_amount}}` (with its currency), `{{currency}}`, `{{support_contact}}`. No `{{payment_link}}` (no gateway) and no
  invoice number (no invoice data) unless you later decide a manual field for them.
- **Blank amount (decision 21):** the **entire amount-only line is removed** from that recipient's message — the product's
  existing notification-template rule (a line whose only content was an empty variable is dropped). A template therefore puts
  `{{due_amount}}` on a line of its own (its currency is part of the same variable). The preview shows the exact result per
  recipient. What happens to a template that puts the amount **inside a sentence** (refuse it at save, warn, or render the
  sentence without it) is **open**: §14 Q8.
- A **missing due date** on a due-based template is not omitted: that recipient is flagged and excluded, never sent a blank.
- Never "0", "N/A" or a placeholder in a customer message. Amounts are formatted with their own currency; **no default
  currency exists** and none is inferred.

## 6. Integration with existing queues and safety

| Path | Reused | New |
|---|---|---|
| WhatsApp groups | the single `OutboundMessage` queue, idempotency, global rate limits, kill switch, live `verifyGroupMembership`, `GroupBroadcastSettings` pacing, duplicate cooldown | one new `ActionType` `CLIENT_CAMPAIGN` (own enum migration), nullable `OutboundMessage.campaignRecipientId`; the worker's broadcast branch generalised so a campaign row gets the same checks and the campaign settles when its rows do |
| WhatsApp individuals | the same queue, per-client limit (`toPhone` = chat id), live `verifyPersonalChat`, the "existing stored conversation" rule | the link table, the audience-type/suffix check, the consent and approval-expiry checks before claim |
| Email | patterns of `channel-outbound`; `encryptSecret` | `EmailSettings`, `EmailOutbox`, one loop |
| SMS | — | the interface only |

Campaign rows **obey the kill switch** (unlike `MANUAL_REPLY`): they are bulk, not one operator answering one person. **No new
WhatsApp limits are invented**; priority never lifts a limit. The WhatsApp ban-risk reasoning of the existing standards applies
unchanged, and sending only into existing conversations (decision 5) is what keeps individual campaigns inside it.

## 7. Security, isolation and audit
- **Campaign visibility is decided on the server** (decision 22): list, detail, recipient tables and results are filtered by the
  caller's permissions in the query itself; a page or URL guess reveals nothing the permission does not allow. Recipient
  addresses, message text and billing amounts follow their own keys.
- Every action checks its own permission key on the server (the discipline of `actions/clients.ts`); UI visibility is not a
  check. Every table below is project-scoped (`PROJECT_SCOPED_MODELS`, immutable-project and `_same_project` triggers,
  scoped client only, raw SQL must name `"projectId"`). One project's campaigns, links, dues, settings and credentials are
  invisible to another, and a campaign cannot reference another project's client, group, account or template.
- Email passwords are encrypted at rest, never returned to a page, never logged. Billing amounts are readable only with the
  billing key and are not written to `ClientActivity` or `SystemLog`.
- Audit: `CampaignEvent`, `ClientDueEvent`, link/unlink events; `SystemLog` entries carry counts, ids and actors only.
- Feature flag: all of it sits behind `CLIENT_CENTER` (off by default); with it off every page and action refuses.
- Nothing in this plan sends, schedules or starts a process; tests use fakes (§11).

## 8. Permissions (minimum; no role or existing level changes)
Proposed new keys: `clients.view_billing`, `clients.edit_billing`, `campaigns.view`, `campaigns.create` (draft, submit,
withdraw, cancel own), `campaigns.approve` (approve/reject; granted to no role by default), `communications.manage_email`
(email settings and test). **Linking a WhatsApp chat** and **authorizing a group for campaigns** each need an authorised
admin: either new keys (`clients.link_whatsapp_chat`, `campaigns.authorize_group`) or reuse of existing ones; left open (§14
Q3 and Q14) because it decides how many keys are added (up to eight in total). Nobody is granted
anything by a migration; the Administrator module is re-synced by the seed as always. `clients.view_billing` does not end
in `.view`, so the Read Only role does not receive billing data.

## 9. Migrations (all additive; names after `20261012100000_client_center`; each with a rollback executed on a throwaway database before review)
1. `…_client_billing`: `ClientDue`, `ClientDueEvent`, `ClientDueStatus`, triggers, permission rows.
2. `…_client_whatsapp_chat_link`: `ClientWhatsAppChatLink`, partial unique index (active link per account + chat), triggers.
   `…_consent_evidence`: `ClientConsentEvent` (append-only), an evidence-source enum and columns for the current evidence on
   `ClientChannel`; **no existing row is rewritten** (existing OPTED_IN rows simply count as unproven).
3. `…_email_module`: `EmailSettings`, `EmailOutbox`, enums, triggers, permission row.
4. `…_campaigns`: `MessageTemplate`, `Campaign`, `CampaignRecipient`, `CampaignEvent`, `CampaignGroupAuthorization`, enums,
   triggers, permission rows.
5. `…_action_type_client_campaign`: `ALTER TYPE "ActionType" ADD VALUE 'CLIENT_CAMPAIGN'` alone, then
   `OutboundMessage.campaignRecipientId` in the following migration (a new enum value cannot be used in its own migration).

## 10. UI pages (Clients module, behind `CLIENT_CENTER`)
Client page: **Billing** card (dues, history) and **WhatsApp chat link**; **Dues** list; **Campaigns** list; **New campaign**
(audience type first, then recipients, message, preview); **Review & submit** (exact message, recipient table with rejects and
reasons, counts, estimated duration); **Approvals** (pending queue for approvers); **Campaign detail** (state timeline,
approver, rejection reason, expiry countdown, per-recipient results, cancel); **Templates**; Settings → **Email**. Empty,
loading, error and permission-denied states as elsewhere.

## 11. Tests (all with fake providers — no real message, email or SMS is ever sent)
Billing permissions, blank amount/currency, audit; chat link (manual only, one active link per chat, no auto-link, unlink,
ambiguous refused); recipient resolution (group never becomes individual and vice versa, suffix mismatch refused, unlinked
client rejected, no stored conversation rejected); consent (UNKNOWN and OPTED_OUT blocked at submit and again at send; OPTED_IN without source or note refused server-side; history
append-only; Phase 3 OPTED_IN rows without evidence blocked); group authorization (an unauthorized group rejected, client
consent never authorizes a group, revocation stops unsent rows, approver view shows name and member count or "unknown");
chat-link suggestion (shown, never links by itself, `@lid` never suggested); single-admin (submitter cannot approve, campaign stays
pending and lapses at 24 h);
approval (self-approval refused, different admin required, material change invalidates, double approve once, stale hash
refused, edit after approval returns to draft, expiry at 24 h enforced at approve, queue and before each send, expired
rows never sent, cancel mid-send stops the rest); idempotency (queue twice → one row per recipient); worker gates (kill
switch, membership, chat verification, per-minute cap, completion, approval expiry); email outbox (accepted ≠ delivered,
UNKNOWN not retried, one recipient per message, password never returned); SMS (interface only: selecting SMS is refused with
"not connected"); blank-amount rendering; due-reminder proposals never send; cross-project isolation of every new table; feature
off refuses everything; Messenger/Instagram unchanged (existing Omnichannel suites); full existing regression suites.
Added at the second review: Telegram (like Messenger/Instagram) refused as a campaign target; no schedule field or delayed start
exists (approval queues at once); currency required only with an amount, only from the project's enabled list, none assumed;
a blank amount drops its whole line and nothing else; campaign list/detail/recipients filtered server-side by permission
(a user without the key gets nothing, by URL guess too); chat linking and group authorization refused for a non-authorized
admin; approval blocked with the reason for an unfound or unauthorized group, a disconnected or non-member account, or an
unknown member count; refreshing the count updates it; a known count never substitutes for group authorization or consent.

## 12. Dependencies
`nodemailer` (or an equivalent SMTP client) for email — **not added yet**; verify version and advisories at the time it is
added. No SMS dependency. No change to `xlsx` or any current dependency.

## 13. Proposed order
**4A** manual billing and Dues (**built 13 Oct 2026, uncommitted, awaiting review**: migration `20261013100000_client_billing`, see CLIENT_CENTER.md) → **4B** WhatsApp chat linking (**built 13 Oct 2026, uncommitted, awaiting review**: migration `20261013110000_client_chat_link`, key `clients.link_whatsapp_chat`, from the client page only) → **4C** Email module (settings, outbox, loop; credentials
entered later) → **4D** campaigns with approval, group audience first, then individual, then email → (later, once
§14 Q7 is answered) due-reminder proposals. SMS stays interface-only. Each stage: migration plus executed rollback on a
throwaway database, isolation and feature-off tests, a browser pass, then a stop for review.

## 14. Open questions (undecided — not silently decided above)

Resolved at the 13 Oct review and now recorded as decisions 13–16: **Q4** (suggestions allowed, link only after admin
confirmation), **Q5** (consent evidence: source and note mandatory), **Q6** (groups need their own explicit
authorization; client consent does not apply), **Q12** (single admin: stays pending, no self-approval).

Adopted at the second review (decisions 17–23): authorized-admins-only for chat linking and group authorization;
Telegram excluded; immediate send only; configurable currency list with currency required only when an amount exists;
blank amount drops its whole line; server-side campaign visibility; approver member-count refresh with blocking when a
group cannot be verified. **Q9 (Telegram) and Q10 (scheduling) are closed by these.** What is still open inside them is
listed below.

Still open (owner confirmation needed — nothing below is decided):
1. **SMS:** which gateway, whose credentials, and when? Real SMS sending depends on this; only the interface is planned. No
   provider is assumed.
2. **Email:** which SMTP provider, sender address/domain, credentials (entered later through the existing secret encryption),
   and the provider's real sending limits for the defaults. No provider is assumed.
3. **Permission for chat linking:** *built as a new key `clients.link_whatsapp_chat` (4B), granted to no role by the
   migration; the Administrator module gets it from the seed.* Which custom role, if any, should also hold it is yours to
   decide in Permission Modules.
5a. **Consent evidence vocabulary:** the proposed sources are WRITTEN, VERBAL, SIGNED_FORM, CLIENT_MESSAGE, OTHER; confirm or
    change the list, and whether OTHER requires a longer note.
7. **Due reminders:** when are proposals generated (how many days before / after a due date), how many per due, who is told that
   one is waiting, what happens to a due whose proposal nobody approves in time, and the stop rules. **No due-reminder rule is
   assumed or built.**
8. **Amount inside a sentence:** refuse such a template at save, warn, or render the sentence without it? Are `{{payment_link}}` and
   an invoice number to exist as manual fields, or stay out?
11. **Currency list:** who may edit it, and what is on it initially (none is assumed); should the due form remember a staff
    member's last-used currency as a convenience (not stored as a default)?
13. **Campaign visibility rules:** may a creator see only their own campaigns while approvers see all pending ones, or does
    `campaigns.view` show every campaign in the project? May the submitter see who approved/rejected and the reason? (Assumed
    yes.)
14. **Group authorization permission:** which key (new `campaigns.authorize_group` or an existing one), and may the person who
    authorizes a group later approve a campaign that uses it? (No rule is proposed that forbids it.)
15. **Member-count freshness:** how recent must a count be for approval to proceed (a time window)? Counts come from WhatsApp on
    demand and can be empty.
