# Satisfaction surveys (CSAT)

Feature `CSAT_SURVEYS`, **off by default** in every project and in no plan. Needs `UNIFIED_INBOX_V3`, because a survey is
tied to a Resolved conversation. Every channel is also off until it is switched on under Settings → Satisfaction surveys.

Status: built and tested on an isolated database only. Not deployed, and not tried against a live WhatsApp number or Meta,
Telegram or website connection.

## How it works

1. **Recording (web).** `changeConversationStatus` to RESOLVED commits its `RESOLVE` event. Then `recordCsatSurveyForResolution`
   writes one PENDING `CsatSurvey`, unique on that event.
2. **Asking (worker, `csat/csatSurveys.ts`, every 5 s).** The loop decides per survey whether it may be asked now:
   - WhatsApp personal chat: `enqueueOutboundMessage` with the `csat-survey` variant.
   - Messenger, Instagram, Telegram: a QUEUED `ChannelMessage` keyed `csat:<survey id>`.
   - Website chat: a card the widget shows. Nothing is sent.
3. **Reading.**
   - Text channels: the customer's next message within 24 hours is read once (`parseCsatRating`). A rating is recorded as the
     answer. Anything else closes the survey unanswered.
   - Website chat: `POST /api/webchat/<key>/csat` with the visitor's token.
4. **Report.** Reports → Customer Satisfaction (`support_activity.view`): CSAT (4–5 of the answered), response rate and
   average, per agent and channel. A comment is shown only to a viewer with `messages.view`.

## Rules worth not undoing

- **One survey per resolution.** The unique key is the RESOLVE event, so a replay records nothing. A reopen followed by a new
  resolve is a new resolution, and the worker's cooldown decides whether it is asked.
- **Never in a group.** WhatsApp groups are refused in code and by a database CHECK. Channel group threads are refused in code.
- **Never to a team member or one of our own numbers.**
- **The robot stops for the kill switch and MANUAL_ONLY on every channel, the website card included.** `dispatchOne` is the only
  gate for the channels and the card, so it must stay there. A test covers each path.
- **Nothing is retried or sent late.** A refusal is SKIPPED with its reason. A survey not asked within 30 minutes of the
  resolution is skipped. A conversation reopened first is skipped.
- **The cooldown is checked under a per-customer advisory lock**, in Postgres, because two workers share no memory.
- **Channels use the automated reply window only, never the HUMAN_AGENT tag.** The row is `senderType: "AI"`, so the send queue
  re-checks the kill switch and window at send time.
- **A survey is not an AI answer.** The AI reply cooldown ignores its variant at queue and send time.
- **The message that carries a rating stays an ordinary message.** It is stored, runs rules and AI, and follows the reopen
  policy (see the open decision below). The hooks only write the survey row, and they never throw.
- **The parser is strict.** A message counts only when it is nothing but a rating, so "5 days and still no internet" is not a five.
- **An answer is final.** A database trigger refuses any change to an answered survey, for Prisma and raw SQL alike.
- **The website API fails closed.** It needs a listed origin and the visitor's token, reaches only that visitor's conversation on
  that widget, and accepts one answer. Another visitor's survey, an expired one and a feature that is off all give 404.
- **Question text is plain text in the widget**, never HTML. Null means the built-in Bangla/English question, so clearing the
  field goes back to it.
- `CsatSurvey` and `CsatSettings` are in `PROJECT_SCOPED_MODELS`. Without that, one project's worker pass reads another's surveys.

## Open decision

A customer who answers "5" also reopens a Resolved conversation when the project's reopen policy says so, and the AI may see the
"5". This follows the build brief ("the rating message is still stored and processed normally"). Having a recorded rating skip
the reopen would be a small change, but it is the owner's call.
