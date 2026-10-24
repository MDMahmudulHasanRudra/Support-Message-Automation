# 08 — Saying that an AI reply is automated (Facebook Messenger and Instagram DM only)

A separate, backward-compatible work package on branch `feat/ai-disclosure`, built on
`feat/meta-oauth`. **It is off by default.** Until someone switches it on for a Messenger or
Instagram connection, every AI reply is exactly what it was.

## What Meta requires

Meta's Messenger Platform policy (Messenger Platform policy overview, "Automated experiences") says
this applies **where required by applicable law**; Meta names California and Germany. In those
places, automated chats must disclose that they are automated:

- at the start of a conversation;
- after a significant lapse of time;
- when a person hands the conversation back to automation.

It recommends disclosure as good practice elsewhere.

**Meta does not require a disclosure on every reply, and gives no number for "a significant lapse of
time".** Whether the law applies depends on where each customer is, which this software cannot know.
So the feature is a **per-connection setting**, not a hard-coded rule:

- an administrator switches it on for the Pages and Instagram accounts whose audience needs it;
- the quiet-spell length is the administrator's choice. The default of 24 hours is this app's, not
  Meta's, and 0 turns the quiet-spell rule off.

## Scope and isolation

**Applies to Facebook Messenger and Instagram DM AI replies only.** Unchanged:

- WhatsApp: the OpenWA session, its AI fallback (`runAiFallback`), automation rules, outbound
  queue, human takeover, group and personal chats, and reports;
- Telegram;
- the AI Admin Assistant and every other AI module.

**How the isolation is achieved:**

1. **One place.** The disclosure runs only in `apps/worker/src/channels/aiReply.ts`. That file is
   the channel AI path; WhatsApp never passes through it. A structural test
   (`aiDisclosureIsolation.test.ts`) fails if any other worker file uses the disclosure helpers, or
   if any file under `aiFallback/`, `pipeline/`, `queue/`, `provider/`, `notifications/` and the
   WhatsApp report modules mentions them.
2. **An explicit provider check.** That file has one line:
   `const disclosure = isAiDisclosureChannel(type) ? await disclosureFor(message) : null;`
   `isAiDisclosureChannel` is true for `MESSENGER` and `INSTAGRAM` only. A Telegram connection never
   discloses, even if its database row says it should (tested). The web refuses the setting for a
   Telegram connection.
3. **A pure helper.** The rule (`decideAiDisclosure`, `packages/shared/src/aiDisclosure.ts`) has no
   side effects and is imported only by that file and the settings UI and action. No WhatsApp or
   Telegram file changed (`git diff feat/meta-oauth --stat`).
4. **The existing AI controls are reused.** The connection's existing "AI may answer customers"
   switch decides whether AI replies at all. The disclosure is part of an AI reply, so with AI off
   there is no AI reply and nothing to disclose. The disclosure switch is shown only while AI is on.
   There is never a standalone disclosure message and no background sending.

## Behaviour (Messenger / Instagram, AI on, the disclosure switched on)

The disclosure line goes **above the answer, in the same message**, and only:

| Reason | When |
|---|---|
| `FIRST` | No earlier AI reply in this conversation carried it. |
| `AFTER_HUMAN` | A person replied after the last disclosure: an agent here, or the business in Meta Business Suite (seen as an echo). |
| `AFTER_IDLE` | The conversation was quiet for the connection's quiet spell before the customer's message (default 24 h; 0 = never). |

Otherwise there is no line.

- **A person's reply never gets it.** The disclosure is added only inside the AI reply path; a reply
  typed in the inbox goes through the unchanged reply action (tested).
- **The answer is untouched.** It is decided after every existing gate has passed:
  - kill switch;
  - AI settings;
  - the connection's AI switch;
  - human takeover;
  - the reply window;
  - the 15-minute age limit;
  - cooldown and the hourly ceiling;
  - knowledge;
  - confidence;
  - the business-question guard;
  - grounding;
  - the length limit.

  The prompt, the RAG retrieval and the thresholds are unchanged.
- **Windows.** The disclosure never opens a window. The reply is still refused outside Meta's
  window before it is written, and again at send time by the unchanged outbound queue.
- **One message, one idempotency key** (`ai:<message id>`): a retry cannot send the line twice.
- **Never sent undisclosed.** If the line and the answer together exceed the channel's limit
  (Messenger 2,000 characters, Instagram 1,000 **bytes**), a person answers instead:
  `REPLY_TOO_LONG_WITH_DISCLOSURE`, with the usual handover alert.
- **History decides.** `ChannelMessage.aiDisclosed` marks a reply that carried the line. A disclosing
  reply that FAILED never reached the customer and does not count.

## Settings page

On Settings → Messaging Channels → a Messenger or Instagram connection, **while "AI may answer
customers" is on**:

- an **information notice** that:
  - AI replies may need to be identified as automated;
  - Meta's policy and the law may require it;
  - the setting affects only this connection;
  - replies typed by people never get it;
  - WhatsApp and Telegram are not affected.
- **Say that AI replies are automated** (switch).
- **Disclosure wording.** Empty means the built-in English text; write it in your customers'
  language.
- **Disclose again after a quiet spell of N hours** (0–720; 0 = never).

Telegram connections show none of this.

## Data

Migration `20261025100000_channel_ai_disclosure` adds four columns. It is additive; rollback drops
them.

- `ChannelConnection.aiDisclosureEnabled` (default false);
- `ChannelConnection.aiDisclosureText` (nullable);
- `ChannelConnection.aiDisclosureIdleHours` (default 24);
- `ChannelMessage.aiDisclosed` (default false).

## Tests

| Suite | What it proves |
|---|---|
| shared `aiDisclosure.test.ts` (11) | off; first; no repeat; after a person; the quiet spell from the connection's setting, and 0 = never; Messenger/Instagram only; wording; limits on the wording and the hours |
| worker `channels.integration.test.ts` (10 new) | switch off = the exact original reply; **Messenger AI off** and **Instagram AI off** → no reply and no disclosure; **Messenger AI on** → first / not repeated / after an agent reply; **Instagram AI on** → custom Bangla wording; **Telegram never** discloses, even with the database flag set; quiet spell 0 vs 24, and a FAILED disclosure not counted; **confidence, idempotency, cooldown and takeover** unchanged with the disclosure on; **outside Meta's window** → nothing sent; **length limits** on Messenger (characters) and Instagram (bytes) → handed over, nothing queued |
| worker `aiDisclosureIsolation.test.ts` (3) | only `channels/aiReply.ts` uses the disclosure; the explicit Meta check is there; no WhatsApp AI fallback, pipeline, queue, provider, notification or report file mentions it |
| web `channels.integration.test.ts` (2 new) | a person's reply with AI and the disclosure on is stored exactly as typed (`aiDisclosed` false); the setting is saved per connection; a viewer and an over-long wording are refused; **Telegram refuses the setting**; out-of-range hours are refused |
| WhatsApp, unchanged suites | worker `aiFallback.integration` (AI output, confidence, human takeover), `aiReplyHardening.integration` (outbound queue, cooldowns), `pipeline.integration` (the incoming pipeline and rules), `bulkAutomationRules.integration` and `ruleProposalToExecution.integration` (automation rules), `multiAccountRouting.integration`, `groupBroadcast.integration`; engine `evaluate` / `matchers` / `conditions`. They are unchanged files and run in the full suites against the same code. |

**Mutation check.** Each defect below was introduced alone; the suite failed every time.

- the switch ignored;
- a FAILED disclosure counted;
- sent without the disclosure when too long;
- the "after a person" rule removed;
- idle always true;
- "enabled" ignored in the rule;
- over-long wording accepted;
- **no explicit Meta check, so Telegram gets it**;
- **the quiet-spell setting ignored**;
- **the disclosure wired into the WhatsApp AI fallback**;
- **Telegram accepting the setting**.
