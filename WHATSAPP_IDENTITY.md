# WhatsApp identity and message integrity

Who sent a WhatsApp message, and which stored rows are one message. Written 11 Oct 2026.
This is the reference for `packages/shared/src/whatsappIdentity.ts` and everything that reads it.

## 1. Why this exists

Before this change, six separate copies of the code decided whether a sender was a team member,
and they disagreed:

- **The live pipeline** (`resolveActiveTeamMember`) let a WhatsApp-id match win outright, considered
  ACTIVE members only, and took the first row the database returned.
- **The Team Report, Support Intelligence, Call Activity and the group reports** each built a flat
  identifier → member map with no precedence between the two kinds of identifier:
  - three of them kept the first member in a shared slot (in name order, or in whatever order the
    database returned), and one kept the last;
  - one compared the sender with no normalisation at all.
- **Attendance** kept a private copy of the identifier list.
- **The Support Activity mention check** compared phone digits only, so a colleague @-mentioned by
  their LID read as a customer.

So one sender could be one person live and another person in a report. And when a sender's
WhatsApp id pointed at member A while their phone digits pointed at member B, whichever came first
silently won.

The stored data had two problems of its own:

- **The sender's domain was thrown away.** `Message.senderPhone` strips it, which makes a LID
  (WhatsApp's opaque per-person id, 1,118 of 1,151 stored messages at one count) indistinguishable
  from a dialable phone number.
- **Reports did not collapse every copy of a message.** They deduplicated on the stored
  `whatsappMessageId`, which begins `true_` on the account that SENT a message and `false_` on every
  other account that received it. Anything one of our numbers posted in a group another of our
  numbers is also in was therefore counted twice: once as the business's reply, and once as a
  customer message that opened a wait nothing could close.

## 2. Sender ids

| Column | Holds | Notes |
|---|---|---|
| `Message.senderPhone` | the id with its domain stripped | unchanged; every existing reader keeps working |
| `Message.senderJid` (new, nullable) | the id exactly as WhatsApp gave it: `8801…@c.us`, `1616…@lid` | the only thing that tells a phone from a LID |

`parseWhatsAppId` reads an id as one of these kinds:

- `PHONE` (`@c.us`, `@s.whatsapp.net`)
- `LID` (`@lid`)
- `GROUP` (`@g.us`)
- `BROADCAST`
- `NEWSLETTER`
- `UNKNOWN` (no domain, e.g. a row stored before `senderJid` existed)

A multi-device suffix (`8801…:12@s.whatsapp.net`) is dropped.

**Where the provider takes the sender from** (`toRawIncomingMessage`, OpenWAProvider.ts):

- A group message: `author`, then the attached contact's id. When WhatsApp names neither, it falls
  back to `from`, which for a group is the GROUP's id. That fallback keeps its `@g.us`, so the
  identity rule reads it as NOT A PERSON. Previously its digits could match a colleague.
- The sender's name: `sender.pushname`, then the message's own `notifyName`, then
  `sender.formattedName`. `notifyName` is present for unsaved LID contacts.

A LID is never shown as a phone number anywhere (`describeSenderId`).

## 3. The identity rule

`createSenderResolver(members).resolve(senderPhone, senderJid)` is pure and unit-tested in
`packages/shared/src/__tests__/whatsappIdentity.test.ts`.

1. **Read the id.** The domain-carrying id is used when we have it. A group, broadcast or channel id
   is `NOT_A_PERSON` and never matches anybody.
2. **Collect the evidence.** There are two kinds:
   - the member's `whatsappId`, compared **exactly**: a LID has no format a person could have typed
     wrongly;
   - the member's `phoneNumber`, compared **digits-only on both sides**: people type "+880 17…",
     WhatsApp delivers "88017…".
3. **Decide.**

| Status | When | Credited to | `isRosterMember` |
|---|---|---|---|
| `WHATSAPP_ID_AND_PHONE_MATCH` | both kinds name the same one member | that member | true |
| `WHATSAPP_ID_MATCH` | only the WhatsApp id names one member | that member | true |
| `PHONE_MATCH` | only the phone digits name one member | that member | true |
| `CONFLICT` | the id names one member, the phone another | **nobody** | true |
| `AMBIGUOUS` | one identifier is shared by several members | **nobody** | true |
| `UNRESOLVED` | nothing matches | nobody | false |
| `NOT_A_PERSON` | a group, broadcast or channel id | nobody | false |

**Neither kind of evidence overrides the other.**

**CONFLICT and AMBIGUOUS keep `isRosterMember: true`.** Every candidate is a colleague, so the message
is certainly from the team even though which colleague is unknown. Everything that hangs off "this
is staff" therefore behaves exactly as before:

- no auto-reply;
- no customer wait;
- the human-takeover pause;
- the `Message.isFromTeamMember` stamp.

Only the attribution waits for a person to fix the roster.

**Who is passed in is the caller's decision, and it is the only difference between callers:**

- the live pipeline passes **ACTIVE** members (a departed colleague is a customer again);
- reports, the chat and reconciliation pass **every** member (history keeps its owner).

A display name is never evidence.

### Where it is used

| Caller | File |
|---|---|
| live pipeline: staff check, Support Activity, response tracking, attendance | `apps/worker/src/pipeline/teamFilter.ts` (`resolveTeamSender`) |
| Support Activity mention check | `apps/worker/src/supportActivity/detector.ts` |
| attendance recompute (`identifiersFor`: an identifier shared with another member is left out) | `apps/worker/src/teamManagement/attendance.ts` |
| Team Report and every `/reports/<id>` built on it | `apps/web/src/server/teamReport.ts` |
| Support Intelligence (sender, quoted sender, mentions) | `apps/web/src/server/intelligence/loader.ts` |
| Call Activity | `apps/web/src/server/reports/activityReports.ts` |
| Inactive Groups / Executive Health sender labels | `apps/web/src/server/reports/groupReports.ts` |
| WhatsApp Chat thread names, contact and group panels | `apps/web/src/server/chatInbox.ts`, `chatProfiles.ts` |
| Team Members candidates from history and from WhatsApp | `apps/web/src/server/actions/teamMembers.ts` |
| reconciliation | `packages/db/prisma/reconcileMessages.ts` |

**Response tracking.** `classifyResponseMessage` takes `unattributedRosterMember`. An unsettled
colleague is `OTHER_TEAM`: they neither open a wait nor answer one.

### Messages from our own numbers

When account A posts in a group account B is also in, B receives it as INCOMING. The pipeline now
recognises it (`apps/worker/src/pipeline/ownAccounts.ts`) and stores B's copy as the business's own
message (`OUTGOING`): no rules, no AI, no escalation opened, no customer wait. It counts as a reply
everywhere, exactly like A's own copy.

The evidence, any one of which suffices:

1. **The sender is one of the project's accounts' phone numbers.**
2. **The sender id is one our accounts have sent from in a group.** In a group, an outgoing row's
   sender is its author, which is our own id (usually a LID). One-to-one rows are never used as
   evidence: their sender field comes from `from`, and a wrong "ours" would silently stop a
   customer ever being answered. A test pins that a one-to-one outgoing row cannot turn a customer
   into us.
3. **One of our outbound rows in the chat, from the last 15 minutes, carries the same WhatsApp
   key.** This covers the first message from a number whose own echo has not been stored yet.

(1) and (2) are cached per project for five minutes. (2) also learns from every outgoing group
message as it is stored.

**Attribution is decided when a report is read, never stored.** A stored attribution would drift the
moment the roster is corrected, so every report reinterprets history against today's roster, exactly
as the Team Report always did. `Message.isFromTeamMember` stays what it always was: the pipeline's
record of what it decided at the time. Nothing rewrites it.

## 4. Team Members: identity mapping and its history

- **Every change to a member's `phoneNumber` or `whatsappId` is a System Log entry** (scope
  `team-members`), with the before and after values side by side. This applies to the form, the
  edit page and the chat link below.
- **Linking a sender in WhatsApp Chat** (`linkWhatsAppSender`, needs `whatsapp.manage`). The contact
  panel of an unresolved sender offers "This person is…". It does three things:
  - fills the chosen ACTIVE member's empty `whatsappId`;
  - runs the same conflict checks as the form;
  - writes the log entry.

  It never replaces an id already recorded; that is an edit on the member's own page.

  Linking is the human verification WhatsApp cannot provide: nothing WhatsApp exposes to this
  deployment links a LID to the phone number a person was entered with.
- **Candidates from history and from WhatsApp's member list** go through the rule, so an existing
  colleague is never offered again. A sender equal to the group's own id is never offered as a person.
- **The members-command race is fixed.** "Read members from WhatsApp" now looks up the request for
  THIS group (PostgreSQL JSON path on `WorkerCommand.payload`). It used to read the newest request in
  the whole project, so two people fetching two groups could see each other's results.

The roster's own collisions (two members sharing an identifier) are listed by
`reconcile:messages`, and they show in the chat as "identity needs review".

## 5. One logical message

`logicalMessageKey(chatId, whatsappMessageId)` is the chat plus WhatsApp's own key id (the third
segment of OpenWA's serialised id). That key is the same on every account's copy. An id not in
OpenWA's shape is its own key and is never merged with anything.

`messageKeySql()` (`apps/web/src/server/messageIdentity.ts`) is the same rule in SQL, and a test pins
the two together.

**Reports deduplicate on it:**

- Team Report (and every report built on it)
- Overview's "how long customers wait" chart and Team Performance's first-response figures (also
  one conversation per WhatsApp group, not per account copy, and system messages excluded)
- Support Intelligence
- Call Activity
- Executive Health's previous-period counts
- the chat panels' counts

`preferSenderCopySql()` keeps the sending account's own OUTGOING copy, so our own post is the
business's reply and not a customer message. Inactive Groups' "last activity" breaks the timestamp
tie the same way.

Nothing is merged or deleted in storage: `@@unique([accountId, whatsappMessageId])` stays the
pipeline's dedup guard, and each account keeps its own row.

## 6. Reconciling stored history

```bash
pnpm db:reconcile:messages                       # dry run: reads every project, changes nothing
pnpm db:reconcile:messages -- --project isp-digital
pnpm db:reconcile:messages -- --json             # machine-readable
pnpm db:reconcile:messages -- --apply            # also backfills Message.senderJid
# in Docker (the migrate image carries packages/db/prisma and tsx; working dir is packages/db):
docker compose run --rm --entrypoint npx migrate tsx prisma/reconcileMessages.ts           # dry run
docker compose run --rm --entrypoint npx migrate tsx prisma/reconcileMessages.ts --apply
```

**It reports, per project:**

- copies of one message held by two of our accounts (expected) and duplicates inside one account
  (should be zero);
- `senderJid` present / recoverable / unknown;
- implausible timestamps;
- group messages with no group row;
- messages whose sender is the group itself;
- every distinct incoming sender's status against today's roster, with each CONFLICT / AMBIGUOUS
  sender and the members they match named;
- the roster's own collisions;
- how many messages were stamped "customer" but are now on the roster (sent before they were added;
  reports already count them), and the reverse.

**`--apply` changes only `Message.senderJid`:**

- only where it is NULL;
- only to a value the row itself proves (`recoverSenderJid`):
  - an incoming group message's key names its author;
  - an incoming one-to-one message's chat is its sender;
- outgoing rows are never guessed.

It runs in keyset batches, is idempotent and is restartable. Validated on the throwaway database:
a second apply filled 0 rows. Each apply writes one System Log row per project.

**To revert an apply:**

```sql
UPDATE "Message" SET "senderJid" = NULL WHERE "createdAt" < '<time 20261011091800 was deployed>';
```

Before that migration no row had a value, so this restores the pre-apply state exactly. A backup is
still recommended before `--apply` on production; the column is additive, so the risk is low.

## 7. WhatsApp Chat: contact and group panels

**The URL drives them:**

- `?contact=<WhatsApp id>` and `?info=group` on a group conversation;
- `?contact=1` on a personal chat.

They are server-rendered, bookmarkable and closed by the back button, and they refresh with the
inbox's 4-second poll.

**Thread.**

- An incoming sender is shown by roster name when the rule names one member. Otherwise by WhatsApp
  name, otherwise by `+number`, or `WhatsApp user ···1234` for a LID.
- The name opens the contact panel.
- An unsettled colleague carries "identity needs review".
- A reply shows the message it quotes ("You" for our side, as WhatsApp does).
- `isTeamMember` stays the stamped flag on purpose: the inbox's "waiting" definition reads it, and
  the header must agree with the list.

**Contact panel** (`getContactProfile`):

- WhatsApp details: the phone only when the id IS a phone number; a LID is labelled as a private id;
  WhatsApp names seen;
- the roster match: designation, department and Team; the identifiers on their record need
  `whatsapp.view`; a conflict names both members;
- the link form (`whatsapp.manage`);
- message counts and first/last seen, counted once per logical message;
- the groups they wrote in, linked to this account's copy;
- their personal chat with this account.

It says plainly that profile photos and "about" text are not collected.

**Group panel** (`getGroupProfile`):

- id, our number, flags, the assigned member, and the participant count labelled "last read from
  WhatsApp";
- **Members right now:** the last member list read from WhatsApp, with the time it was read, and a
  "Read members from WhatsApp" button (`whatsapp.manage`; reuses `GET_GROUP_PARTICIPANTS`);
- **People seen in this group:** senders of stored messages across every copy of the group. It is
  labelled as not being the member list: someone may have left, and a quiet member never appears.
  Our own numbers are marked.

## 8. The API surface

This app has no JSON API for chat or reports by convention. Pages are Server Components, mutations
are Server Actions, and the Route Handlers are file downloads and webhooks only. Nothing here adds a
route; the readers below are the interface.

| Capability | Function | Gate |
|---|---|---|
| Messages of a group / personal chat | `getChatThread(groupId)`, `getPersonalChatThread(accountId, chatId)` | page: `messages.view` |
| Contact profile | `getContactProfile(session, accountId, senderId)` | page: `messages.view`; roster identifiers `whatsapp.view` |
| Group details and people | `getGroupProfile(session, groupId)` | page: `messages.view`; live read `whatsapp.manage` |
| Resolve a sender | `createSenderResolver` (shared), `resolveTeamSender` (worker), `loadReportSenderResolver` (web) | — |
| Link a sender to a member | `linkWhatsAppSender(senderId, …)` | `whatsapp.manage` |
| Read a group's members from WhatsApp | `requestGroupParticipants` / `readGroupParticipants` | `whatsapp.manage` / `whatsapp.view` |
| Employee / team reports | `loadTeamReport`, `/reports/<id>`, existing export routes | unchanged |
| Unresolved identities | `reconcile:messages` (operator), chat "identity needs review" | — |

Every reader runs through the project-scoped client. Every raw query names `"projectId"`, as the
`rawSqlProjectFilter` tests require. Another project's group or sender is not found.

## 9. What this does NOT do (and why)

- **LID ↔ phone mapping from WhatsApp:** not built. OpenWA 4.76 exposes no supported lookup, and the
  in-page stores that hold one are undocumented and unverifiable here. A LID is linked to a person
  by a human (§4), or by adding them from a group, which stores the id they actually use.
- **Edited and deleted messages are not captured.** `onAnyMessage` only delivers new messages; an
  edit or a revoke changes an existing one. A deleted customer message keeps its original body here.
- **Catch-up covers groups only.** Personal chats missed while the worker was down are not recovered.
- **`isFromTeamMember` is not backfilled.** It records what the pipeline decided at the time, and
  reports do not depend on it except as a fallback. The figures stand in `reconcile:messages`.
- **Overview's response-time chart and Team Performance's first-response figures still read the
  stamped `isFromTeamMember`**, not the identity rule, to decide what is a reply. Their waits are
  now counted once per WhatsApp group (§5), so the figures can drop where two of our numbers share
  groups: that is the double count going away, not a change in the team's speed.
- **An invalid WhatsApp timestamp still drops the message.** Storing receive time in its place would
  invent a send time.
