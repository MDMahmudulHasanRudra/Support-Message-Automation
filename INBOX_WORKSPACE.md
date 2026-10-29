# Inbox workspace — notes, priority, tags, Team, AI Copilot

A side panel beside every conversation in **WhatsApp Chat** (groups and personal chats) and **All
Conversations** (Messenger, Instagram, Telegram). Desktop (≥1280 px): a 340 px column that collapses to a
rail (remembered per browser). Smaller screens: a "Notes & Copilot" button opens it as a sheet.

Two project features, both **off by default** (Main Admin → project → Features):

| Feature | Panel tabs |
|---|---|
| `INBOX_COLLABORATION` | Details (priority, tags, Team for channel conversations), Notes |
| `AI_COPILOT` | Copilot |

Off = the pages render exactly as before; saved rows are kept.

## Who can do what

- Read the panel: `messages.view` + the conversation's module (WHATSAPP_CHAT or OMNICHANNEL).
- Write notes, priority, tags, Team, ask the Copilot: the reply key of that module (`messages.reply` for
  WhatsApp, `conversations.reply` for channels). A read-only role sees the panel and changes nothing.
- Delete a note: its author only (soft delete, System Log entry).

## Data (migration `20261029090000_inbox_workspace`)

- `ConversationLabel` (priority, tags), `ConversationNote`, `AiDraft`; `ChannelConversation.assignedTeamId`.
- A conversation is EITHER a WhatsApp chat (`accountId` + `chatId`, the pair on `Message`) OR a
  `ChannelConversation` — a CHECK enforces exactly one; one label row per conversation (partial unique).
- Same-project triggers on every relation; rows cascade with their account / channel conversation.

## Rules worth not undoing

- **Notes are never sent.** They live in their own table; no send path, prompt or report reads it. The note
  box is visually distinct (amber) and says so.
- **The Copilot never sends.** It writes an `AiDraft`; "Use in reply" only fills the composer
  (`lib/composerBridge.ts`) and the agent presses Send, so every existing send check still applies.
- **One AI path.** The worker's `copilot/copilotJob.ts` uses the Response model, verified-only
  knowledge retrieval and — for a reply draft — the production `buildFallbackPrompt` / `parseFallbackResponse`
  (language rules, house style, business-question classification). What would make production hand over
  (ungrounded business answer, low confidence) becomes a visible warning, because a person reviews it.
- **Spending guard.** One request in flight per person per conversation; 40 requests per person per hour.
  Provider, model and tokens are stored per request (`AiDraft` is the copilot's usage ledger).
- Its own loop (`ai-copilot`, 2 s), never a WorkerCommand: an agent's request must not queue in front of a
  WhatsApp reconnect.
- Mentions are `@username` of people with access to the project; stored as user ids. There is no in-app
  notification for a mention yet — the note shows "You were mentioned" to that person.

## Modes

| Mode | Output |
|---|---|
| Summarise & suggest (ASSIST) | summary, intent, up to five next steps, matched verified knowledge |
| Draft a reply (DRAFT) | a reply to the latest customer message, sources, warning when not grounded / low confidence |
| Rewrite (REWRITE) | the agent's typed text or a draft: shorter, more detail, friendlier, formal, grammar, English, বাংলা, Banglish — no new facts |

## Reliability (migration `20261029100000_copilot_reliability`)

- **One active request per person per conversation is a database rule** (partial unique indexes
  `AiDraft_one_active_*` on PENDING/PROCESSING). Concurrent requests: one row is inserted, the others get
  "still working". Finished requests are unlimited history.
- **Lease + bounded retry.** A claim sets `attempts += 1` and a 3-minute `leaseExpiresAt`. Every tick first
  re-queues expired claims while `attempts < 2`, and FAILS them after that ("the server restarted — ask
  again"). The provider may already have answered a lost call, so a retry can cost one more call; never more.
- **Only the live claim writes a result** (`status = PROCESSING AND attempts = <this claim>`): a late answer from
  an abandoned attempt, or one the agent cancelled, is dropped.
- **Cancel** (the asker, while PENDING/PROCESSING) → CANCELLED. A call already sent may still be billed.
- **AI_COPILOT switched off**: no provider call; waiting requests become CANCELLED with the reason; a call
  already in flight finishes. The web refuses new requests while it is off.
- Ungrounded business-specific drafts carry a red "Not verified" badge and alert; grounded ones say
  "based on verified knowledge — still review". A person always sends.

## Inbox (All Conversations) — views, filters, saved views, bulk, mentions

Migration `20261029110000_inbox_views_mentions` (InboxSavedView, InboxMention, ConversationEvent).

- **Views**: Open, My inbox, Unassigned, Unread, Needs reply, High priority, Urgent (both need
  INBOX_COLLABORATION), Closed. **Filters** (combinable): account, last activity, assigned person, Team, tag,
  search. One validated shape (`parseInboxFilterSet`, packages/shared) serves the list, saved views and bulk.
- **Full dataset, never the loaded 300**: channel conversations filter in SQL; for WhatsApp the label /
  owner filters are first resolved to chat ids over the whole project, then handed to WhatsApp Chat's own
  ranker as a `{ kind: "chats" }` view, so its window applies after filtering.
- **WhatsApp ownership is the group's owner** (`WhatsAppGroup.assignedTeamMember`, Groups page,
  GroupResponsibilityChange). The inbox only reads it (My inbox / Assigned to / Team / Unassigned); bulk
  assign / Team / status skip WhatsApp rows and say why. Personal chats have no owner (Unassigned).
- **Rows** show priority flag, owner/assignee, Team, up to two tags, AI on, closed, "Not sent" when the newest
  reply failed or its outcome is unknown, and the unread/needs-reply dots. Compact / comfortable density per
  browser.
- **Saved views**: personal (creator only) or shared (needs `channels.manage` to share or change a shared
  one); pin and default per person (`ListViewPreference` key `inbox-saved-views`). Filters are re-validated on
  every read; a view never grants access.
- **Bulk** (≤200): priority, add tag, assign, Team, close / reopen — per-conversation permission and
  project checks, counts of changed / already so / skipped / failed.
- **Assignment history** for channel conversations: `ConversationEvent` (ASSIGNEE / TEAM / STATUS, actor,
  time), written by every assign / Team / close path, shown under Details.
- **@mentions**: saving a note creates one `InboxMention` per mentioned person (unique per note+person, same
  transaction). Only people with project access whose role holds `messages.view` can be mentioned. The @
  button in the inbox header lists them with unread state and links to the conversation.

## Polish (WP-V3.2E)

- WhatsApp Chat's own list shows the priority flag, group owner and up to two tags per row
  (`chatListLabels`, two queries for the whole list; empty with INBOX_COLLABORATION off, so the list is unchanged).
  Rows reached only through search / "load the rest" show no labels.
- Saving / renaming / sharing a view and bulk-tagging use proper dialogs; deleting a view needs a second press.
- The side panel is resizable on desktop (drag or arrow keys on its edge, 280–480 px, remembered per browser).
  Alt+1/2/3 open Details / Notes / Copilot (the sheet on smaller screens); Escape closes the sheet, which takes
  focus when it opens.
