# Project Reference

This is the exhaustive, page-by-page functional reference for Softify Assist — every
sidebar module, every page, every field, every button, and what it actually does. If you want the
*design* rationale (why the system is shaped this way) read `ARCHITECTURE.md`; if you're an AI
agent working on the code read `CLAUDE.md`; if you just want to run the thing read `README.md`.
This document is about *what the product does today*, module by module, in the order it appears in
the sidebar.

Keep this file up to date: whenever a page's fields, buttons, or behavior change, update the
matching section here in the same change.

---

## Contents

1. [System at a glance](#system-at-a-glance)
2. [Overview (Dashboard)](#overview-dashboard)
3. [Messages](#messages)
4. [Escalations](#escalations)
5. [Support Activity](#support-activity)
6. [Teams Integration](#teams-integration)
7. [WhatsApp](#whatsapp)
8. [Automation](#automation)
9. [Bulk Messaging](#bulk-messaging)
10. [AI Learning](#ai-learning)
11. [Conversation Learning](#conversation-learning)
12. [System](#system)
13. [Users & Permissions](#users--permissions)
14. [AI Admin Assistant (floating chat)](#ai-admin-assistant-floating-chat)
15. [Background jobs (apps/worker)](#background-jobs-appsworker)
16. [Safety & anti-spam features, end to end](#safety--anti-spam-features-end-to-end)

---

## System at a glance

Two long-running processes plus Postgres:

- **apps/web** (Next.js dashboard) — everything a human clicks. Reads/writes the database directly;
  never talks to the worker over HTTP.
- **apps/worker** — the only process that owns the actual WhatsApp (OpenWA) connection(s), the
  message pipeline, the outbound send queue, and every scheduled background job.
- **Postgres** — the only channel between them. The dashboard writes `WorkerCommand` rows for
  anything that needs the live browser session (reconnect, fetch QR, resync groups, logout); the
  worker writes live connection state back onto `WhatsAppAccount` for the dashboard to poll.

Access is governed by **Permission Modules** — a named set of permissions assigned to a user (see
[Users & Permissions](#users--permissions)). A user with no module assigned has full access, which
is what keeps a single-admin deployment working without configuring anything.

---

## Overview (Dashboard)

**Route**: `/overview` (pinned above all sidebar groups, labeled "Overview")

The landing page after login — a glanceable, entirely read-only command center. Nothing here sends
or changes anything; every number links to the real page where you'd act on it.

- **8 KPI stat tiles**: Connected accounts, Incoming messages (24h), Support required (24h), Active
  rules, Outbound queue (pending), Failed notifications (24h), Open escalation cases, Unresolved
  unknown patterns.
- **10 module cards** (one per feature area, each with 2–4 live numbers and a "View module →" link):
  Accounts & Routing, Automation Rules & Outbound, Priority Support Escalation, Conversation
  Learning, AI Learning, Bulk Messaging, Notifications, Support Activity, **Teams Integration**,
  System Logs.
- **Message Activity card**: a 7-day inline-SVG trend line (`Sparkline`) of incoming message
  volume, plus the last 10 messages across every account.
- A warning banner appears if any WhatsApp account isn't connected.

---

## Messages

Sidebar group: **Messages**

- **WhatsApp Chat** (`/chat`) — a WhatsApp-Web-style two-pane inbox: a searchable conversation list
  (rendered at layout level, so it keeps scroll position and search across navigations) plus the
  thread and a composer. It reads only what this app already stores, so a thread goes back to
  whenever monitoring began — it never asks the worker for history. Sending writes one
  `OutboundMessage` with `actionType: MANUAL_REPLY` and stops there; the worker sends it.
  `MANUAL_REPLY` is the one action type the queue treats differently: **the automation kill switch
  does not cancel it** (the switch stops the robot, not the operator) and a rate limit **defers**
  rather than discards it, since silently dropping something a person typed is not acceptable. It
  still gets the same live group-membership check the broadcast path does. Unconfirmed sends render
  as dashed "queued" bubbles; a `SENT` row whose provider message id already exists as a stored
  message is skipped as a duplicate, because WhatsApp echoes our own sends back to us. Polls every
  4s — there is no websocket.
- **All Messages** (`/messages`) — every processed message, filterable by Account, Group (name
  contains), Sender (phone/name contains), From/To date, Decision (`IGNORE`, `AUTO_REPLY`,
  `SUPPORT_REQUIRED`, `STOPPED`, `ACTIONED`, `NO_MATCH`), matched Rule, Auto-Reply status
  (`PENDING`/`PROCESSING`/`SENT`/`FAILED`/`CANCELLED`/`RATE_LIMITED`/`SKIPPED`), Notification status
  (`PENDING`/`SENT`/`FAILED`/`RETRYING`). Table: Time, Account, Group, Sender (+ "Team" badge for
  internal team members), Direction, Message (truncated, full text on hover), processing Status,
  Rule Matched, Decision, Auto-Reply badge, Notification badge(s), View link.
- **Needs Attention** (`/messages?decision=SUPPORT_REQUIRED`) — a redirect/filtered view of the
  same page, not a separate implementation.
- **Ignored Messages** (`/messages?decision=IGNORE`) — same, filtered to `IGNORE`.
- The message-text search is AND-ed with the sender filter rather than folded into the same OR:
  "this sender **or** anyone who mentioned this word" is never what is meant.
- **Message detail** (`/messages/[id]`) — the full record: message body/metadata, the complete rule
  evaluation trace (every rule considered, matched/applied/reason, applied ones highlighted),
  actions executed, every outbound reply's status/body/attempts, every notification's
  status/destination/attempts.

---

## Escalations

Sidebar group: **Escalations** (renamed from "Priority Support" — the tier names, `Priority` rule
field, and `WhatsAppServiceKey.PRIORITY_SUPPORT` enum are unchanged; only the display label moved)

### Active Cases — `/support-escalation`

A live worklist, not a stats hub. Stat tiles: Waiting for first response, Escalated, Paused,
Resolved today. Table (oldest-waiting first): Group, Priority (P1/P2/P3), Status, Waiting Since,
Escalation Level, Assigned, View. Only lists currently-active cases (terminal ones drop off but
stay viewable via their own case page).

**How a case opens**: only groups tagged P1/P2/P3 (on the Groups page) are monitored at all — fully
opt-in. A case opens the moment a non-team-member messages a monitored group's chat with no case
already open for it; a further message before anyone replies extends the existing case rather than
duplicating it.

**Status meanings**: `NEW`/`MONITORING` — just opened. `WAITING_FOR_HUMAN` — first alert sent.
`SECOND_ALERT` — re-alert nudge sent. `MEMBER_ESCALATED` — assigned team member DM'd.
`ADMIN_ESCALATED` — escalation admin DM'd. `FOLLOW_UP` — repeating follow-up DMs to the admin. A
real human reply in the chat immediately ends the chain.

### Case detail — `/support-escalation/cases/[id]`

Auto-refreshes every 5s while active. Shows priority, status, client, assigned member, escalation
level (current/max), waiting-since, human-replied-at, resolved-by, and the original trigger
message. Manual controls (hidden once terminal):

| Button | Effect |
|---|---|
| Pause / Resume | Freezes/unfreezes the SLA timers |
| Escalate Immediately | Forces the next tier to fire now instead of waiting out its timer |
| Reassign (dropdown, fires on change) | Changes who gets the member-tier DM, even mid-case |
| Reset | Puts the case back to the start, keeping history |
| Stop Escalation | Ends tracking without claiming a human replied |
| Mark Resolved | Closes the case for good |

Below that: a full timeline of every escalation event with delivery status.

### Policies — `/support-escalation/policies`

Per-tier (P1/P2/P3) forms, each independently saved: First alert (min), Second alert (min), Member
escalation (min), Admin escalation (min), Follow-up interval (min), Max escalations. Defaults —
P1: 0/5/10/15/15/10, P2: 5/10/20/30/30/6, P3: 15/30/60/120/120/3. Policy edits are **not
retroactive** — each case snapshots its policy at open time. A top-of-page settings card holds the
global "Priority escalation enabled" master switch (pauses all active cases without cancelling
them) and the org-wide Escalation Admin picker (one person, receives every admin-tier DM/follow-up).

---

## Support Activity

Sidebar group: **Support Activity**

Automatically detects when a configured support team member's message inside a WhatsApp group
satisfies a configured rule, and turns that into countable, reportable activity — entirely separate
from the rule engine's automated replies. Off by default.

The sidebar carries **four** entries, not six: Rules and Keywords were two more lines for the same
job as Settings — deciding what counts — so **Setup** hosts them, with their routes unchanged.
Team Performance leads, because it is the question the module gets opened to answer.

### Team Performance — `/support-activity/team`

The headline page. Stat tiles: Executives active, Groups covered, Messages sent (by people, not
AI), Time engaged. Then one row per executive, busiest first: Groups, Messages, **Time engaged**,
First, Last (both in Asia/Dhaka), and a *today / week / month* group count in the final column —
the whole point of the page in one cell, since whether a load is a spike or a person's normal is
the actual question. A green dot marks anyone active in the last few minutes. Below it, a "Who is
around" panel: green = active in the last few minutes, amber = worked today, grey = not yet.

**How time is measured, and why it is not "hours worked":** each row is the span from a person's
first message to their last **within one group on one Dhaka calendar day**, summed across every
such span. Per group *and* per day deliberately — one span across a week would count the nights in
between; one span across every group at once would count the time they were busy elsewhere. **A day
with one message shows zero**, which is honest rather than flattering: a single reply is a moment,
not a span, and the message count beside it is what says they were working. This reads the activity
rows directly, so it does not depend on a support session ever closing — the previous hours-worked
figure summed session durations, which are only written when a session *completes*, which needs a
completion keyword; a deployment using the "any message counts" rule has none, so that number was
permanently empty while looking perfectly healthy.

### Activity Feed — `/support-activity`

Stat tiles (labeled "Today's"/"This Week's"/"This Month's ..." depending on the configured
counting period): Support Groups, Support Activities, Active Support Members, Total Supported
Groups (all-time), Repeated Support Activities (activities minus unique groups — a positive number
means at least one group got hit more than once). A 30-day trend Sparkline. A Recent Activity table
(last 10, across every group) with **Export CSV** / **Export Excel** links. Rows are labelled by
**actor** — a person or the AI — and every person-measuring number on this module filters to
`TEAM_MEMBER` explicitly, so AI work can never inflate someone's figures. The split, including
"groups no human touched", is reported separately.

### Reports — `/support-activity/reports`

Pick a group (and optionally a custom From/To date range, overriding the default period) to see its
detection timeline plus the "Counted Support" vs. "Activities" distinction for that one group (in
`UNIQUE_GROUP` terms: 1 if anything happened, 0 if not). Export CSV/Excel scoped to that group+range.
Also answers "what is happening right now" without picking a group first: open sessions sorted so
the most actionable (stale, then other open, then most recently started) surface first.

### Setup — `/support-activity/settings`

Master **Enable Support Activity Tracking** switch (default off — no existing automation is
affected either way). **Counting Mode**: `Unique Group` (each group counts once per period),
`Every Activity` (every match counts), `Per Team Member` (totals per member — confirmed semantics:
two activities by the same member in the *same* group still count as 2, not 1). **Counting
Period**: `Daily`, `Weekly` (Sunday-start), `Monthly`. Counting is always computed live against the
raw activity table, never pre-aggregated, so changing a setting retroactively reinterprets history.
Hosts the two pages below.

#### Rules — `/support-activity/rules` (+ `/new`, `/[id]/edit`)

Each rule combines: **Trigger Type** (`Keyword Match`, `Reply to Customer`, `Mention`, `Any
Message`), **Keywords** (multi-select, only for Keyword Match), **Team Member Scope** (all, or a
specific multi-select), **Group Scope** (all, or a specific multi-select), Active/Disabled. The
first active rule (and, for Keyword Match, its first matching keyword) that applies wins — at most
one Support Activity per message. `Any Message` is evaluated **last**, because it matches everything
and would otherwise shadow a keyword rule — and only a keyword rule can mark a session complete, so
an "any message" rule would quietly stop sessions ever completing. Row actions: Edit,
Disable/Enable, Delete.

`Reaction` is deliberately **not** offered: OpenWA's reaction subscription is behind an Insiders
licence this deployment does not have, so the trigger would appear configured in the UI and never
fire once.

#### Keywords — `/support-activity/keywords`

Simple CRUD: Value, Match Mode (Contains/Exact), Case Sensitive toggle, Active/Disabled. Contains
matches at a whole-word boundary; case-insensitive is the default.

---

## Teams Integration

Sidebar group: **Teams Integration** — links a developer's Microsoft Teams conversation to an open
customer WhatsApp conversation, so a resolution keyword in a linked Teams thread can notify the
customer automatically. Requires a one-time Microsoft OAuth connection (real Azure App
Registration credentials — see `TEAMS_SETUP.md`); every page here works but shows a clear
"not configured"/"not connected" state until that's done.

### Issues — `/issues` (+ `/new`, `/[id]`)

An Issue links a WhatsApp group + customer phone number to a Teams channel (and optionally an
exact thread). Created manually (**not** auto-detected from message content) via **Create Issue**:
pick a WhatsApp group, enter the customer's phone number, an optional title, and optionally a
Teams channel + thread ID (linkable later instead, on the detail page). List page: Issue, Customer,
WhatsApp Group, Teams Channel, Status (`OPEN`/`IN_PROGRESS`/`WAITING_DEVELOPER`/
`RESOLUTION_DETECTED`/`WAITING_CUSTOMER_CHECK`/`RESOLVED`/`CLOSED`), Created. Detail page: full
details, a Teams Link form (save/change the channel+thread at any time), manual status actions
(**Mark Resolved**, **Reopen**, **Close**), and a Resolution Events table (every Teams message
evaluated against this issue, its matched keyword, and outcome) with an **Ignore** action on a
`NOTIFIED` row (record-keeping only — cannot un-send an already-sent notification).

### Connection — `/integrations/teams`

**One-click connection**: clicking **Connect Microsoft Teams** redirects straight to Microsoft's
own login page — the dashboard never asks for a Microsoft email/password, Client ID, Tenant ID, or
any other technical detail. After signing in and approving the requested permissions on Microsoft's
own consent screen, you're returned here already connected; discovery and the first sync start
automatically (queued the moment the connection succeeds, not on the next scheduled poll).

The connection card shows one of five states: **Not connected** (Connect button), **Connected**
(steady state), **Synchronizing…** (a sync pass is actively running — shown as an indeterminate
state, never a fabricated percentage), **Needs attention** (a sync/refresh failure worth a look —
retried automatically), or **Reconnect needed** (Microsoft itself revoked or expired the
authorization — the only state where a customer must click through OAuth again). When connected:
account email/name, live Teams/Channels/Messages-synced counts, last sync time, **Sync Now**
(runs a pass immediately), a link to **Manage Teams & Channels**, and **Disconnect** (with a
confirmation dialog — clears stored tokens but keeps all synced history and Issues intact). A
summary card shows Open Issues / Resolved Today with quick links to Issues, Resolution Rules, and
Resolution Keywords.

### Manage Teams & Channels — `/integrations/teams/manage`

Every Team and channel the connected account can see is discovered automatically and enabled for
automation by default — no setup wizard, no Team/Channel IDs to enter. This page lets an admin
optionally narrow that down: one card per Team with an "Used for automation" toggle, and a toggle
per channel underneath it. Turning a Team or channel off stops its messages from being synced for
general automation purposes — an Issue explicitly linked to a specific channel is always synced
regardless of this setting, so linking a channel to an Issue can never be silently defeated by this
coarser toggle.

### Resolution Rules — `/integrations/teams/rules` (+ `/new`, `/[id]/edit`)

Each rule: Name, Description (optional), Keywords (multi-select). Any one matching keyword in a
developer's Teams message fires the rule. Row actions: Edit, Disable/Enable, Delete.

### Resolution Keywords — `/integrations/teams/keywords`

Simple CRUD, identical shape to Support Activity's own Keywords page: Value, Match Mode
(Contains/Exact), Case Sensitive toggle, Active/Disabled — reuses the exact same matcher.

### Settings — `/integrations/teams/settings`

**Enable resolution detection** (master switch for evaluating Teams messages at all). **Notify the
customer automatically** — **off by default**; an admin must explicitly opt in before this system
ever sends a WhatsApp message to a real customer based on Teams-side activity alone — plus a
Notification Message Template (`{{customerName}}`/`{{issueId}}`/`{{executiveName}}` placeholders).
**Polling Interval (minutes)** — how often the worker checks Microsoft Graph for new messages in
linked channels.

### Export

`/api/teams/export` returns either the Issues (with their resolution timing) or the synced channel
messages, as CSV or xlsx. Issue rows carry **minutes** to resolve, not seconds: these are
conversations between people over hours or days, and second-level precision would imply an accuracy
that polling every few minutes cannot have.

**Not built, deliberately.** *Real-time webhooks* are blocked by topology rather than effort —
Microsoft Graph change notifications need a publicly reachable HTTPS endpoint to deliver to, and
this runs behind Docker on a private port, so the subscription code would register and never
receive, which is worse than nothing because it looks finished. *Session and duration analytics*
have nothing to compute from yet (no connected account, no synced messages); numbers derived from
an empty table are a page of zeroes that implies a working integration. The export above is what
makes it analysable the day someone connects it.

### Team Performance addition

The existing **Team Performance** page (`/support-activity/team`) now also shows **Issues Handled**
and **Issues Resolved** columns per team member (all-time counts, computed from `SupportIssue.
supportExecutiveId` — a separate data source from Support Activity's own detection, shown
alongside it rather than merged into the same counting-period logic).

---

## WhatsApp

Sidebar group: **WhatsApp**

### WhatsApp Accounts — `/accounts`

One card per connected `WhatsAppAccount`. **Add Account** dialog takes just a Label. Per-card:
phone number, status badge (`CONNECTED`/`DISCONNECTED`/`RECONNECTING`/`AUTHENTICATION_REQUIRED`/
`SESSION_ERROR`/`OUTBOUND_PAUSED`/`RATE_LIMITED`/`ERROR`), last connected/heartbeat, session path,
which services explicitly route to it. When `AUTHENTICATION_REQUIRED`, shows the live QR (or a
"waiting for a fresh code" placeholder if the last one is stale). Actions (each a confirmed
`WorkerCommand`, never instant): **Reconnect**, **Resync Groups**, **Set/Remove Primary**,
**Logout** (danger — ends the session, needs a fresh QR), **Delete** (only if not Primary and more
than one account exists). A banner shows how many commands are waiting for the worker to pick up.

**Replacing the number that serves customers.** Primary and Account Routing decide where
*notifications* go — they do **not** decide which number answers a customer. A reply always goes
out on the account that received the message, because that is the account actually in the group;
sending from another number fails the live membership check. So switching Primary does not move
conversations. When a connected account has another account's group setup available to inherit, a
**Moving to a new number** card appears here: it copies monitoring, AI, priority tier and assigned
member for every group both numbers are in, and reports how many would carry before you commit.
Nothing is removed from the other account. Logging an account out now deactivates its groups, so
they leave the chat inbox instead of sitting there unanswerable — their settings are kept, and
reconnecting the same number restores them.

Two cautions the card states in place: the new number must be added to the groups on WhatsApp
first (**Add Number to Groups** does it in bulk, but only from an account still in them — so keep
the old number connected until that is done), and if both numbers stay in the same groups with AI
on, customers get answered twice.

### Account Routing — `/accounts/routing`

One row per real WhatsApp-sending service: **Support Notifications**, **Escalations**, **Unknown
Pattern Alerts**. Each row: an Account dropdown (Primary/default, or a specific pinned account), an
"If unavailable" fallback policy (Fall back to Primary / Show error, don't send), and a live
"Currently sends via {account}" resolution line with its source (Configured / Primary Default /
Primary Fallback) or an error if nothing can resolve.

### Groups — `/groups`

Search by name; filter chips All/Monitored/Not Monitored/Active/Inactive with live counts. Table:
Group, Account, Monitored badge (+ "Inactive · still monitored" warning if applicable), Active
badge, Participants (fetch-on-demand if unknown), Last Synced, Priority Support tier + assigned
member ("Configure" dialog), **AI Automation** (Enabled/Disabled badge + Enable/Disable AI button —
the Hybrid AI Automation fallback layer's per-group opt-in; a yellow "Human active until …" badge
appears when a team member's recent message has temporarily suppressed AI for that group), Manage
(Start/Stop Monitoring), and **Learn** (builds knowledge from that group's stored conversation on
demand rather than waiting for the hourly job). Bulk-select + Bulk Enable/Disable Monitoring **and
Bulk Enable/Disable AI**. Bulk actions read current state first, so they report "8 enabled, 1
already on, 1 not found" rather than "Done", and converge on a re-run instead of writing twice.
Bulk AI enable **never clears a group's hard AI exclusion** — that flag is a "never let AI answer
here", set where a wrong answer costs most, and a broad gesture must not quietly override a
specific one; those rows are reported as "left alone — excluded from AI" so an operator who
selected a group and saw nothing happen knows why. **Active** (the account is still a member,
auto-managed by resync) and **Monitored** (an admin opted this group into automation) are
deliberately distinct concepts, never conflated.

Which groups AI may answer in is set on AI Settings, not here: either per-group opt-in (the
default) or every monitored group. The per-group exclusion is honoured under both.

### Internal Team Members — `/team-members` (+ `/[id]/edit`)

CRUD: Name, Phone Number, Role, Department (optional), with Disable/Enable and Delete as row
actions. The edit page also carries an **"Alert this person directly"** card — a checkbox per
notification event, sending that alert to them as a WhatsApp message *in addition to* whichever
shared group it already goes to. Disabling stops treating them as staff going forward without
losing the record. **Someone with recorded support activity is deactivated
rather than deleted** — activity rows point at the member, so deleting them orphans their whole
history; someone added by mistake with no activity is still genuinely deleted.

Two ways to fill the roster without typing numbers, which matters because a typo silently
classifies a colleague as a customer: pick real senders out of a group's **message history**, or
ask WhatsApp for the group's **membership list** (the only option for a quiet group, or one being
set up before any traffic exists). Both compare numbers normalized to digits before offering or
inserting anyone, so the same colleague cannot be added twice as `+8801…` and `8801…`, splitting
their activity across two identities.

**Recognition and reachability are different things.** WhatsApp now identifies group participants
by an opaque id rather than their phone number, and adding someone from message history carries
nothing but that id — so it lands in both fields. That is fine for recognising them (matching is by
identifier) and useless for messaging them: a direct message to such an id goes nowhere. Those rows
carry a **"Needs phone number"** badge, and their direct-notification checkboxes are disabled with
the reason. Escalations, direct alerts and AI handover mentions all skip them with a log rather than
enqueueing into nothing.

---

## Automation

Sidebar group: **Automation**

### Automation Rules — `/rules` (+ `/new`, `/[id]/edit`)

The core rule editor. **Basics**: Name, Type (`GENERIC`/`DEFAULT_IGNORE`/`LAST_SENDER`/
`EXCEPTION`/`SUPPORT_ESCALATION`/`AUTO_REPLY`/`TEAM_FILTER`), Priority (higher evaluated first),
Status (`DRAFT`/`ACTIVE`/`DISABLED`/`ARCHIVED`), Description. **Trigger**: Match Type
(`ALWAYS`/`EXACT`/`CONTAINS`/`KEYWORDS`/`REGEX`) + its Match Value or comma-separated Keywords
(regex is validated server-side for length/complexity before it can go Active, to block patterns
that could hang the worker). **Conditions**: Current/Previous Sender scope (Any/Team
Member/Client), Group Scope (specific group IDs or all), an optional active-hours schedule
(start/end time + days of week, overnight windows supported). **Actions** (checkboxes): `IGNORE`,
`TAG`, `AUTO_REPLY`, `SUPPORT_REQUIRED`, `NOTIFY_TEAMS`, `NOTIFY_WHATSAPP`, `FORWARD`,
`STOP_PROCESSING`, each with its own conditional fields. **Auto-Reply Safety** (shown only if
AUTO_REPLY is checked): Reply Message, Cooldown (seconds), Reply delay min/max (ms) — on top of the
account-wide rate limits on the Settings page. List page: Duplicate (creates a DRAFT copy),
Disable/Enable, Delete, plus a priority-tie warning icon.

### Rule Tester — `/rules/tester`

A dry run — sends nothing. Inputs: message body, simulated time (for schedule testing), sender
phone + team-member toggle, group, previous sender phone + team-member toggle. Output: final
decision, matched rule, actions that would execute, and the full rules-evaluated trace (every
active rule tagged Applied/Matched-but-preempted/No-match with its reason).

### Automation Control — `/automation-control`

Exactly two controls: the **Kill Switch** (Pause/Resume Automation — pausing also cancels pending
broadcast-type outbound messages) and **Automation Mode** — `Manual Only` (detect/notify only),
`Safe Auto Reply` (recommended — only vetted acknowledgement rules reply), `Full Rule Automation`
(every active rule may run, subject to rate limits). Rate limits/delays/retries live on the
separate general Settings page, not here.

---

## Bulk Messaging

Sidebar group: **Bulk Messaging**

### Group Message Sender — `/group-message-sender`

A 5-step wizard: **Select Account → Select Groups → Review Selection → Compose Message → Preview**.

- **Select Groups**: Manual (search + "select all filtered" + checkbox list showing Verified/Stale
  sync badges) or Excel Import (`.xlsx`, required "Group Name" column, optional "Message" column —
  matched exactly or by whitespace-normalized name, never fuzzily; results bucket into Matched,
  Ambiguous (pick one), Unmatched, and Duplicate rows).
- **Compose Message**: up to 4096 chars, shows how many selected groups have their own per-row
  Excel message overriding it.
- **Preview**: target count (flagged red if over the job cap), skipped count, estimated queue size,
  a warning if automation is paused, and the final per-group recipient/message table.
- **Confirm & Queue** re-validates everything server-side, dedupes by group, enforces the job cap,
  re-verifies live group membership, and applies a **duplicate-group cooldown** (skips any group
  already sent to within the configured cooldown window) before creating one `OutboundMessage` per
  target with a randomized cumulative send delay.
- Safety defaults (`GroupBroadcastSettings`): 5–15s random delay between sends, max 6/minute, max
  200 per job, 2 retry attempts, 60-minute duplicate-group cooldown.

**Job detail** (`/group-message-sender/jobs/[id]`): live progress (settled/total, current target,
progress bar, per-status stat tiles), **Stop Job** (cancels pending, lets in-flight finish),
**Retry Failed** (resets failed rows), per-message table with status/attempts/failure
reason/provider message ID. Auto-refreshes every 3s until terminal.

**Broadcast History** (`/group-message-sender/history`): a flat, filterable audit log (account,
status, group-name-contains, date range) of every individual group send across every job, capped
at 200 rows, linking back to each row's job.

### Add Number to Groups — `/group-member-adder`

A 3-step wizard: **Select Account → Number & Groups → Review & Confirm**. Phone number is
normalized and validated (digits only, country code, no leading `+`). Groups: manual multi-select
or "select ALL groups". Safety defaults (`GroupParticipantAddSettings`, deliberately more
conservative than broadcast — WhatsApp treats bulk "add participant" as a stronger ban signal):
10–30s random delay, max 3/minute, max 100 per job, 1 retry attempt; the worker re-verifies live
group membership immediately before each add.

**Job detail** (`/group-member-adder/jobs/[id]`): same progress/Stop/Retry pattern as broadcast
jobs, with an "Added" status column instead of "Sent" and no provider-ID column.

### Sending Limits — `/group-message-sender/settings`

The throttles governing the riskiest thing this product does: sending the same message to hundreds
of groups, from the number that also serves every customer. Shortest gap and Longest gap between
sends (seconds, 1–120), Messages per minute across all running broadcasts (1–30), Maximum groups
per broadcast (1–2000 — the wizard refuses more), Retries per group (0–5), and Repeat cooldown
(minutes before the same group can be included in another broadcast; 0 disables it).

These columns existed from the start with **no form anywhere**, so they were permanently whatever
the schema defaulted to. The form takes seconds and stores milliseconds — a send delay typed in
thousandths invites the one-digit slip that turns a fifteen-second gap into a fifteen-millisecond
one, and nobody notices until retries are hammering a rate-limited number. Every value is clamped
server-side rather than trusted from the form: a delay of zero or a per-minute cap of 500 is how a
WhatsApp number gets banned, and there is no second chance to discover that.

---

## AI Learning

Sidebar group: **AI Learning** — no longer a foundation-only phase. The knowledge base is written
to by three sources, read back by every AI answer, and gated by a human-verification queue that
only verified entries escape. **Everything here is off by default**, and the master `AI Engine`
switch gates all of it.

- **Overview** (`/ai-learning`): hub links, knowledge stat tiles (Total/Active/Inactive/Archived),
  an AI Status card mirroring the master toggles, recently-updated knowledge list.
- **AI Activity** (`/ai-learning/activity`): the read view over every AI decision — one row per
  message the rule engine missed in an AI-eligible group, showing what the AI drafted, whether it
  was sent, and the reason for every handoff in plain language beside the raw code that appears in
  logs. Filters by outcome, group and time window. Stat tiles are scoped to the window and group
  but deliberately **not** to the outcome filter, so filtering to handoffs cannot report "100%
  handed off". Before this page existed, AI decisions could only be read one message at a time.
- **Knowledge Base** (`/ai-learning/knowledge-base` + new/edit): Title, Category (11 options —
  Software, Workflow, FAQ, Troubleshooting, Customer Response, SOP, Requirement, Feature, Policy,
  Announcement, Screenshot), Software/Module/Version (optional), Question/Intent (optional), Answer
  (required), Procedure (optional). Every edit creates a new version rather than overwriting — full
  history with restore. Each entry also carries its **source** (typed by hand, imported, learned
  from a group conversation, read from the product repository, or researched live for a customer)
  and a **verified** flag, set from the entry's own detail page. Verification is deliberately
  independent of status: an entry can be active-but-unchecked, or verified-but-deliberately-inactive.
- **Import Knowledge** (`/ai-learning/knowledge-base/import`): bring in your own documentation —
  pasted text, an uploaded file, a URL, a PDF, a Word document, or a spreadsheet of question/answer
  rows (parsed directly, with no AI call, because there is nothing to interpret). A manual is split
  on its own paragraph and sentence structure, never at a fixed offset, and each chunk is a separate
  call — so a 40-page manual that fails at page 30 is marked **Partial** and **keeps the 29 pages
  the other chunks produced**. The original text is retained, so Retry needs no re-upload. Imports
  are job rows drained by a background loop, so progress survives a restart.
- **Pending Review** (`/ai-learning/knowledge-base/review`): the trust boundary. Everything the AI
  writes — from chats, from the product repository, from an import — lands unverified, and **only
  verified, active entries are ever used to answer a customer**. Bulk verify and bulk archive;
  discarding archives rather than deletes.
- **Communication Style** (`/ai-learning/communication-style`): the guidance the assistant has
  distilled about *how* your executives write — greetings, formality, answer length — with how many
  real replies it was drawn from, and an **Approve** button. Nothing reaches a customer until a
  person approves it, and **every rebuild clears that approval**, so new wording never inherits the
  trust given to the old. It learns manner only: any line that reads like a fact (a duration, a
  price, a policy, a promise) is dropped, because a product claim must go through knowledge
  verification rather than arriving dressed as a tone note.
- **Product Knowledge** (`/integrations/forge`): reads ISPDIGITAL's own user guides and module
  source through Softify Forge into the knowledge base. Three tiers, differing in how much authority
  the source has: hand-written user guides (which may be auto-verified, if the admin chooses),
  per-module guides the model writes by reading the source behind each module, and on-demand
  research of a single customer question nothing covered. **Tiers 2 and 3 are never auto-verified,
  regardless of any setting** — a model's reading of source code is evidence, not fact. Every
  generated entry is re-checked mechanically and anything naming code, schema, tables, endpoints,
  infrastructure or credentials is dropped and logged, never stored. Requires `FORGE_API_KEY` /
  `FORGE_API_URL`; see `FORGE_SETUP.md`.
- **AI Providers** (`/ai-learning/providers` + new/edit): Name, Kind (Anthropic, OpenAI,
  OpenRouter, Ollama, Google — `Custom` remains reserved, since any OpenAI-compatible endpoint is
  already reachable by choosing OpenAI and setting the API URL), API URL (prefilled per kind), API
  Key (encrypted at rest, blank on edit = keep current; only a local Ollama may have none). Row
  actions: Test Connection (a real API call), Edit, Enable/Disable, Delete.
- **AI Models** (`/ai-learning/models`): 6 fixed job slots — Learning, **Response**, Vision,
  Document, Embedding, **Admin Assistant** — each a Provider + Model ID, saved independently.
  Response drives every customer-facing answer and knowledge build; Admin Assistant drives the
  floating chat and is **Anthropic-only**, because it needs real tool-calling, which is a different
  wire format rather than a base-URL swap.
- **AI Settings** (`/ai-learning/settings`) — grouped by what they decide:
  - **Master toggles**: AI Engine, Learning, Auto Response, plus the reserved Screenshot Response,
    Chat Learning, Software Learning, Requirement Learning and Announcement AI. AI Engine + Auto
    Response together gate the live fallback layer, which fires **only** when the rule engine finds
    no match at all.
  - **Replying**: Auto-Response Confidence Threshold (0–100; below it a human is asked instead),
    AI Reply Cooldown (seconds), Human Takeover Cooldown (minutes — how long a team member's own
    message pauses AI in that group).
  - **Response mode** — what AI may answer from: *Verified knowledge only* (default), *Knowledge +
    product source*, *Knowledge + general questions*, or *Everything*. Each explains itself, and its
    cost, in the panel underneath: the two that read source are slower on hard questions, and their
    answers become reusable knowledge without a person reading them first. **What no mode changes:**
    a question about this company's own product, policies, pricing or accounts is answered only from
    verified knowledge, or it goes to a person. With a general mode on, *Minimum confidence for a
    general answer* applies — normally higher than the main threshold, because nothing of the
    team's stands behind those.
  - **Answer in** — the reply language, as a dropdown: **Auto**, Bangla, Banglish, English, or
    *Other language…* which reveals a text box for any language you name.
    - Pick a **language** and AI answers in it, switching away only on real evidence — a message
      in a different script, or a fluent English sentence. A greeting, a bare number, or Bengali
      typed in Latin letters all stay in the chosen language.
    - Pick **Auto** and AI reads each message and replies in the same language *and the same
      script*: Bengali letters get Bengali letters back, Banglish gets Banglish, English gets
      English, Hindi gets Hindi. Nothing is remembered between messages, so a customer who
      switches language mid-conversation is followed immediately rather than being held to
      whatever they opened with. A message with no language signal at all — a bare "hello", a
      number, an emoji — is answered in Banglish, the one form both a Bengali and an English
      reader can follow; their next message settles it.
    - Worth knowing when choosing between them: picking **Banglish** as a fixed language means a
      customer who writes in Bengali *script* is answered in Latin letters. Auto is what keeps
      each customer in the script they chose.
  - **Learn how the team writes** — the communication-style switch described above.
  - **Write rules from good answers** — a confident AI answer also drafts a reusable rule, above its
    own (higher) confidence bar. The draft always lands as a proposal a human approves, and approval
    produces a **draft** rule someone separately activates. Nothing AI writes reaches a customer
    automatically.
  - **Handover**: *Also tag a team member in the customer's own group* (off by default — it puts an
    extra message in front of a customer; it tags the group's assigned member, or up to three people
    who opted into handover alerts, and skips anyone whose stored number cannot actually receive a
    message), and *Send takeover alerts to these WhatsApp groups* — a searchable group picker, not
    a box for pasting raw group ids. Left empty, alerts go wherever the global notification
    destinations already point.
  - **Build knowledge from group chats** + *Minimum new messages per group* — a group with less
    conversation than this is skipped, because there is not enough there to draw a reliable
    conclusion from.
  - Four learning thresholds (Duplicate Similarity, Learning Confidence, Auto Approval, Human
    Review), all 0–100.

---

## Conversation Learning

Sidebar group: **Conversation Learning** — background, deterministic-by-default pattern discovery
over real conversations; AI-assisted analysis is a fully optional, separately-gated add-on. Nothing
here sends or changes a customer message on its own.

- **Overview** (`/conversation-learning`): status badges (Conversation Learning enabled/disabled,
  AI Analysis available/not configured, Auto-Approval on/off) + a "Run AI analysis now" button; 5
  stat tiles (Sessions, Patterns Surfaced, Unknown Patterns, Patterns Accumulating, AI-Analyzed);
  recent background job runs.
- **Pattern Candidates** (`/conversation-learning/pattern-candidates` + detail): patterns that have
  cleared the review floor (minimum occurrences/distinct groups/distinct clients — all configurable
  in settings), sorted by confidence. Detail page shows the 6 individual score components
  (Confidence, Frequency, Diversity, Consistency, Resolution, Recency), evidence, and a **Create
  Proposal** button (only if not already proposed) → creates a `RuleProposal`.
- **Unknown Patterns** (`/conversation-learning/unknown-patterns`): the same floor logic applied to
  occurrences where *no existing rule fired* — the actionable subset (a pattern an existing rule
  already handles well never appears here, however often it recurs). Same detail page as Pattern
  Candidates.
- **Rule Proposals** (`/conversation-learning/rule-proposals` + detail): filterable by status
  (Pending Review/Approved/Rejected/Withdrawn). Detail shows the proposed rule's full shape.
  **Approve** → creates a **DRAFT** `AutomationRule` (still needs separate manual activation).
  **Reject** (with an optional review note) / **Withdraw** end the proposal without creating a
  rule. At most one proposal per pattern candidate — a rejected/withdrawn candidate just keeps
  accumulating fresh evidence rather than getting a second proposal.
- **Conversation Settings** (`/conversation-learning/settings`): master enable switch + Session Gap
  (minutes); the Pattern Review Floor (min occurrences/groups/clients, candidate expiry days); 6
  confidence-scoring weights; Unknown Pattern Alerts (enable + cooldown minutes); Auto-Approval
  Policy (enable + confidence threshold — still only ever produces a Draft rule, never activates
  one automatically).

---

## System

Sidebar group: **System**

- **Notifications** (`/notifications`): a Send Test Notification card (Teams-only, independent of
  the automation kill switch) and a table of the last 100 notifications (type, destination, status,
  attempts, failure reason) with a **Retry** action on failed rows (re-queues for the dispatcher,
  does not re-run the originating rule).
- **Notification Center** (`/notifications/events`): one card per reason an alert can be raised —
  *Support escalation*, *AI handed over to a human*, *Rule alert — WhatsApp*, *Rule alert — Teams*,
  *Unrecognised question pattern* — each independently switchable, with its own Teams/WhatsApp
  channel switches and its own WhatsApp destination groups. This exists because a team buried in
  pattern alerts previously had exactly one remedy: remove the notification group, which also
  silenced escalations. Every card is additive by default: **off means nothing is raised at all**
  (not raised-then-dropped, which would fill the delivery log with things that never went), and an
  **empty** destination list *inherits* the global destinations rather than sending nowhere. Team
  members can also opt in, per event, to receive an alert as a **direct message** — additive to the
  group copy, never a replacement; the group is the record, the DM is the tap on the shoulder.
  Anyone whose stored number is really a WhatsApp id cannot receive one, and their checkboxes are
  disabled with the reason on their own edit page. Notifications predating this module keep no event
  and are reported as such, rather than having one guessed for them after the fact.
- **Notification Templates** (`/notifications/templates`): the wording of every message this
  system sends that a person reads — the AI handover alert, the message posted in a customer's own
  group when AI tags somebody, rule alerts, the recurring-question suggestion, and the five
  escalation tiers. Each card shows a **live preview** built from example values, because nobody
  can judge "Waiting: {{waitingMinutes}} minute(s)" but everybody can judge "Waiting: 37
  minute(s)". Placeholders are click-to-insert and listed per template; using one that belongs to a
  different template is refused when you save, since it would otherwise send as literal text.
  Leaving one out is fine — that detail is simply not shown, and a line containing only an empty
  placeholder is removed rather than left dangling.
  - A template you have not edited has **no stored row**: it uses the built-in wording and will
    pick up future improvements to it. **Reset to default** deletes your version rather than
    copying today's default into place, so it goes back to tracking the app.
  - One template is marked **Customers read this** — the message posted in their own conversation
    when AI tags a team member. `{{mentions}}` cannot be removed from it: without the tags the
    customer reads that somebody was called when nobody was.
  - There is no "add new template". This list is the set of moments the software actually has, not
    a settings list; a template added here would be a message nothing ever sends. A genuinely new
    alert needs building into the worker that raises it.
  - Each card says whether it **can currently send**, and why not if it cannot — the feature is
    off, the alert is muted, or nothing exists to trigger it (no rule with a notify action, no
    group with a priority tier) — with a link to where that is fixed. Editing is never blocked:
    preparing wording for something you are about to switch on is normal.
  - **Send a test** delivers the saved wording with example values to a group you pick, labelled
    as a test so nobody acts on it. A preview shows the text but not what WhatsApp does with it,
    and for the message that tags a team member it is the only way to see a real @mention. Only
    groups on a connected account that it is still a member of are offered; monitored groups are
    marked, since an alert sent into one is read back in as an incoming message.
  - The customer-facing message warns when it is in English while AI replies in another language —
    a customer mid-conversation would otherwise see the language change.
  - Wording only — whether an alert fires, on which channels, and to which groups is on
    Notification Center.
- **Settings** (`/settings`): the general `AutomationSettings` form — Per-Client Reply Limits (max
  per client per hour/day), Global Rate Limiting (enable switch + max per minute/hour/day), Reply
  Delay & Retries (default delay min/max, max retry attempts, **and the retry backoff intervals** —
  how long it waits between attempts, which was previously editable nowhere, making the retry
  controls half-present), Notification Destinations (Teams webhook URL, WhatsApp notification group
  multi-select — warns if a selected group is also Monitored, a feedback-loop risk). Does **not**
  include the kill switch or automation mode (see Automation Control) or account routing (see
  Account Routing).
- **System Logs** (`/logs`): filterable by Level (Info/Warn/Error), Scope (free-text contains) and
  message text, **paginated with a real total** — it was previously capped at "newest 200" with no
  paging, so on a page whose entire purpose is finding out what happened, the entry you were looking
  for was often the one you could not reach. Expandable rows reveal pretty-printed metadata JSON.
  An internal diagnostic trail ("why didn't X happen"), not a place to read chat content.

---

## Users & Permissions

Sidebar group: **Users & Permissions**

- **App Users** (`/users` + new/edit): dashboard logins — Username (the login identifier; email is
  optional), Name, Password, Active, and an assigned Permission Module. An inactive user is
  rejected at login **and** every already-issued session of theirs is rejected too; they are never
  deleted, so their audit history (rules created, cases resolved, knowledge approved) stays intact.
- **Permission Modules** (`/permissions` + new/edit): a named set of permissions assigned to users.
  Four are seeded as system modules — those cannot be renamed or deleted, though the permissions
  inside them remain editable. A user with **no** module assigned has full access, which is what
  keeps a single-admin deployment working with nothing configured.
- **Security Settings** (`/settings/security`): Session Lifetime (hours, 1-720), Failed Attempts
  Before Lockout, Attempt Window (minutes) and Lockout Duration (minutes). The lockout check runs
  **before** the password is verified.

---

## AI Admin Assistant (floating chat)

A floating chat bubble, bottom-right, on every dashboard page — not a sidebar page of its own.
Read-only for now: it can answer questions using live data (today's support activity, connected
accounts, groups, open priority cases, AI settings, broadcast job status) but cannot change any
setting yet. Understands Bangla/Banglish/English. Requires an AI Provider configured and assigned
to the **Admin Assistant** job slot (AI Learning → AI Models) with the AI Engine switch on (AI
Learning → AI Settings) — otherwise it replies that it isn't configured yet, rather than guessing.
If it doesn't have a tool result backing a fact, it says the information isn't available rather
than inventing numbers, names, or statuses.

---

## Background jobs (apps/worker)

All `setInterval`-based, each with a manual overlap-guard so a slow tick can never run twice at
once.

| Loop | Interval | Purpose |
|---|---|---|
| Outbound queue processor | 2s | Drains the outbound send queue, one message per tick |
| Group participant-add processor | 2s | Drains the "Add to Groups" queue |
| Command processor | 1.5s | Polls `WorkerCommand` (dashboard-issued actions), strictly serial |
| Notification dispatcher | 3s | Sends queued Teams/WhatsApp notifications |
| Account registry sync | 20s | Discovers new accounts, connects them one at a time |
| Escalation processor | 15s | Advances at most one due escalation case per tick |
| Session segmentation | 5min | Conversation Learning: buckets messages into sessions (gated) |
| Pattern detection | 15min | Deterministic, AI-free recurring-pattern scoring (gated) |
| Knowledge import processor | 15s | Drains manual Knowledge Center imports, one chunk at a time |
| AI-assisted analysis | 6h | Optional AI rescoring, or on-demand via the dashboard (gated) |
| Group knowledge builder | 1h | Distils one monitored group's stored conversation into knowledge entries, oldest first (gated; also on-demand via the Groups page's **Learn** button) |
| Communication style builder | 12h | Rebuilds the style guidance from the team's own replies — manner, never fact (gated; needs approval before it is used) |
| Teams sync | 3min (admin-configurable) | Polls Microsoft Graph for linked channels' messages, runs resolution matching (no-ops until connected; also on-demand via **Sync Now**) |
| Product knowledge sync | 6h | Reads the ISPDIGITAL repository's user guides and module source through Softify Forge (no-ops until configured and enabled; also on-demand) |
| Unanswered-question research | 2min | Works through customer questions verified knowledge could not answer, researching each against the product's source (same gate, plus its own switch, off by default) |
| Heartbeat | 15s | Health state + DB connectivity log |

Support Activity Tracking's detector and the Hybrid AI Automation fallback layer are **not**
scheduled loops — they're inline, fire-and-forget steps inside the incoming-message pipeline
itself, right alongside the escalation side effect. Researching an unanswered question *while the
customer waits* is likewise inline (it is what the two "product source" response modes do); the
2-minute loop above is the offline version, which researches after a handover so the next customer
is answered instantly.

---

## Safety & anti-spam features, end to end

- **One outbound mechanism** — every WhatsApp send (rule auto-replies, broadcasts, forwards) goes
  through the same DB-backed `OutboundMessage` queue. No feature has its own parallel send path.
- **Idempotency everywhere it matters** — message ingestion, rule execution, broadcast sends,
  escalation notifications, Support Activity detection, and Teams resolution events all have a real
  unique-constraint-based dedup guard, not just an application-level check.
- **Rate limits are layered**, not singular: per-rule cooldowns → per-client hourly/daily caps →
  global per-minute/hour/day caps → job-level caps (broadcast/add-to-groups) → the account-wide
  kill switch, each independently configurable.
- **No unrestricted bulk mode** — every bulk-send feature (broadcast, add-to-groups) requires an
  explicit compose → preview → confirm flow, re-validates server-side at confirm time, and is
  reply-triggered or admin-initiated only, never automatic.
- **Regex safety is two-layered** — save-time validation (length/complexity limits, rejects
  catastrophic-backtracking shapes) plus a runtime timeout net for rules saved before the validator
  existed.
- **Multi-account isolation** — every account-scoped model carries `accountId`, and every
  aggregate/report query that needs isolation filters by it; nothing silently merges two accounts'
  data.
