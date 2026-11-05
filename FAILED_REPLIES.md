# Failed Replies

Messages → **Failed replies** (`/messages/failed-replies`). Lists customer replies that did not go out, shows what
happened, and lets a person retry, resolve or close each one, safely.

## What is listed
- **WhatsApp:** `OutboundMessage` rows with `actionType` AUTO_REPLY (rules, AI) or MANUAL_REPLY (WhatsApp Chat),
  status FAILED / RATE_LIMITED / SKIPPED, or any row a person has retried. Template test sends (`template-test:` key),
  broadcasts and alerts are excluded; they have their own views.
- **Other channels** (only with `OMNICHANNEL`): outbound `ChannelMessage` replies that are FAILED or UNKNOWN, or that
  were retried. A BUSINESS message (typed in Meta's own app) is excluded.

## State
Derived at read time, never stored (`failedReplyState`, packages/shared; `WA_STATE_SQL`/`CH_STATE_SQL` are its SQL
twin, and a test runs both over every combination):
- **Failed:** did not go out.
- **Retrying:** a person retried it and it is queued or sending.
- **Resolved:** a person marked it resolved, or a retry sent it.
- **Closed:** a person closed it, with a reason. It will not be sent.

## Delivery uncertainty (the rule everything respects)
A send whose call into the provider started and never answered may have reached the customer.
- `OutboundMessage.sendStartedAt` is stamped immediately before the call into WhatsApp Web.
- A send that **throws** (the provider sets `uncertain`, or the error escapes it) is settled FAILED with
  `deliveryUncertain`. It is never retried automatically.
- Crash recovery: a row stranded PROCESSING **with** the stamp becomes FAILED + uncertain. One **without** the stamp
  was never handed over, so it goes back to PENDING as before.
- A refusal the provider **returns** (not connected, quote missing) keeps the existing automatic retry budget.
- A channel reply's UNKNOWN status is the same fact.
- Broadcast "Retry failed" skips uncertain rows.

## Retry
Retry is always the same row and the same idempotency key, through a conditional update. The worker re-checks
the kill switch, rate limits and membership at send time. `decideFailedReplyRetry` refuses when:
- the reply is not Failed;
- it has used its 5 manual retries;
- the account belongs to another workspace, or is missing or not connected;
- it is an automatic reply and automation is paused;
- delivery is uncertain and the person has not confirmed they checked the chat;
- delivery is uncertain and an echo was seen: a message with the same text, from this number, in this chat,
  between 1 minute before and 15 minutes after the send began.

Bulk retry never includes an uncertain reply.

## Audit and permissions
- `FailedReplyAction` is append-only (trigger). It records the action, the status before, the redacted failure
  reason, the confirmation, the note, the actor id and the username at that moment, with no FK to User.
  Channel retries from the conversation composer are recorded there too.
- Reading needs `messages.view`. Acting needs `messages.reply` (WhatsApp) or `conversations.reply` + OMNICHANNEL
  (channels).
- Every read and write goes through the project-scoped client, and the raw list query names `"projectId"`.
- Failure text is redacted (`redactText`) when the worker stores it and again when it is shown.
