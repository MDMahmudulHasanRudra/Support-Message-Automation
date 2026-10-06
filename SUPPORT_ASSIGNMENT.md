# Support Assignment

Status: built on `rudra`, not deployed. Migrations `20261011090300_support_assignment_event` and
`20261011090400_support_assignment` are not applied to any live database.

Sidebar: **Support → Support Assignment**, with four tabs:
- Unanswered (All, Unassigned, Assigned, Overdue)
- My assignments
- Completed
- Report

Settings live under **Settings → Support → Support Assignment**. The report is also listed under
**Reports → All Reports**.

## 1. What it is

A customer is waiting in a group. Somebody is asked to answer them, by a deadline, and the system
watches whether they do:

```
customer message ─► qualification ─► UNASSIGNED ─► assign ─► ASSIGNED ─► assignee replies ─► COMPLETED
                         │                                      │
                         └─► IGNORED (kept, counted)            └─ SLA passes ─► OVERDUE ─► (escalation)
```

It is a layer on the existing support-response tracking (`SUPPORT_RESPONSE.md`), not a second
definition of "unanswered". **A case is a `SupportResponseEpisode`**, the wait that Messages →
Unanswered groups lists, plus:
- who was asked to answer it;
- by when;
- whether they did.

**Consequence: nothing is tracked until a Support Team is chosen** (Settings → Support Activity
Setup). Both the module's pages and its settings say so.

## 2. Decisions (with Rudra, 7 Oct 2026)

| Question | Decision |
|---|---|
| My assignments: which person is "me"? | A new nullable link `InternalTeamMember.userId`, set on Team Members → edit → **Dashboard login**. It grants nothing and changes no matching. |
| The assignee is Hasan, but Borhan answers the customer | The case closes as **ANSWERED_BY_OTHER**. It is not credited to Hasan, and no overdue or escalation alert is sent about a customer who has been answered. |
| "Ignored team members" | Team members never open a wait (existing rule), so that list would do nothing. Instead there is an **Ignored senders** list: customers picked from recent group senders, or typed. |
| Admin's personal WhatsApp | Chosen from Team Members, like the escalation admin. Only people with a real phone number can be messaged. |

## 3. Qualification: ignore rules only exclude

`qualifyCustomerMessage` in `packages/shared/src/supportAssignment.ts` decides each customer message.

- **Ignored sender:** the message is not a case. Numbers are compared as digits; a WhatsApp id is
  compared exactly.
- **Only ignored words:** the message is not a case. Two rules decide this:
  - Every word must belong to an ignored phrase, or be an address word (bhai, vai, sir, apu, ভাই,
    স্যার…).
  - At least one ignored phrase must be present.
  - Matching is by whole word and in order. "ok" never touches "book" or "okhla". Bengali stays
    whole because combining marks belong to the word. So "Thank you ভাই" and "ok brother" are
    filtered, while "ok but the net is still down" is a case.
- **No words at all** (an emoji, a sticker) is not a case. An attachment without a caption **is**
  a case, because a photo of a router's lights is a support request.
- **Anything else is a case, whatever it says.** There is no support-keyword list. A customer never
  has to use a listed word to be heard.

**Filtered messages are not lost.** The `Message` row is untouched. A wait whose messages were all
filtered is kept as an **IGNORED** case, with `ignoredMessageCount`. It is listed under Completed →
Ignored and counted on the Unanswered page ("N filtered out today") and in the report. A real
message in the same wait turns it into UNASSIGNED (event QUALIFIED).

## 4. The data

| Table | What |
|---|---|
| `SupportAssignment` | One case. It references the episode, group, first support message, assignee, responder and completion message. It copies no text. |
| `SupportAssignmentEvent` | Append-only history: OPENED, IGNORED, QUALIFIED, ASSIGNED, REASSIGNED, NOTIFIED, NOTIFY_SKIPPED, OVERDUE, ESCALATED, COMPLETED, ANSWERED_BY_OTHER, CANCELLED. `notificationId` links each WhatsApp notification, so the detail page shows Delivered, Failed or Retrying. |
| `SupportAssignmentSettings` | Per-project singleton. Absent means off, with the defaults. |
| `InternalTeamMember.userId` | Links a member to their login, for My assignments. Unique per project; set to null if the login is removed. |

- **One current case per WhatsApp group.** A case is current while `closedAt IS NULL`. A partial
  unique index on `(projectId, whatsappGroupId)` enforces this, and the worker decides under a
  per-group advisory lock.
- **Why per WhatsApp group, not per account's group row.** When two of our numbers are in one
  group, both store the customer's message and both open an episode. Two cases for one question
  would mean one is assigned while its twin sits "unassigned" forever.
- **A case can outlive the wait that opened it.** For example, the assignee's bare "ok" answers the
  wait for the tracker but is not support. The case stays current, and a further customer message
  joins it. Once a case closes, the next customer message opens a new case; a message older than
  the closing reply opens nothing.
- **Integrity:** Phase 7 `_same_project` triggers on all ten references, and `projectId_immutable`
  on all three tables.

## 5. Statuses

| Status | Meaning |
|---|---|
| IGNORED | Every message in the wait was filtered out. Closed when the wait is answered or cleared. |
| UNASSIGNED | A genuine wait nobody has been given yet. |
| ASSIGNED | Given to one person, inside its SLA. |
| OVERDUE | Given to one person, past its SLA, and no reply from them. |
| COMPLETED | The assignee replied in the group after being assigned. |
| ANSWERED_BY_OTHER | Somebody else answered the customer, or answered before anybody was assigned. Not credited to the assignee. |
| CANCELLED | An admin cancelled it, or the wait was cleared on Messages → Unanswered groups. |

## 6. Completion: `decideReply`

A team member's message in the group is checked against the group's current case. The member is
recognised exactly as everywhere else (`resolveActiveTeamMember`). The rules:

- **COMPLETE:** sent by the **assignee**, at or after the assignment, with more than ignored words.
  - A message sent before the assignment never completes the case, including one recovered late.
  - An assignee outside the Support Team still completes. Matching is by person, not by Team.
- **ANSWERED_BY_OTHER:** the message is the Support reply that answered the customer's wait, and
  it was not sent by the assignee after assignment. This covers both another member answering and
  an unassigned case answered by the team.
- **Nothing happens** when the assignee's bare "ok" answers the wait, or when somebody's message
  does not answer the wait (for example, they are not in the Support Team).

The business number, the dashboard chat, rules and AI never complete or answer a case. This matches
SUPPORT_RESPONSE.md, because WhatsApp does not say which person sent a business-number message.

## 7. SLA, overdue, escalation (`apps/worker/src/supportAssignment/processor.ts`, every 15 s)

- **Deadline:** `dueAt = assignedAt + slaMinutes`. The SLA in force at assignment is snapshotted, so
  a settings change never moves a running deadline.
- **Overdue:** marked once `dueAt` plus **one minute of grace** has passed, so a reply sent just
  before the deadline has time to arrive. This queues the overdue notifications.
- **Escalation:** optional, once per assignment, `escalationAfterMinutes` after going overdue. The
  timer is set only if escalation was on when the case went overdue, so switching escalation on
  later never fires a burst for old cases.
- **Every transition is a conditional update** on the state it was decided from (status +
  `assignmentRound` + `closedAt IS NULL`). The history line and the notifications are written in
  the **same transaction**. Consequences:
  - A completion racing an overdue mark is settled by the row lock: whichever commits first wins,
    and the other matches nothing.
  - A case completed before its escalation time can never escalate.
  - A retry or a restart never alerts twice.
- **Late replies:** a reply sent before the deadline but processed after the overdue mark still
  completes the case and counts as **on time**. Timestamps decide, not arrival order.
- **Safety net:** the loop also settles open cases whose wait has been answered or cleared for two
  minutes, using the episode's own record of who replied and the same `decideReply`. This covers
  the pipeline hook failing or the worker restarting mid-message.

## 8. Notifications

All notifications go through the ordinary `Notification` queue, so the dispatcher sends them.
`queueSupportAssignmentNotices` and `buildSupportAssignmentNotices` in `packages/db` are shared by
the web (assign, reassign) and the worker (overdue, escalation, completion).

| Kind | To | Switch |
|---|---|---|
| ASSIGNED | the assignee (direct message) | notifyEmployeeOnAssign |
| REASSIGNED | the new assignee | notifyEmployeeOnReassign |
| OVERDUE | manager group(s) and/or admins | notifyManagerOnOverdue / notifyAdminOnOverdue |
| ESCALATED | admins; with no admin chosen, the manager group(s) | escalationEnabled + notifyAdminOnEscalation |
| COMPLETED | admins | notifyAdminOnCompletion |

- **Manager group(s):** the module's own list. If it is empty, they inherit the Notification
  Center's groups for Support Assignment, then the global notification groups.
- **Opted-in members:** members who opted into Support Assignment alerts on their Team Members page
  also get OVERDUE and ESCALATED.
- **At most once:** each notification has a dedup key (assignment round + kind + recipient),
  checked before writing. `(assignmentId, dedupKey)` UNIQUE is the last guard. A reassignment is a
  new round, so it alerts its new owner.
- **Muting:** muting `SUPPORT_ASSIGNMENT` in the Notification Center (or its WhatsApp channel)
  stops all of them.
- **Nothing that can be skipped fails the assignment.** A notification that cannot be queued is
  recorded as NOTIFY_SKIPPED with the reason. Reasons include:
  - muted;
  - the person has only a WhatsApp id (`hasReachablePhoneNumber`);
  - no connected account is in the manager group;
  - no Primary/routed account.
- **Sending account:** direct messages go from the NOTIFY_WHATSAPP account (Primary by default). A
  group message goes from a connected account that is in that group, preferring the NOTIFY_WHATSAPP
  account.
- **Wording:** five entries in the Notification Templates catalogue (`SUPPORT_ASSIGNMENT_*`),
  editable and test-sendable there. Variables: employeeName, employeeId (the linked login's employee
  code), groupName, customerName, message, assignedTime, dueTime, overdueBy, completedTime,
  responseTime, previousEmployee, status. Times are on the Dhaka clock ("10:25 PM, 6 Oct").

## 9. Pages and permissions

| Key | Gives |
|---|---|
| `support_assignment.view` | Every page, the report and its export. Read Only gets it automatically (every `.view` key). |
| `support_assignment.assign` | Assign, reassign (asked explicitly in the dialog), cancel. |
| `support_assignment.manage` | Settings. |

- **Project feature:** `SUPPORT_ASSIGNMENT` (on by default), with routes `/support-assignment` and
  `/api/support-assignment`. Off, the worker opens and completes nothing.
- **Roles:** no existing role changed. Administrator gets the keys through the seed; give the
  others as needed.
- **Assign dialog:**
  - A searchable list of assignable members, showing each person's current open load and whether
    they can be messaged.
  - A confirmation step ("You are about to assign 4 support cases to Hasan").
  - For a selection that includes assigned cases, an explicit "also move the cases that already
    belong to someone".
- **Assignable:** ACTIVE team members, narrowed to the chosen Teams when the settings name any.
- **Report:** the same page from both entry points.
  - **Period:** cases are selected by when they opened.
  - **Contents:** summary tiles, Employee performance, Group performance and the case list.
  - **Excel export:** Summary, Employees, Groups and Cases sheets. CSV holds the case list.
  - **One counting function:** all counting is `computeSupportAssignmentReport` (shared, unit-tested).
  - **Per employee:** Assigned and Overdue come from the history, so a reassignment never moves
    someone's overdue onto the next person.
  - **SLA compliance:** completed on time out of every assigned case whose outcome is known. "—",
    never 0%, when nothing was measured.

## 10. Switching it on

Saving the settings with **Enable** switched on brings in the customers already waiting:
- one case per WhatsApp group (the earliest open wait across our accounts);
- qualified on the wait's first and latest messages, which are the only ones a wait records.

Saving again changes nothing, because a group with a current case is skipped. Every settings save is
written to the System Log.

## 11. Tests

| Suite | Tests | Covers |
|---|---|---|
| shared `supportAssignment.test.ts` | 43 | qualification (support / not support, whole words, phrases, Bengali, emoji vs attachment, senders), `decideReply`, SLA outcome, overdue-by-timestamp, report counting, templates valid, Dhaka formatting, dedup keys |
| worker `supportAssignment.integration.test.ts` | 29 | through the real pipeline and SLA tick: module off, case per wait, Thank-you then real question, no false keyword match, ignored sender, team members, two accounts one case, redelivery, assignment message, completion + admin notice, wrong employee, reply before assignment, non-Support assignee, bare ok, unassigned answered, closed then new, overdue once with grace, escalation once and never after completion, late reply on time, reassign with history, no-phone and muted notices, safety net, cleared wait, project isolation, late message after a case closed on an open wait, stale-snapshot overdue / escalation / reassignment, the same notices queued twice |
| web `supportAssignment.integration.test.ts` | 16 | permissions, cancel never touching a finished case, module off, assign with deadline and notice, inactive / not-assignable member, two managers racing, reassign only when asked, bulk, LID-only member, cancel, another project's case, every list view, settings validation and clamping, switch-on import once, report = Excel = CSV, export permission, login link |

Each protection was confirmed to fail its tests when removed: 23 mutants, 21 killed.
- **The first run left six alive.** Each led to a new test, and one led to a real fix: cancel had
  written a "Cancelled" history line for a case that finished at the same moment.
- **The two still alive only widen the SLA loop's selection.** They are harmless, because the
  guarded update behind it (tested on its own, with a stale snapshot) still refuses the transition.

## 12. Known limits

- **A member who is not mapped** (no phone number or WhatsApp id on Team Members) is a customer to
  this module, exactly as in SUPPORT_RESPONSE.md.
- **Replies from the business number** (the business phone, the dashboard chat) never complete a
  case.
- **One escalation tier.** A second tier would be one more level on the same loop.
- **The switch-on import** qualifies a wait on its first and latest messages only. A wait whose
  middle messages were the only real ones is imported as IGNORED, and turns into a case on the
  customer's next message.
