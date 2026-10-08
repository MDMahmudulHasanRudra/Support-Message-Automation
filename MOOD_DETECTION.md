# Mood Detection

Settings → Support → **Mood Detection** (`/settings/mood-detection`). Built locally on `rudra`;
nothing is pushed or deployed. Migrations `20261011090000_mood_alert_event` and
`20261011090100_mood_detection` have not been applied to any live database.

Mood Detection notices when a customer is getting angry, frustrated or urgent, and then does only
what an admin has chosen. It adds to the existing system and changes no existing behaviour.
It is **off by default**.

## 1. Detection is separate from action

```
customer message
  → deterministic pre-filter (pipeline)    no signal → nothing is written
  → CustomerMoodEvent (PENDING)            signal → one reading per message
  → optional AI classification (processor) only for ambiguous readings
  → trend                                  the customer's earlier moods in this group
  → threshold + emotion trigger            decideMoodTrigger
  → MoodAlert                              one per escalation (the cooldown unit)
  → MoodAlertAction × N                    each action retried on its own
```

| Piece | Where |
|---|---|
| Pure engine: moods, signals, scoring, trend, decision, group aggregate, AI prompt and parser, policies | `packages/shared/src/mood.ts` |
| Pipeline hook (pre-filter, immediate AI pause) | `apps/worker/src/mood/moodDetection.ts`, called from `runAutomationStageInProject` |
| Processor loop (3 s), alert and cooldown, actions, recovery | `apps/worker/src/mood/moodProcessor.ts` |
| Settings page and action | `(dashboard)/settings/mood-detection/`, `server/actions/moodDetection.ts`, `lib/moodDetectionForm.ts` |
| Read side (settings view, alerts, chat badges) | `server/moodDetectionReports.ts` |

## 2. Moods and levels

| Mood | Level | Default policy |
|---|---|---|
| Neutral, Satisfied (`POSITIVE`) | 0 | recorded, never acted on |
| Concerned, Confused | 1 | recorded only (trigger off) |
| Frustrated | 2 | triggers: Waiting list, MEDIUM |
| Angry | 3 | triggers: pause AI, team alert, internal alert + mention, Waiting list, HIGH |
| Very angry | 4 | triggers: require human takeover, the same alerts, CRITICAL |
| Urgent / distressed | 3 | triggers: pause AI, the same alerts, HIGH |

No mood messages the customer by default.

## 3. What is read

- **Text:** English, Bangla and Banglish phrase lists. Matching uses Unicode word boundaries, so
  Bengali combining marks do not split words. Covers strong negative words, anger statements,
  requests for a manager or to complain, repeated-complaint phrases, urgency, confusion, concern and
  praise.
- **Emoji:** angry, negative, sad and positive sets.
- **Context:** shouting (three or more words in capitals), `!!!`/`???`, a burst (two or more
  messages from the same customer in two minutes), and a complaint repeated across the customer's
  last 30 minutes.
- **Trend:** a rise since the customer's previous reading adds confidence. A climb of three readings
  ending in anger (for example concerned → frustrated → angry) is an `ESCALATING_PATTERN` and reads
  as **very angry**. The window is 6 hours.
- **Stickers:** recorded as `UNKNOWN_STICKER_SIGNAL`, mood NEUTRAL at confidence 0. The meaning is
  never guessed, and a sticker never triggers anything. Trend and the group mood ignore it
  (`confidence > 0`), so a sticker after an angry message neither breaks the trend nor resets the
  customer to neutral.
- **Mixed signals:** praise beside anger ("wow amazing service 😡") is softened (×0.75) and marked
  `needsAi`. With AI off it stays below the default threshold.

**Not available**, and the page says so:

- Inbound **reactions:** OpenWA's `onReaction` needs an Insiders licence this deployment does not
  have. The engine accepts a reaction (`MoodInput.reaction`) so it is ready, but nothing supplies one.
- **Sticker or image pictures:** `packages/ai-client` is text-only by a safety invariant, so no image
  is ever looked at.

## 4. AI classification

This is optional (`useAiClassification`, off by default).

- **When the AI is asked:** only for readings the pre-filter marks `needsAi`. That means mixed
  signals, a level-2 or higher mood at 50–85% confidence, or a long message with a level-1 or higher
  signal. A clear "😡 worst service" never reaches the AI, and neither does a message with no
  signal.
- **Which model:** the RESPONSE job's model, through `resolveAiClient`. That is gated on
  `aiEngineEnabled`.
- **What the AI sees:** the last 10 messages, reduced to `[CUSTOMER]` / `[SUPPORT]` / `[OTHER]` roles.
  No names or numbers are sent.
- **How the answer is read:** strictly, as `MOOD / CONFIDENCE / SIGNALS`. Anything unreadable leaves
  the rule-based reading in place, with a note. Model reasoning is never stored or shown, only
  structured signal codes.

## 5. Settings (`MoodDetectionSettings`, one row per project)

An absent row means "off, with the defaults".

- **Enable:** the master switch.
- **Sources:** text, emoji and stickers. At least one must be on while Mood Detection is enabled.
- **Ask AI about unclear messages.**
- **Sensitivity:** Low 90%, Balanced 80% (the default), High 65%, or Custom 50–99%.
- **Per mood:** whether it triggers; notify the team; alert the internal group; mention the
  responsible member (needs the internal alert); mark as needing attention; send a message to the
  customer; conversation (continue / pause AI / require human takeover); alert priority.
- **Cooldown:** 5, 15, 30 (the default) or 60 minutes, or custom (1–1440).
- **Hold AI back for:** how long "require human takeover" lasts if nobody replies. 1–168 hours,
  default 24.
- **When nobody is assigned:** mention members who opted in to Mood alerts (up to 3), or nobody.
- **Skip the customer message when nobody is assigned.**
- **Internal escalation group:** chosen with the group picker. Stored as WhatsApp group ids
  (`…@g.us`), like every alert destination.

The save is refused, with the reason, when a setting could do nothing:

- an internal alert is switched on with no group chosen;
- every source is off while Mood Detection is enabled.

An escalation group from another project is dropped. Every save is audited in System Logs (scope
`mood-detection`) with each changed field as `{ from, to }`, and policies per mood and field.
Switching the feature on or off is logged at WARN. Permissions are `settings.view` and
`settings.edit`, checked on the server.

**Per-account and per-group overrides are not built.** One project-wide row decides everything. The
readings and alerts already carry `accountId`, `groupId` and `whatsappGroupId`, so an override
table can be added without touching them.

## 6. Who is watched

- **Customers only.** A team member's message never triggers anything, whatever it says
  (`isFromTeamMember`).
- **Monitored groups only.** Direct messages are never read.
- **Never the internal escalation group:** its alert text reads exactly like anger.
- **Per customer, with a group aggregate.** `customerKey` is `Message.senderPhone`. The
  conversation's mood (`groupMood`) is the worst customer's latest mood, one step softer when they
  are the only unhappy one among three or more.
- **Two accounts in one group:** each account stores its own copy of a message. One reading per
  WhatsApp message is kept, from whichever copy arrived first. Trend and cooldown key on
  `whatsappGroupId`, not on a group row.

## 7. Alerts and cooldown

- **One alert per escalation.** The cooldown unit is (project, WhatsApp group, customer), under
  `pg_advisory_xact_lock`.
  - **No open alert:** a new `MoodAlert` is opened, with one `MoodAlertAction` per action the mood's
    policy switches on.
  - **Open alert at the same or a higher level:** the reading attaches to it (`triggerCount` + 1).
    Nothing is sent again.
  - **Open alert at a lower level (an escalation):** the alert takes the new mood and priority, and
    the cooldown restarts. The new policy's actions run again at the new level. The customer
    message is the exception: it is sent at most once per alert. The conversation action re-runs
    only when the new behaviour is stronger.
- **Idempotency:**
  - `CustomerMoodEvent.messageId` is UNIQUE, so replays, redeliveries and stranded-message re-runs
    add nothing.
  - `(alertId, action)` is UNIQUE.
  - The customer message's outbound idempotency key is the alert's first message plus the
    `mood-escalation` variant.
- **Retries:**
  - **Readings:** retried with backoff up to 3 times, then FAILED with the error and a System Log
    ERROR.
  - **Actions:** each one is retried independently, under the same rule.
  - **Stuck work:** rows left PROCESSING for more than 5 minutes are put back by the 5-minute
    stuck-work recovery.

## 8. Actions

| Action | What it does |
|---|---|
| CONVERSATION | Sets `WhatsAppGroup.aiSuppressedUntil` on **every account's copy** of the group. It only ever extends: PAUSE_AI lasts the cooldown, REQUIRE_HUMAN lasts `requireHumanHours`. This is the canonical handoff state used by human takeover, not a second pause. Rules keep running. When a team member replies, `recordHumanTakeover` sets the ordinary takeover window. |
| NEEDS_ATTENTION | Clears `chatReviewedAt` on every copy, so the conversation is back in WhatsApp Chat's **Waiting** list. That is this product's "needs attention" queue. The Messages page's "Needs attention" tab is the rule engine's SUPPORT_REQUIRED decision, which is not touched. |
| NOTIFY_TEAM | `enqueueNotification` with event `MOOD_ALERT`. Notification Center routing applies: its groups or the global groups through `NOTIFY_WHATSAPP`, Teams if configured, and personal DMs once per alert. |
| INTERNAL_ALERT | A WhatsApp alert to each chosen escalation group, through a connected account that is a member (Notification Center's sending account when it is one). When mentions are on, `payload.mentions` carries contact ids and the text carries `@digits`. `WhatsAppNotificationProvider` passes structured mentions to `sendMessage`. Members who fail `hasReachablePhoneNumber` are skipped. |
| CUSTOMER_MESSAGE | `checkAutoReplySafety` (kill switch, MANUAL_ONLY, monitored group, rate limits) then `enqueueOutboundMessage`, as AUTO_REPLY with the `mood-escalation` variant. It is sent from Primary's copy of the group when a Primary is set, and is skipped if Primary is not in the group (the pipeline's "only Primary answers" rule). Like the handover mention and holding reply, it is not an answer: the AI reply cooldown ignores it, both when queued and when sent. |

**Templates** (Notification Templates; defaults live in code):

- **Team alert:** `MOOD_ALERT`, with moodLabel, priority, confidence, groupName, clientName,
  customerMessage, reasons, trend, assignedTo, conversation and mentions.
- **Customer messages:** `MOOD_CUSTOMER_FRUSTRATED`, `_ANGRY`, `_VERY_ANGRY` and `_URGENT`, written
  in Bangla and English. Each card says whether it can currently send.

**Muting.** Muting "Customer upset" in Notification Center silences both the team alert and the
internal alert. The AI pause and the Waiting mark are not alerts, and still happen.

## 9. Immediate AI pause

The pipeline hook writes the reading and then evaluates the deterministic decision at once. When
it already triggers a mood whose policy pauses AI, the hook sets the pause. It also hands the new
`aiSuppressedUntil` to the AI fallback further down the same `runAutomationStageInProject`. Without
this, the AI could answer the angry message itself in the seconds before the processor reached it.

The AI eligibility reason now reads "AI replies are paused … (a team member is handling it, or
Mood Detection asked for a person)".

When an AI classification later downgrades a reading, a pause already set stays. This is the
conservative direction.

## 10. Where moods are shown

- **Settings page:** status, readings and triggered counts for 7 days, the most common mood, and
  the 25 most recent alerts. Each alert shows its detected reasons and what every action did, with
  details on hover.
- **WhatsApp Chat:**
  - **Conversation rows:** a badge with the group mood (concerned or worse).
  - **Thread header:** the group mood.
  - **Each customer message:** a chip with the mood and its reasons on hover.

  Every badge says "Detected mood" and gives the structured signals.
- **Response Time foundation:** `moodAtTime(readings, at)` in shared, and the
  `(whatsappGroupId, customerKey, messageAt)` index. "Mood at the time of the response" is one
  lookup per wait. It is not yet shown on the Response Time page.

## 11. Not done, deliberately

- **"Fully stop automated replies" (rules as well as AI).** There is no per-group rule pause in this
  product, and adding one would be a second pause mechanism beside `aiSuppressedUntil`. "Pause AI"
  and "Require human takeover" both leave rules running.
- **A project feature flag.** Mood Detection is a core setting under `settings.*`, like Message &
  Media Storage.
- **Catch-up messages older than 15 minutes** (`storeMissedMessage`) are not read for mood. An alert
  about an hour-old message is the backdated alarm the catch-up path refuses for escalation too.

## 12. Tests

- **Shared:** `mood.test.ts`, 44 tests covering:
  - ordinary support language staying neutral;
  - Bangla and Banglish;
  - emoji, stickers and sources;
  - mixed signals;
  - bursts and repeated complaints;
  - threshold and trigger switch;
  - trend and escalating pattern;
  - group aggregate;
  - AI parser failing closed;
  - `moodAtTime`.
- **Worker:** `moodDetection.integration.test.ts`, 24 tests covering:
  - the pre-filter, team member, disabled, unmonitored and internal group;
  - the immediate pause on both copies;
  - replay and twin dedupe;
  - sticker, and a sticker not breaking the trend;
  - one alert per escalation, cooldown attach and escalation re-alert;
  - new alert after the cooldown;
  - threshold and trigger;
  - AI only for ambiguous readings (no phone number in the prompt) and an unreadable AI answer;
  - event retries to FAILED and stuck recovery;
  - each action;
  - mute, mentions, the customer message once, the kill switch, the cooldown exclusion and the pause
    only extending;
  - the end-to-end pipeline (the AI fallback is not called for the paused message, and is called
    with Mood Detection off);
  - two-project isolation.

  Each protection was mutation-checked: 21 of 22 mutants fail the suite. The survivor removes the
  processor's own mute check, which `enqueueNotification` enforces anyway, so the behaviour is
  equivalent.
- **Web:** `moodDetection.integration.test.ts`, 6 tests covering:
  - the permission refusal;
  - the audit diff;
  - the validation refusals;
  - a foreign escalation group being dropped;
  - another project's settings staying untouched;
  - template status;
  - chat mood aggregation with project isolation (latest reading per customer; stickers ignored).

  All 7 mutants fail.
