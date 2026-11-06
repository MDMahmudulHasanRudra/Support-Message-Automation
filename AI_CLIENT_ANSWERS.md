# AI answers about a customer's own account

Three `AiSettings` switches, all **off by default**: `clientAccountAnswers` (package, state, expiry), `clientDueAnswers`
(what they still owe, needs the first) and `clientAccountAutoReply` (AI replies by itself, below). Active only while `CLIENT_CENTER` and its Subscriptions / Billing sub-modules are on.

Status: built and tested on an isolated database only. Not deployed, and never tried with a real customer or number. Try it on one test number first.

## Where it reaches customers

- **AI Copilot drafts**, for an agent, in a one-to-one WhatsApp chat, with the first two switches.
- **AI's own replies in a one-to-one WhatsApp chat**, with a third switch, `clientAccountAutoReply`, also off by default. The owner
  chose this on 6 Nov 2026 over sharing dues inside a group.
- **Never** in a WhatsApp group, and never on Messenger, Instagram, Telegram or website chat, which cannot prove who the customer is.

### The one-to-one gate (`personalAccountGrounding`)

This is the first time AI replies by itself in a personal WhatsApp chat, so everything else about personal chats stays as it was. AI
goes on only when ALL of this holds:

1. the switch is on, with every ordinary gate: kill switch, MANUAL_ONLY, AI Engine, auto response, the `AI_REPLY` entitlement, and
   "only the Primary account answers";
2. the message is a question about the customer's own account;
3. the sender is matched to exactly one live client;
4. it asks for nothing a person must do (pay, renew, change, disconnect);
5. no person has replied in this chat within `humanTakeoverCooldownMinutes`. A dashboard send that failed is no reply, and AI's own
   earlier answers do not count. A personal chat has no group row to hold `aiSuppressedUntil`, so this is read from the messages.

**Anything else ends silently**, with no AI call, no decision row, no alert and no reply. An ordinary personal message must behave
exactly as it does with the switch off, or every "ok thanks" would raise an "AI Assistance Required" alert.

Once past the gate, the ordinary path applies. An amount it was not given, or a low-confidence answer, hands over with the usual
alert. No holding reply is sent there ("we could not understand"): AI spoke only because it had the customer's own answer to give.
The reply goes through `enqueueOutboundMessage`, the rate limits and the AI reply cooldown.

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
