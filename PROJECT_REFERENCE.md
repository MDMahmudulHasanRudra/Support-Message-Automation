# Project Reference

This is the exhaustive, page-by-page functional reference for Support Message Automation — every
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
6. [WhatsApp](#whatsapp)
7. [Automation](#automation)
8. [Bulk Messaging](#bulk-messaging)
9. [AI Learning](#ai-learning)
10. [Conversation Learning](#conversation-learning)
11. [System](#system)
12. [AI Admin Assistant (floating chat)](#ai-admin-assistant-floating-chat)
13. [Background jobs (apps/worker)](#background-jobs-appsworker)
14. [Safety & anti-spam features, end to end](#safety--anti-spam-features-end-to-end)

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

A single logged-in session currently has full access to everything — there is no role/permission
system yet (every feature described below is available to any authenticated user).

---

## Overview (Dashboard)

**Route**: `/overview` (pinned above all sidebar groups, labeled "Overview")

The landing page after login — a glanceable, entirely read-only command center. Nothing here sends
or changes anything; every number links to the real page where you'd act on it.

- **8 KPI stat tiles**: Connected accounts, Incoming messages (24h), Support required (24h), Active
  rules, Outbound queue (pending), Failed notifications (24h), Open escalation cases, Unresolved
  unknown patterns.
- **9 module cards** (one per feature area, each with 2–4 live numbers and a "View module →" link):
  Accounts & Routing, Automation Rules & Outbound, Priority Support Escalation, Conversation
  Learning, AI Learning, Bulk Messaging, Notifications, System Logs, **Support Activity**.
- **Message Activity card**: a 7-day inline-SVG trend line (`Sparkline`) of incoming message
  volume, plus the last 10 messages across every account.
- A warning banner appears if any WhatsApp account isn't connected.

---

## Messages

Sidebar group: **Messages**

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

### Activity — `/support-activity`

Stat tiles (labeled "Today's"/"This Week's"/"This Month's ..." depending on the configured
counting period): Support Groups, Support Activities, Active Support Members, Total Supported
Groups (all-time), Repeated Support Activities (activities minus unique groups — a positive number
means at least one group got hit more than once). A 30-day trend Sparkline. A Recent Activity table
(last 10, across every group) with **Export CSV** / **Export Excel** links.

### Team Performance — `/support-activity/team`

Read-only report: one row per team member with any activity in the current counting period, and
their activity count. Export CSV/Excel here too. Links out to Internal Team Members for actually
managing the roster — this page never duplicates that CRUD.

### Reports — `/support-activity/reports`

Pick a group (and optionally a custom From/To date range, overriding the default period) to see its
detection timeline plus the "Counted Support" vs. "Activities" distinction for that one group (in
`UNIQUE_GROUP` terms: 1 if anything happened, 0 if not). Export CSV/Excel scoped to that group+range.

### Rules — `/support-activity/rules` (+ `/new`, `/[id]/edit`)

Each rule combines: **Trigger Type** (`Keyword Match`, `Reply to Customer`, `Mention`), **Keywords**
(multi-select, only for Keyword Match), **Team Member Scope** (all, or a specific multi-select),
**Group Scope** (all, or a specific multi-select), Active/Disabled. The first active rule (and,
for Keyword Match, its first matching keyword) that applies wins — at most one Support Activity per
message. Row actions: Edit, Disable/Enable, Delete.

### Keywords — `/support-activity/keywords`

Simple CRUD: Value, Match Mode (Contains/Exact), Case Sensitive toggle, Active/Disabled. Contains
matches at a whole-word boundary; case-insensitive is the default.

### Settings — `/support-activity/settings`

Master **Enable Support Activity Tracking** switch (default off — no existing automation is
affected either way). **Counting Mode**: `Unique Group` (each group counts once per period),
`Every Activity` (every match counts), `Per Team Member` (totals per member — confirmed semantics:
two activities by the same member in the *same* group still count as 2, not 1). **Counting
Period**: `Daily`, `Weekly` (Sunday-start), `Monthly`. Links out to Keywords/Rules for the actual
detection logic.

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
member ("Configure" dialog), Manage (Start/Stop Monitoring). Bulk-select + Bulk Enable/Disable
Monitoring. **Active** (the account is still a member, auto-managed by resync) and **Monitored**
(an admin opted this group into automation) are deliberately distinct concepts, never conflated.

### Internal Team Members — `/team-members` (+ `/[id]/edit`)

CRUD: Name, Phone Number (exact match key — this is how the system recognizes a message as coming
from staff, not a client), Role, Department (optional), Active/Inactive. Disabling stops treating
that number as staff going forward without losing the record; deleting removes it permanently.
Neither touches already-stored message history.

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

---

## AI Learning

Sidebar group: **AI Learning** — **Phase 1, foundation only.** Every page here explicitly states
that nothing on it (except the Providers "Test Connection" button) currently affects WhatsApp
behavior — it's pre-configuration for later phases that don't exist yet, with one live exception:
the **Admin Assistant** model slot, which powers the floating AI chat widget (see below).

- **Overview** (`/ai-learning`): 4 hub links, knowledge stat tiles (Total/Active/Inactive/
  Archived), an AI Status card mirroring the 4 master toggles, recently-updated knowledge list.
- **Knowledge Base** (`/ai-learning/knowledge-base` + new/edit): Title, Category (11 options —
  Software, Workflow, FAQ, Troubleshooting, Customer Response, SOP, Requirement, Feature, Policy,
  Announcement, Screenshot), Software/Module/Version (optional), Question/Intent (optional), Answer
  (required), Procedure (optional). Every edit creates a new version rather than overwriting — full
  history with restore.
- **AI Providers** (`/ai-learning/providers` + new/edit): Name, Kind (Anthropic/OpenAI/Google/
  Custom — only Anthropic is actually implemented), API URL (optional), API Key (encrypted at
  rest, blank on edit = keep current). Row actions: Test Connection (a real API call), Edit,
  Enable/Disable, Delete.
- **AI Models** (`/ai-learning/models`): 6 fixed job slots — Learning, Response, Vision, Document,
  Embedding, **Admin Assistant** — each just a Provider + free-text Model ID, saved independently.
  Admin Assistant is the only slot anything actually calls today.
- **AI Settings** (`/ai-learning/settings`): 8 boolean toggles (AI Engine, Learning, Auto Response,
  Screenshot Response, Chat Learning, Software Learning, Requirement Learning, Announcement AI —
  all default off, all currently inert except AI Engine gating the Admin Assistant) and 4 threshold
  numbers (Duplicate Similarity, Learning Confidence, Auto Approval, Human Review — all 0–100,
  reserved for later phases).

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
- **Settings** (`/settings`): the general `AutomationSettings` form — Per-Client Reply Limits (max
  per client per hour/day), Global Rate Limiting (enable switch + max per minute/hour/day), Reply
  Delay & Retries (default delay min/max, max retry attempts), Notification Destinations (Teams
  webhook URL, WhatsApp notification group multi-select — warns if a selected group is also
  Monitored, a feedback-loop risk). Does **not** include the kill switch or automation mode (see
  Automation Control) or account routing (see Account Routing).
- **System Logs** (`/logs`): filterable by Level (Info/Warn/Error) and Scope (free-text contains).
  Expandable rows reveal pretty-printed metadata JSON. Capped at 200 rows. This is an
  internal diagnostic trail ("why didn't X happen"), not a place to read chat content.

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
| AI-assisted analysis | 6h | Optional AI rescoring, or on-demand via the dashboard (gated) |
| Heartbeat | 15s | Health state + DB connectivity log |

Support Activity Tracking's detector is **not** a scheduled loop — it's an inline, fire-and-forget
step inside the incoming-message pipeline itself, right alongside the escalation side effect.

---

## Safety & anti-spam features, end to end

- **One outbound mechanism** — every WhatsApp send (rule auto-replies, broadcasts, forwards) goes
  through the same DB-backed `OutboundMessage` queue. No feature has its own parallel send path.
- **Idempotency everywhere it matters** — message ingestion, rule execution, broadcast sends,
  escalation notifications, and Support Activity detection all have a real unique-constraint-based
  dedup guard, not just an application-level check.
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
