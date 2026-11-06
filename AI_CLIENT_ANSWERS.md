# AI answers about a customer's own account

Two `AiSettings` switches, both **off by default**: `clientAccountAnswers` (package, state, expiry) and `clientDueAnswers`
(what they still owe, needs the first). Active only while `CLIENT_CENTER` and its Subscriptions / Billing sub-modules are on.

Status: built and tested on an isolated database only. Not deployed.

## Where it reaches customers today

**Only in AI Copilot drafts, for an agent, in a one-to-one WhatsApp chat.** It does not answer customers on its own yet:

- WhatsApp's automatic AI runs only in groups (`checkAiFallbackEligibility`: a DM is always ineligible).
- Account details are never given in a group.
- Messenger, Instagram, Telegram and website chat carry no proof of who the customer is.

The settings page says so. Automatic answers need one owner decision, either of:

1. let the automatic AI answer one-to-one WhatsApp chats, at least for account questions; or
2. treat a group linked to one client (a Clients V3 group link) as that client, which shows dues to everyone in the group.

## Rules worth not undoing

- **Switch off means nothing runs.** No query, no feature read, and a byte-identical prompt. A test pins it.
- **Grounding, never a reply.** Entries titled "Your account (client 0012)" and "Your outstanding dues (client 0012)" go through
  every existing gate.
- **Who the customer is:** the number WhatsApp delivered (`…@c.us`, never a LID) matching exactly one client's PHONE or WHATSAPP
  channel, in exact forms of that number only, never a suffix; or an active `ClientWhatsAppChatLink` a person made. Archived
  clients never match. Two matches give no data, and the question is handed over (`ACCOUNT_AMBIGUOUS`).
- **Looked up only for a question about the account.** No client data enters a prompt about a router.
- **A request is a person's job.** Pay, renew, change package or disconnect hand over as `ACCOUNT_REQUEST`, before any AI call. The
  Copilot still drafts them, because an agent decides whether to send.
- **Copilot permission is decided by the web when the request is made** (`AiDraft.clientAccountAllowed` / `clientDuesAllowed`,
  from `clients.view` and `clients.view_billing`). The worker only narrows by them.
- **Money.** Figures are the Billing List's own (`summarizeOutstanding`): BigInt minor units, per currency, never summed across
  currencies. An open due with no amount is said to need a person, so the AI never answers as if nothing were owed.
- **The price check covers account answers** (`validateAnswerFigures`). Every amount in a reply must be one it was given. Turning
  account answers on never loosens the commerce check.
- **An answer built from one person's record never becomes a rule draft** (`isPersonalRecordEntry`: account, dues, commerce order).
  A rule is a standing answer for everybody, so an approved draft would tell the next person what this customer owes.
- **Evidence snapshots store the entry's title, never its figures or dates.**

## Known limit

The price check is mechanical for money only. Package names and dates rest on the prompt's rule to state them exactly as written.
