# Contacts

Feature `CONTACTS`, **on by default**, because it is a list of people and sends nothing by itself. Collecting from chats and
every campaign stay off until somebody starts them. Keys: `contacts.view`, `contacts.edit`, `contacts.delete`,
`contacts.import`, `contacts.export`, `contacts.campaign`. Pages: `/contacts`, `/contacts/<id>`, `/contacts/import`,
`/contacts/campaigns`, `/contacts/campaigns/<id>`, `/settings/contacts`, and a Contact tab beside every conversation.

## Apart from Clients and Billing

A contact has its own serial (`CT-0001`, counted per project, never reused) and an optional free-form code. It is not a
client. The only tie is `Contact.linkedClientId`, a pointer a person chooses. Linking, and copying the client list in, never
write to a client, a due or a subscription.

## The rules

- **A value is held once per project.** `ContactIdentifier` is unique on (project, kind, normalized value), whichever contact
  holds it. `packages/shared/src/contacts.ts` decides what "the same" means: a Bangladeshi number with or without 88, Bangla
  digits, an email in any case, a profile link or its handle. A value already on another contact is reported with whose it is
  and left there; Merge joins two records.
- **One chat, one contact.** `ContactConversationLink` is unique per project on the chat id (the same on all our numbers) or
  the channel conversation. A contact can have many chats and many numbers.
- **A LID is never a phone number.** Only a `@c.us` chat id proves a number (`phoneFromChatId`).
- **`collectContactFromChat` (packages/db) is the one way a chat becomes a contact.** The Contact tab and the worker both call it.
- **Imports fill blanks only.** A row matching a known number or code adds what is missing. Running one twice changes nothing.
- **History is append-only** (`ContactEvent`, trigger). A merge copies the merged record's history first.

## Collecting by itself (`apps/worker/src/contacts/contactCollector.ts`, Settings → Contacts)

Its own 30-second loop over stored messages after a cursor, so the message path never waits for it. Two switches, both off:

- **AI.** Needs the AI engine on. A message holding a number, email or link goes to the model, which can only point at the
  numbered values found in the text, so it cannot invent one (`readContactAiAnswer`). A name must be written in the message. At
  most 5 calls per project per pass; the cursor stops before what is left. A message with nothing in it costs no call.
- **Every new personal chat.** No AI. Saves what the platform proves.

Both start at the moment they are switched on and never read older messages. Never a team member's message, our own numbers,
or a group nobody monitors. It only saves; it never sends.

## Campaigns

- **Someone marked No offers is never included**, whatever is ticked. People never asked are included only by choice (default
  off for email).
- **Email** goes through `EmailOutbox` (purpose `CONTACT_CAMPAIGN`, one key per campaign and person) at the pace set in Settings
  → Email. The worker re-checks archive, opt-out and the address when sending. Each email carries a line saying how to stop;
  a person records that reply by marking the contact No offers.
- **WhatsApp, Messenger, Instagram, Telegram, SMS and calls are a worklist, on purpose.** One person at a time, with the message
  ready. "Send in their chat" uses the ordinary reply path, so a WhatsApp chat that never wrote to us is refused. "Open" hands it
  to the person's own phone. Automatic messages to people who did not write first are how a number gets banned, and the product's
  rule is that a personal chat is answered, never started.

## Limits

A campaign reaches at most 5,000 people, and only the first 1,000 show on its page. An import reads 5,000 rows and runs inside the
request. A file export holds 20,000.
