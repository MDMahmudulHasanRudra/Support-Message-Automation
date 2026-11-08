# Menu bots and automation templates

Feature `MENU_BOTS`, **on by default**, because every bot starts as a draft and answers nobody until a person switches it on. It
uses the Automation Rules keys (`automation_rules.view/create/edit/delete/activate`). Pages: `/menu-bots`, `/menu-bots/<id>` and
`/rules/templates`.

A customer sends a start word and gets a numbered menu. Typing a number moves through it, `0` goes back, `00` returns to the start,
and "agent" (or too many wrong answers) hands them to the team. Numbers rather than buttons, because a linked-device WhatsApp number
cannot send buttons. The same numbered text works on Messenger, Instagram, Telegram and the website widget.

## Where it sits

`packages/shared/src/menuBots.ts` is pure: reading an answer, rendering a step, checking a bot. The editor's Try it panel and the
worker call the same functions, so what you test is what customers get.

`apps/worker/src/menuBot/menuBot.ts` is called from two places in `processIncomingMessage`, after the Primary gate:

- **Before the rules:** a customer inside a running menu. "1" means nothing to a rule.
- **After the rules, on a genuine NO_MATCH, before AI:** can this message start a menu? A rule that matches still wins, so anything
  already automated behaves as it did.

On the channels it is one call in `inboundProcessor.storeMessage`; a message a menu answered is marked so the AI loop leaves it alone.

With no bot switched on, each message costs one small query.

## Rules worth not undoing

- **Only ever an answer to a message the customer just sent.** It runs inside the ordinary pipeline, so a message older than the
  automation window never reaches it. On a channel, older than 15 minutes, a group chat, or outside the provider's reply window is refused.
- **The same gate and queue as any automatic reply.** `checkAutoReplySafety` (kill switch, MANUAL_ONLY, monitored group, rate limits)
  and `enqueueOutboundMessage`, with no cooldown of its own. The `menu-bot` variant is left out of the AI reply cooldown at queue and
  send time, because a menu step is the customer pressing a number, not the AI answering.
- **One step per customer message.** `MenuEvent` is unique on (project, message) and written with the state change in one transaction
  under a per-chat advisory lock. A replay re-sends the same words under the same key and never advances the menu twice. One ACTIVE
  session per chat and sender is a partial unique index.
- **A person stepping in ends the menu.** A team member's message, an outgoing message that is not one of this session's own replies
  (compared by text, so a second number's copy of the bot's reply does not count), or an agent reply on a channel.
- **Quiet after a hand-over.** A HANDED_OFF session within `quietMinutes` stops a start word bringing the robot back, and AI is paused for the same time.
- **A sentence is not a wrong number.** More than three words releases the message to the rules and AI as if the bot were not there.
- **Whole-message start words.** A keyword inside a sentence is somebody saying something else.
- **A bot goes live only with nothing unfinished** (`menuTreeProblems`): empty steps, broken choices and template placeholders block Switch on.

## Templates

Menu templates (English and Bangla) and rule templates live in `packages/shared/src/menuBots.ts`. Both create DRAFTS with
`[your ...]` placeholders. Rules have no placeholder check, so the edit page opens straight after adding one.

## Not built

Tagging a conversation from a step, real buttons on channels that support them, and collecting typed details (name, address) as a step.
