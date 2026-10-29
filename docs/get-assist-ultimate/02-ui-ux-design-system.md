# 02 — UI/UX design brief (Chat UI V3 and the workspace shell)

**Status:** design brief for Phase 2. No UI has been changed. Screenshots and browser-tested previews are a Phase 2
deliverable, produced against the isolated DB, not production.

## 1. Starting point (verified)

- Design tokens as CSS custom properties in `apps/web/src/app/globals.css`; ink chrome, separate chart scale
  (`--chart-1..6` for identity, status tokens for state). Element rules live in `@layer base`.
- 26 in-house components (`components/ui`), `lucide-react` icons, no Radix/shadcn. `Dialog`, `Tooltip`, `Toast`
  exist in-house.
- Two chat UIs: v1 (`chat/`, production) and v2 (`chat/v2/`, behind `CHAT_UI_V2`). Channel inbox
  (`conversations/`) is a third, separate surface for Messenger/Instagram/Telegram.
- Rules already earned in production and kept in V3 (CLAUDE.md "WhatsApp Chat inbox"): account in the URL path;
  server-side filtering by account; 300-row render cap with server search beyond it; `chatReviewedAt` timestamp
  (never boolean); queued reply counts as answered, FAILED/CANCELLED do not; selection is a mode; drafts in
  `localStorage` per conversation; filter rail scrolls sideways; open at newest message; no entrance animations
  on rows; `/` focuses search; no mute; saved replies insert, never send.

## 2. Decision: one V3 workspace, built as an evolution of v2

V3 is a new layout around the v2 thread (which already has ordered cursors, quotes, receipts, reactions, rich
messages and file sending). It is introduced as a new project feature `CHAT_UI_V3`, off by default, and replaces
neither v1 nor v2 until it has been used live. Switching it off is the rollback.

Library choice: keep the in-house kit. Add **only** what the brief cannot do well by hand:

| Need | Choice | Why |
|---|---|---|
| Long conversation list and thread | `@tanstack/react-virtual` | headless, ~5 KB, works with existing markup |
| Accessible menus/popovers/tabs in the composer and context panel | Radix primitives for those specific widgets only (`@radix-ui/react-dropdown-menu`, `-popover`, `-tabs`) | focus management and keyboard handling are where hand-rolled widgets fail audits; no restyling of existing components |

## 3. Information architecture

```
Overview
Inbox (V3)            ← one entry; channel is a filter, not a page
  ├─ My inbox · Unassigned · Team · Priority · Waiting · Snoozed · Resolved · Saved views
  └─ Channel switcher: All · WhatsApp (per account) · Messenger · Instagram · Telegram · Website (later)
Customers (Client Center)
Support (Assignment · Escalations · Tickets later)
Reports · Team · WhatsApp ops · Automation · AI · Settings   ← unchanged modules
```

The WhatsApp account remains part of the URL when a WhatsApp conversation is open (existing rule); "All" lists merge
through the existing `getChatInbox` + `ChannelConversation` union, exactly as `/conversations/all` does today.

## 4. Layout specifications

**Desktop (≥1280 px)** — three panes: list 360 px (resizable 300–440), thread fluid (min 480), context 360 px
(collapsible to a 48 px icon rail). Pane widths persist per user in `localStorage`.

**Tablet (768–1279 px)** — list + thread; context opens as an overlay sheet from the right.

**Mobile (<768 px)** — one pane at a time: list → thread (URL change, so Back works) → context as a full-screen sheet.
Composer sticky with `env(safe-area-inset-bottom)`; `visualViewport` resize keeps the composer above the keyboard;
list scroll position restored on Back. Touch sizing remains scoped to `pointer: coarse`.

### Pane A — list row
Avatar (passive picture or initials), name, channel badge, account chip (WhatsApp), last preview, relative time,
unread dot (solid = unseen, hollow = seen-unanswered — existing semantics), assignee avatar, SLA chip only when a
real `SupportAssignment.dueAt` exists, AI state (on / paused-takeover / off).

### Pane B — thread
Header: name, verified-identity badge only when a `Client` link exists, channel, assignee picker, priority, state.
Timeline: day separators, sender kind (customer / member / business phone / AI / rule / broadcast — from the existing
`outgoingActorFor`), quotes, receipts where the channel reports them, failed/unknown states with Retry, internal
notes visually distinct (yellow surface, "Only your team sees this"). In-thread search and jump-to-date reuse the
v2 cursor API.

### Pane C — context tabs
Customer (Client 360 summary; billing only with `clients.view_billing`), AI Copilot (Phase 3), Orders (Phase 7),
Tickets (Phase 5), Activity. A tab whose feature is off is not rendered at all.

### Composer
Mode toggle Reply / Internal note (note mode changes the surface colour and the send button label — the single most
important guard against leaking a note). Saved replies, emoji, mentions (phone-number ids only, existing rule),
attach, AI draft (Phase 3). One idempotency key per send attempt; the button disables until the queue row exists.
Channel limits shown before send (Instagram 1,000 bytes; Meta 24 h window with HUMAN_AGENT state).

## 5. Tokens to add

Only what V3 needs: `--surface-note`, `--surface-note-border`, `--ai-accent` (identity slot, not a status colour),
`--sla-warn`/`--sla-breach` mapped onto existing warning/danger, pane widths, and a density scale (compact /
comfortable) already present as a preference. Dark-theme values for each.

## 6. Interaction and permission rules

- A control the channel cannot perform is not shown (capability contract, `09`), never shown-and-failing.
- A control the role cannot perform is hidden; a page the role can read but not change shows `ViewOnlyNotice`.
- Motion: feedback only (1 px press settle, 150 ms pane slides on tablet/mobile); `prefers-reduced-motion` already
  zeroes transitions globally.

## 7. Accessibility checklist (WCAG 2.2 AA)

List is a `listbox` with roving tabindex; thread is a `log` region with polite announcements for new messages only
when the user is at the bottom; every icon button has a label; focus returns to the row after closing a sheet;
contrast checked for both themes including note and AI surfaces; target size ≥24 px (2.5.8); no drag-only
interactions; dialogs trap focus.

## 8. Verification plan for Phase 2

Playwright (new dev dependency) against the isolated test DB with seeded fixtures: viewport runs at 390, 820, 1280,
1600 px in light and dark; axe-core scan per screen; screenshots committed under
`docs/get-assist-ultimate/screenshots/`. No run against the live app container.
