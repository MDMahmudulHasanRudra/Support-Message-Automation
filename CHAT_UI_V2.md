# WhatsApp Chat — UI v2

An upgraded conversation thread and composer for WhatsApp Chat, inspired by the chat dashboard of
[rmyndharis/OpenWA](https://github.com/rmyndharis/OpenWA) and built on this application's own data,
queue and permissions. Switched by the **`CHAT_UI_V2` project feature, off by default** — with it off
every page renders exactly as before.

Reference pinned: `rmyndharis/OpenWA@078b8aa458584762b9dee6d6e83fc42680fa14e5` (15 Oct 2026), MIT.
See `docs/third-party/OPENWA_REFERENCE.md` for what was taken from it (patterns only — no source file,
style sheet or asset was copied).

## 1. Ground rules

- **Presentation and interaction only.** The worker, the provider, the outbound queue, Team Report and
  every report read exactly what they read before. The one data-path change is additive: an outbound
  row can name the message it replies to (§4).
- **Nothing is sent from the browser.** A reply is still one `OutboundMessage` row written by a Server
  Action and sent by the worker through the one queue, with every existing check (permission, account
  ownership, membership, connection, rate limits, idempotency).
- **No state is shown that was not confirmed.** A reaction the worker has not confirmed reads "sending";
  a queued reply stays dashed until WhatsApp echoes it; a mention is offered only for a phone-number id.
- **Legacy stays.** The v1 components are untouched apart from additive exports and one optional prop.
  Switching the feature off is the rollback; no database restore is ever needed.

## 2. Compatibility matrix

| Capability | Existing (v1) | OpenWA reference | v2 | Backend dependency | Status |
|---|---|---|---|---|---|
| Group / personal / all lists, per account | Yes, real totals, 300-row window + server search | Sidebar reducer + socket | Unchanged (v1 list kept) | — | Kept |
| Categories, pin, archive, waiting/seen, density, keyboard | Yes | Partly | Unchanged | — | Kept |
| Connected-account status, offline composer | Yes | Yes | Kept, plus header dot | — | Kept |
| Thread window | 80 newest, "older history is on All Messages" | 100/page infinite query | 80 newest + **cursor paging of stored history** | new read action | **Done** |
| Stable order at equal timestamps | `timestampWa` only | DB `createdAt` tiebreak | `(timestampWa, id)` everywhere | getChatThread order | **Done** |
| Date separators, run grouping, sender names | Yes | Yes | Kept | — | Kept |
| Group sender colours | No | Yes | Deterministic, contrast-checked palette | — | **Done** |
| Unread divider | No (dot in list only) | Unread count | "New since you last opened" from `chatReviewedAt` / `PersonalChatReview` | read only | **Done** |
| Scroll-to-latest, new-message count | Button only | decideScroll | Button + count, OpenWA's 100 px rule, user-scroll guard on paging | — | **Done** |
| WhatsApp formatting, safe links, Bangla direction | Plain text | parseMessageBody + linkify | Own tokenizer → React nodes (no HTML), `dir="auto"`, read-more | — | **Done** |
| Copy message | No | Yes | Yes | — | **Done** |
| Quoted message render | Yes (incoming + echoes) | Yes | Yes + click jumps to original (loads older pages if needed) | read action | **Done** |
| **Send a real quoted reply** | No | `replyToMessage` | Reply action → banner → `OutboundMessage.replyToMessageId` → worker `client.reply()` | migration + worker + provider | **Done (needs live verification, §6)** |
| Mentions | Worker supports `OutboundMessage.mentions` (AI handover only) | Mention chips | `@` picker for **phone-number ids only**, validated server-side | read action + send action | **Done (needs live verification)** |
| Reply + mention together | — | Yes | **Refused** — the library's `sendReplyWithMentions` is a stub returning `false` | provider | Boundary |
| Send a reaction | `reactToChatMessage` + `REACT_TO_MESSAGE`, no UI | Yes | Quick reactions + picker on stored messages | existing command | **Done (needs live verification)** |
| Show reactions | No | Engine-dependent | **Our own** reactions, from the command's confirmed result; pending/failed shown as such | read only | **Done** |
| Others' reactions | No | wwjs only | **Not possible**: `onReaction` needs the Insiders licence | provider | Boundary |
| Remove a reaction | No | Engine-dependent | **Not offered**: the worker requires a non-empty emoji and the empty-emoji contract is unverified | — | Boundary |
| Edit a message | `editChatMessage`, no UI | Yes | Not exposed: experimental in the library, most accounts lack it | — | Deferred |
| Emoji picker | No | Yes | Built-in curated set, no dependency | — | **Done** |
| Saved replies, drafts, Enter/Shift+Enter, autogrow | Yes | Partly | Kept (same component logic) | — | Kept |
| Double-send prevention | 10 s idempotency window | Pending lock | Window kept; key now includes the reply target and mentions; button locks while pending | — | **Done** |
| Image lightbox | Single image | Lightbox | Gallery over the loaded thread, arrow keys | — | **Done** |
| Video / audio / documents | Yes, authorised, Range, lazy | Yes | Kept (same component) | — | Kept |
| In-conversation search | No | Global search | Search this conversation's stored messages, jump to a hit | read action | **Done** |
| Live updates | 4 s `router.refresh()`, paused when hidden | WebSocket | Kept; SSE designed, not built (§7) | — | Polling kept |
| Message edits / revokes received | No | Yes | Not collected by our pipeline | worker | Boundary |
| LID ↔ phone mapping | Never shows a LID as a number | `lid_mappings` table | Unchanged; no mapping is guessed | — | Unchanged |

**Status words.** *Done* = implemented and verified through its real data / command path on an
isolated database and in a browser (§8). *Needs live verification* = the application side is verified,
but whether WhatsApp itself accepts it can only be proven on a real (test) number — no WhatsApp session
was used for any of this. *Boundary* = not possible on the installed provider, refused or not offered.

## 3. What v2 adds (files)

- `packages/shared/src/chatMessageFormat.ts` — pure WhatsApp-formatting + link + mention tokenizer.
- `packages/shared/src/chatThreadCursor.ts` — opaque `(timestampWa, id)` cursor, merge and order rules.
- `packages/shared/src/chatReactions.ts` — emoji validation and the own-reaction state rule.
- `packages/shared/src/chatMentions.ts` — mention candidate and validation rules.
- `apps/web/src/server/chatThreadV2.ts` + `server/actions/chatThread.ts` — older pages, jump-to,
  in-thread search, mention candidates, reaction state.
- `apps/web/src/app/p/[project]/(dashboard)/chat/v2/` — the thread, composer, formatted body, emoji
  picker, gallery.
- Migration `20261016100000_outbound_reply_to` — one nullable column, index, FK and same-project trigger.
- Worker: `sendMessage(…, { quotedMessageId })`, routed to `client.reply()`.

## 4. Quoted replies, end to end

1. Reply on a stored message (it has a WhatsApp id; a queued bubble cannot be quoted).
2. The composer posts `replyTo` = our `Message.id`. The action re-derives it through the scoped client
   and refuses unless it is in **this** conversation of **this** account and has a WhatsApp id.
3. `OutboundMessage.replyToMessageId` stores it (FK `SET NULL`, same-project trigger).
4. The worker reads the target's `whatsappMessageId` and calls `provider.sendMessage(chat, body,
   mentions, { quotedMessageId })`; OpenWA routes that to `client.reply()` (public API, no licence).
   If the target has been deleted since, the row fails with a reason rather than sending unquoted.
5. WhatsApp echoes the sent message; the pipeline's existing quote resolution stores
   `Message.quotedMessageId` on the echo. **That echo is the proof** — the thread renders the quote from
   the stored message, never from the outbound row's intent.

## 5. Mentions

Offered only in groups, only for ids that are provably phone numbers (`…@c.us`) of people who wrote in
this group copy (stored messages), plus roster members who wrote here and have a reachable number
(`hasReachablePhoneNumber`, the rule the AI handover mention already uses). A LID is never offered,
never converted, never printed as a number. The server recomputes the candidate set on send and refuses
any mention outside it, and any mention whose `@digits` is not in the text. At most 20 per message.

## 6. Needs live verification on a test number (not done here)

The library resolves `WAPI.reply` / `WAPI.react` / mention lists from runtime patches; the local copy's
`sendReplyWithMentions` is a stub and its mention builder only resolves `@c.us` contacts. Before
switching v2 on for a project, on an **isolated test number and test group**:
1. reply to a customer message → the echo carries the quote (thread shows it as a stored quote);
2. tag a participant → their phone shows the mention;
3. react → the command completes `DONE` and the reaction is visible on the phone.

## 7. Real-time (designed, not built)

An authenticated SSE route per account that emits only *invalidation* signals (new `Message.createdAt`
/ `OutboundMessage.updatedAt` watermark for the account), with the browser re-fetching through the
existing authorised render. No message data on the stream, so authorisation stays where it is. Not built
in this phase: each open tab would hold a database poll on the server, which needs load testing first,
and the 4 s visibility-aware poll already shows queued → sent within one tick of the 2 s queue.

## 8. Verification (16 Oct 2026)

All on a throwaway PostgreSQL container created for this (`127.0.0.1:5434`, memory-backed, no volume,
no restart policy, removed afterwards), with every migration applied from empty. Docker Desktop was
already running; no existing container, volume, WhatsApp session or production database was touched,
and no worker ran.

| Suite | Result |
|---|---|
| shared unit (incl. `chatV2.test.ts`, 20) | 40 files, 744 passed |
| worker unit (incl. `sendRoute.test.ts`) | 37 files, 420 passed |
| web full isolated suite (incl. `chatV2.integration.test.ts`, 9) | 53 files, 713 passed |
| worker full isolated suite (incl. `quotedReply.integration.test.ts`, 3; `projectIntegrity`) | 107 files, 1,237 passed |
| browser E2E (headless Chromium over CDP, seeded fixtures, 2 projects, 2 roles) | 15 / 15 passed |

**Each new guard was shown to fail without its code** (CLAUDE.md rule): the cursor's id tiebreak, the
account check on a conversation, the reply-target ownership check (web and worker), the feature-off
refusal, the reaction double-press guard, the link-protocol check, the mention candidate check, and the
same-project trigger (`projectIntegrity` fails naming it when it is dropped).

**Browser E2E covered:** v2 on for ISP Digital and v1 for Bizify (flag off) side by side; formatting,
links, Bangla, `dir="auto"`, "Read more"; a LID mention named from the roster and an unknown one left as
typed; confirmed and failed own reactions; human / automated attribution; failed send with "edit and
send again"; unread divider; search jumping to a message outside the loaded window; paging the whole
stored history (every message once, in order, across a five-message timestamp tie); quote → original;
gallery 1→2 of 3; a reply that stores `replyToMessageId` and shows its quote while queued; the @-picker
offering only phone-number people and storing the mention; a reaction stored PENDING and shown as
"sending"; a phone-number and a LID personal chat (the LID never shown as a number); another project's
group URL is a 404; a read-only role reads and pages but has no reply, react or composer; phone width
with touch (actions visible, no horizontal scroll); dark mode.

**Also verified:** the new code against an UNMIGRATED schema fails every outbound query ("column
`OutboundMessage.replyToMessageId` does not exist") — the deploy-order rule in §10 is real, not theoretical.

## 9. Known limitations

- **Other people's reactions are not shown** — `onReaction` needs the Insiders licence. Only this account's
  own reactions appear, and only as the worker settled them.
- **Reaction removal is not offered** — the worker refuses an empty emoji; the empty-emoji contract is
  unverified on this library.
- **A quoted reply cannot also tag people** — the library's `sendReplyWithMentions` is a stub returning
  false. Refused in the UI, the action and the worker, never silently dropped.
- **Mentions reach only people with a phone-number id.** People WhatsApp shows by a LID cannot be tagged
  (counted in the picker as such). Roster members are tagged by their typed number, the rule the AI
  handover mention already uses.
- **Quote, react and mention are verified up to the provider call** (mock provider) — not against
  WhatsApp. §6 lists the three checks to run on a test number before switching v2 on.
- **No real-time stream** — the existing 4 s visibility-aware poll is kept (§7).
- ~~No delivery / read ticks~~ — added 16 Oct 2026 with deleted messages, history loading, polls, locations,
  stickers, forward, star and pin/archive on the phone: see `CHAT_RICH_MESSAGING.md`.
- **Message edits and deletions made elsewhere are not reflected** — the pipeline does not collect them.
- Polish, not defects: on a narrow phone the attribution line under our own messages wraps into three
  short lines (the same meta line v1 uses); a quote preview shows the original's text without formatting.
  On first open the thread reaches the newest message once the conversation hydrates (within ~0.5 s,
  like v1's `ThreadScroller`).

## 10. Two different things: the feature flag and the migration

| | `CHAT_UI_V2` feature flag | Migration `20261016100000_outbound_reply_to` |
|---|---|---|
| What | A `ProjectFeature` key in the code catalogue | One nullable column `OutboundMessage.replyToMessageId` + index + FK (`ON DELETE SET NULL`) + same-project constraint trigger |
| Needs a migration | **No.** A missing row means the default, which is OFF | **Yes** — it IS the migration |
| Needed for | Showing v2 at all | Any code from this change (web or worker) to run: the regenerated Prisma client selects the column |
| Order | Switched on last, per project, by a Main Admin | After `20261015100000_project_role_sections`; applied before the new images start |

**Verified on a throwaway database** (all migrations from empty, in name order): the column, index, FK
and trigger exist; `projectIntegrity.integration.test.ts` passes with the trigger and **fails naming it**
when it is dropped.

**Old application compatibility.** The old web and worker never name the column: an old insert leaves it
NULL, old reads ignore it. So the migration can be applied while the old images still run.

**The reverse is NOT safe:** the new images against an unmigrated database fail — every outbound query
selects the new column (P2022 "column does not exist"), which would stop the outbound queue and break
WhatsApp Chat even with v2 off. The migration must complete before the new images start. Compose's
`depends_on: migrate (service_completed_successfully)` guarantees this only WITHOUT `--no-deps`; with
`--no-deps`, run `migrate` alone and wait for it to exit 0 first.

**Worker deployment is required** for quoted replies: an OLD worker ignores `replyToMessageId` and would
send a quoted reply as a plain message. So `CHAT_UI_V2` must not be switched on until the new worker
runs. Deploying the worker restarts it, which reconnects every WhatsApp session — an operator decision,
taken in a quiet window.

**Rollback without deleting data.** (1) Switch `CHAT_UI_V2` off — v1 everywhere, instantly, nothing
deleted. (2) If the images themselves must go back, the old images run fine on the migrated schema, so the
migration stays. (3) Only if the column itself must go: before any row sets it, drop trigger → FK → index
→ column; after rows set it, keep it (roll forward). No `Message` row is ever touched by any of this.

## 11. Rollout

1. Back up the database (restore-tested), as for every deploy.
2. `docker compose up --no-deps migrate` — wait for exit 0; confirm `20261016100000_outbound_reply_to`
   in `_prisma_migrations`.
3. `docker compose up -d --build --no-deps app` (web). v2 is off: the chat is v1, unchanged.
4. `docker compose up -d --build --no-deps worker` in a quiet window (sessions reconnect).
5. On an isolated TEST number and group, with `CHAT_UI_V2` on for a test project only: verify §6.
6. Switch `CHAT_UI_V2` on for a production project. Watch System Logs and outbound FAILED reasons.

## 12. Mobile-first polish (16 Oct 2026)

Presentation only. No server action, query, migration, queue contract, permission or provider call
changed; the polish lives in the v2 components and in additive, default-off props on four shared ones.

**What changed (v2 only).**
- **Bubbles.** Sent messages are a soft accent tint instead of a near-black block; 18 px radii with a
  small tail corner; long text, URLs and numbers wrap inside the bubble (`overflow-wrap: anywhere`);
  quotes carry an accent bar and author; status icons stay with their words; the meta line wraps
  phrase by phrase. Timestamps moved from the muted to the neutral foreground (light mode was 4.34 : 1,
  under AA; now 6.92 : 1).
- **Actions on a touch screen** (`v2/MessageActionSheet.tsx`). The reply / react / copy icons are no
  longer drawn beside every bubble on a touch screen (`pointer: coarse` → screen-reader-only). A long
  press (420 ms, cancelled by any movement over 8 px, never on a link, button, quote or media control)
  opens a bottom sheet with the quick reactions, Reply, Copy, and — for your own unsent message — Edit and
  send again / Cancel. With a mouse, a right click opens the same actions as a small menu at the pointer
  (unless text is selected, which keeps the browser's own menu); the hover / keyboard buttons are
  unchanged. It offers exactly what the inline buttons offered and calls the same handlers. Rendered
  through a portal (the page wrapper keeps a transform after its entrance animation, which would trap
  `position: fixed`); backdrop presses are ignored for 400 ms so lifting the finger cannot close it.
- **Header.** One row on a phone: 40 px back button, round avatar, a subline that truncates instead of
  wrapping to three lines.
- **Composer.** Pill input with a 16 px font (no iOS zoom on focus), 44 px round emoji / saved-reply /
  send buttons, safe-area bottom padding, the account line truncating, "Message" as the phone
  placeholder.
- **Keyboard.** On a phone the conversation publishes `visualViewport.height` as `--chat-dvh`; the chat
  layout's height uses it, falling back to `100dvh`, so the composer stays above the on-screen keyboard
  on Android Chrome and iOS Safari and a reader at the newest message stays there. Not while pinch-zoomed.
- **Thread.** A round jump-to-latest button at the thumb edge (a pill with the count when something is
  new), larger date chips, tighter grouping of a run.
- **Media viewer.** Horizontal swipe steps through images; 44 px controls; safe-area insets; the arrows
  are screen-reader-only on a touch screen.
- **List** (`data-v2` on the layout, `group-data-[v2]/chat:` variants): round 44 px avatars, a pressed
  state, an ellipsis on the search placeholder.

**Shared components, additive and off by default:** `AiActiveNotice compact`, `SavedReplyPicker quiet`,
the layout's `--chat-dvh` fallback and `data-v2` marker, the headers' `withSearch` (true only in v2).

**Verified** (isolated dev server + throwaway database, Chromium over CDP):
- 48 screenshots before and after (3 screens × 320 / 360 / 375 / 390 / 430 / 768 / 1024 / 1440 px ×
  light / dark): no page-level sideways scroll in either set.
- **Chat V1 is pixel-identical**: the pre-polish code was rebuilt from the checkpoint into a separate
  folder and served on another port; all 48 v1 screenshots compared pixel by pixel — 48 identical
  (the comparator itself reports 48 of 48 different between v1 and v2, so it can see a change).
- Touch, with Chromium reporting a real touch screen: 20 checks × 5 runs, all passing — short tap and
  scroll open nothing; long press opens the sheet (median ≈ 470 ms; up to ≈ 1.2 s when a dev-mode
  refresh re-render is running); Reply and a reaction from the sheet go through the real actions (one
  `REACT_TO_MESSAGE` row); quote / link presses stay theirs; Escape and backdrop close it; reduced motion
  collapses the animation; composer font and targets; keyboard simulation (layout follows the visible
  height, composer on screen, bottom and draft kept, restored on close); gallery swipe.
- Desktop: right-click menu at the pointer, inside the window; hover buttons keyboard-reachable.
- Contrast, computed in the page, both themes: every message text, label, quote and timestamp ≥ 4.5 : 1.
- The Phase 1 feature regression (15 checks: composer, quoted reply, mentions, reactions, search,
  paging across the timestamp tie, gallery, personal and LID chats, flag-off legacy view, two-project
  isolation, read-only role): 15 passed. Web chat / navigation / page-coverage / raw-SQL suites: 106 passed.

**Still needs a real device:** the keyboard on actual iOS Safari and Android Chrome (only simulated
here), long-press feel with a production build, and the haptic tick (`navigator.vibrate`, Android only).
