# Support response tracking — Unanswered Groups & Response Time

Two tabs under **Support → Messages**, beside All messages, Needs attention and Ignored:

- **Unanswered groups** (`/messages/unanswered`): groups where a customer has written and no Support
  Team member has replied since.
- **Response time** (`/messages/response-time`): every such wait that a Support Team member answered,
  with who answered and how long it took.

## Who counts as Support (decided with Rudra, 4 Oct 2026)

- **What the Support Team is.** The app had no "Support Team" concept. It has Teams (WhatsApp →
  Teams) with dated membership history (`TeamMembership`). The Support Team is therefore the Teams
  chosen under **Settings → Support Activity Setup → "Support Team for response tracking"**
  (`SupportActivitySettings.responseTrackingTeamIds`).
- **When nothing is chosen, nothing is tracked.** Both tabs say so, with a link to the setting.
- **What answers a customer.** Only a message sent from a Support Team member's **own WhatsApp**
  answers. The sender is identified the way the rest of the app identifies roster members
  (`resolveActiveTeamMember`: the exact WhatsApp id first, then the phone number compared as
  digits). The member must have been in a Support Team **at the moment of the reply**, as recorded
  in `TeamMembership`.
- **Never an answer:**
  - another Team's members;
  - the **business number**, whether a person typed on the business phone or sent from the
    dashboard Chat (WhatsApp does not say which person sent it);
  - rules and the AI.

  These messages stay visible in the chat. They only do not count here.
- **Who is a customer.** Anyone not on the roster. A roster member who is not in the Support Team
  neither opens nor answers a wait.

## The data: `SupportResponseEpisode`

One row per wait, per **group row**. Identity is account + group, never a group name, so the same
WhatsApp group under two accounts is two identities.

| | |
|---|---|
| Status | `UNANSWERED` → `ANSWERED` (Support replied) or `CLEARED` (dismissed) |
| References | `firstIncomingMessageId`, `latestIncomingMessageId`, `supportReplyMessageId` → `Message`. No message text is copied. |
| Times | `firstIncomingAt`, `latestIncomingAt`, `supportRepliedAt`. `responseSeconds = supportRepliedAt − firstIncomingAt`, stored, and recalculable from the two timestamps. |
| Who | `supportMemberId`, plus `supportTeamId`: the Team they were in when they replied |
| Clear | `clearedAt`, `clearedByUserId`, `clearReason` |

- **One open wait per group.** At most one UNANSWERED episode per group row: a partial unique index
  enforces it, and the worker also decides under a per-group advisory lock.
- **Integrity triggers:** Phase 7 `_same_project` triggers on all seven references, plus
  `projectId_immutable`.
- **Migration:** `20261006090000_support_response_episodes`. It is additive:
  - the new table;
  - one array column on `SupportActivitySettings`, empty by default.

  It needs approval before it is deployed to the live database.
- **Indexes:**
  - `(projectId, status, firstIncomingAt)`: the Unanswered list, longest wait first;
  - `(projectId, status, supportRepliedAt)`: the Response Time list;
  - `(groupId, status)`: the tracker;
  - `(supportMemberId, supportRepliedAt)`: future per-member reports;
  - `(accountId)`.

## How episodes are kept up to date (`apps/worker/src/supportResponse/tracker.ts`)

**When it runs.** `persistIncomingMessage` calls `trackSupportResponse` right after it inserts a
**new** message. That covers live messages, catch-up messages and recovered messages. The insert is
the dedup guard, so the tracker can never run twice for one message. It never throws: a tracking
failure is logged and the message continues through rules, AI and escalation unchanged.

**What each message does.** The rules are pure functions in `packages/shared/src/supportResponse.ts`
(`applyResponseMessage`):

- **Customer message, nothing open:** it opens an episode — unless it is older than the group's last
  Support reply, or older than a cleared episode's last message. Such a message was already answered
  or dismissed (it arrived late), so it opens nothing.
- **Customer message, episode open:** it extends that episode. The count goes up by one, and the
  first or latest message is updated if this one is earlier or later. One wait, however many lines.
- **Support reply, episode open:** it answers the episode, provided it was sent at or after the
  episode's first message.
- **Two Support replies moments apart, processed out of order:** the earlier reply replaces the
  recorded answer (`REANSWER`).
- **Anything else** changes nothing.

**Timing.** Arrival order never matters. Timestamps decide, because a message recovered after a gap
arrives late.

**Cost.** One settings read and, for roster members, one membership read, plus a short transaction.
It costs about 14 ms extra per incoming message (measured below), and nothing at all until a Support
Team is chosen.

**No backfill.** Tracking starts with the next message after a Support Team is chosen. Re-deriving
history automatically was explicitly ruled out. History is replayable later as a separate,
controlled operation, because the pure rules take messages one at a time.

## The tabs

- **Unanswered groups:**
  - **Columns:** group (links to the existing WhatsApp Chat thread), account, latest message and
    sender, first unanswered message, waiting time (computed as now − first, never stored), message
    count, status.
  - **Filters:** account, group, latest sender, waiting at least N minutes, minimum message count,
    date of the first message.
  - **Sorts:** longest waiting (the default), newest, most messages, account, group.
  - **Cleared chip:** shows dismissed waits with who cleared them, when and why.
  - **Inactive groups:** groups the account has left are not listed as open.
  - **Refresh:** every 15 seconds, so a Support reply takes a row off without a reload.
- **Clear:** per row, the selected rows, or all rows matching the filters.
  - **Confirmation:** a dialog, with an optional reason.
  - **Permission:** gated on `messages.reply`, the key of the people who answer customers. Read Only
    holds only `messages.view`.
  - **What changes:** it sets the episode to CLEARED and nothing else. No message, group, support
    activity or response record changes, and WhatsApp is not touched.
  - **What happens next:** the next customer message opens a new wait. It is not a blacklist.
  - **Audit:** every clear is written to the System Log.
- **Response time:**
  - **Columns:** customer wrote, Support replied, response time (colour-coded at 15 min and 1 h),
    replied by (with their Team), message count, open chat.
  - **Totals:** responses, average and slowest, for the current filters.
  - **Filters:** account, group, member, Team, reply date range, response at least / at most N
    minutes.
  - **Sorts:** newest, slowest, fastest, group.
- **Selection:** the same pattern as Groups.
  - Tick rows or the page, then "Select all N matching these filters". The server resolves those ids
    with the page's own `where`.
  - Page sizes are 50, 100, 250, 500 or 1,000.
- **Export** (`POST /p/<slug>/api/messages/support-response/export`):
  - **What:** the selected rows, or everything matching, as Excel or CSV.
  - **Built on the server** through the project-scoped client and the page's own filters, so a file
    never holds a row the page would not show.
  - **Dates** are real Excel date-times on the Dhaka clock. **Durations** are written as text and as
    seconds (and minutes for Response time).
  - **Formula-looking text** is neutralised.
  - **Size limit:** over 5,000 rows the export is refused with a message, never truncated silently.
  - **File names** carry date and time, so two exports in a day do not overwrite each other.

## Relation to existing reports

- **Unchanged reports:** the Team Report, Response SLA and First Response all count **any** reply —
  including the business number — as answering a customer. None of them changed.
- **The narrower question:** this feature asks how long the **Support Team** took, so its times can
  be longer. The Response time page's Help explains the difference.
- **Reuse:** the episode table is structured data that Team Performance, SLA or workload reports can
  read later; the `(supportMemberId, supportRepliedAt)` index is there for that.

## Permissions

| Action | Permission |
|---|---|
| View both tabs and export | `messages.view`. Export is checked on the server. |
| Clear | `messages.reply` |
| Choose the Support Team | `support_activity.manage`. Only this project's Teams are accepted. |

No new permission keys were added. Project isolation comes from the scoped client and the triggers.

## Known limits

- **A Support member whose WhatsApp is not mapped.** If the roster has no number or WhatsApp id for
  them, their replies look like a customer's. They extend the wait rather than answer it. Mapping
  the roster (Team Members) is the fix, as it is for every roster-based feature.
- **A connected account that belongs to a member.** If a member's own number is one of the connected
  accounts, that account's own sends are business-number messages and do not answer. Copies of the
  same messages seen by other accounts in the group do answer.
- **History.** Nothing before the Support Team was chosen is tracked; there is no backfill.

## Tests

| Suite | File | Tests | Covers |
|---|---|---|---|
| shared | `supportResponse.test.ts` | 14 | roles, one episode per wait, first-message timing, other team / business / AI never answer, late messages, cycles, out-of-order Support replies, formatting, Excel serials |
| worker | `supportResponse.integration.test.ts` | 16 | through the real pipeline: 1 and 20 messages, concurrent arrival, not configured, answer with who and how long, other team then Support, business number / AI, Support sending many, two cycles, near-simultaneous Support replies, late recovered message, Team change after a reply, unmapped sender, clear then new wait, same group on two accounts, another project |
| web | `supportResponse.integration.test.ts` | 16 | list order and inactive groups, every filter, every sort, paging total, project isolation, clear permission / records / messages kept / within filters, Clear all, Response time filters and stats, export selected / all / cross-tab / CSV / formula / permission, Support Team setting |

Each new test was confirmed to fail against code with its protection removed.

## Measured (throwaway test database, 4 Oct 2026)

Volume: 2,000 groups and 100,000 episodes.

| What | Median | p95 |
|---|---|---|
| Unanswered page (50 rows + total) | 10 ms | 76 ms |
| Response time page (50 rows + total + average/slowest) | 51 ms | 64 ms |
| Incoming message, tracking off | 38 ms | 54 ms |
| Incoming message, tracking on | 53 ms | 82 ms |

**Browser check: 20 of 20 scenarios passed.** It sent real messages through the real pipeline and
covered:

- one customer message; five messages making one row;
- a Support reply leaving the list without a reload, then appearing in Response time with the member
  and a 30-minute duration;
- a Billing reply leaving the group unanswered;
- Clear, with the chat history intact, the dismissal kept under Cleared, and the group coming back
  after a new message;
- Clear selected;
- Export selected, and "select all 1,198 matching" exported server-side;
- Response time export;
- the same group on two accounts;
- Open chat;
- Read Only having no Clear;
- the settings card;
- 390 px phone width.
