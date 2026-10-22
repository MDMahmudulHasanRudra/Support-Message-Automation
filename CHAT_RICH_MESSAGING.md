# Chat v2 rich messaging — receipts, deletions, history, polls, locations, stickers, forward, star, pin, archive

Built 16 Oct 2026 on the current engine (`@open-wa/wa-automate` 4.76), with no licence and no new
dependency. It all lives in Chat v2, behind the existing `CHAT_UI_V2` project feature, which is
**off by default**. Every send goes through the one outbound queue; every live phone action is a
`WorkerCommand`. The engine choice is in `docs/OPENWA_PARITY_PLAN.md`.

## 1. Ground rules

- **Facts only.** A tick is an ack WhatsApp reported. A deletion is WhatsApp saying "revoked". A
  poll is the poll WhatsApp delivered.
  - Silence is never read as a state: no receipt means "not reported", never "not delivered".
- **One send path.** A poll, location, sticker or forward is ONE `OutboundMessage` row:
  - `actionType: MANUAL_REPLY`;
  - `contentType` POLL / LOCATION / STICKER / FORWARD;
  - its own `content`;
  - `body` holding the readable summary.

  It passes the same kill-switch rule, rate limits, live membership / personal-chat check and
  idempotency as typed text. The worker sends a non-TEXT row **only** for a MANUAL_REPLY, and
  refuses it with a quote or tags.
- **Re-checked at send time.** The worker re-validates the content and re-reads what the row names:
  - the sticker must be a stored WebP of this project (`isSendableSticker`);
  - the forward source must be a stored, undeleted message of the same account (`forwardRefusal`).

  An invalid row is FAILED at once and never retried.
- **Nothing new with the feature off.** Every action in `server/actions/chatRich.ts` refuses
  unless `CHAT_UI_V2` is on, and checks its own permission:
  - sends, stars, pin and archive need `messages.reply`;
  - loading history and reading a command's state need `messages.view`.

## 2. Delivery and read receipts

- **Listener.** `OpenWAProvider` attaches `onAck` (public) to each new client, gated on client
  identity like the message listener, so a reconnect re-wires it. Only `fromMe` messages are
  recorded.
- **Columns** (`Message`): `ackLevel` (1 sent, 2 delivered, 3 read, 4 played), plus `deliveredAt`,
  `readAt` and `playedAt`.
- **Rule** (`applyAck`, `packages/shared/src/chatRichMessages.ts`):
  - the level only rises;
  - each time is written once;
  - reaching a level implies the ones below it.
- **How it is written.** `recordMessageAck` applies the rule as conditional `updateMany`s:
  - the level when `ackLevel IS NULL OR < level`;
  - each time when it is still NULL.

  So racing acks cannot lower the level or rewrite a time. Only OUTGOING rows of that account are
  touched.
- **First tick.** Our own echo carries its first ack, stored on insert (`initialMessageColumns`).
- **Display.** One tick = sent, two = delivered, blue = read. In a group, 2 and 3 mean every
  participant ("Read by everyone"). Rows from before this change show one tick, as before.

## 3. Deleted for everyone

- **How it is noticed.** Two ways:
  - `onMessageDeleted` (public);
  - any message that later arrives as type `revoked` — through the live listener, a catch-up sweep
    or a history load.
- **What it does.** It sets `Message.revokedAt` once. **The row and its text are kept**: what was
  said stays on the record, and the thread marks it "Deleted for everyone on WhatsApp — the text
  below is what was received/sent".
- **What it never does.** A revoked event is never stored as a message of its own, and never
  counted as a dropped message.
- **Who deleted it.** WhatsApp does not say (a group admin can delete others' messages), so the
  thread never names anyone.
- **Lab check needed.** Whether `onMessageDeleted` fires depends on the library's runtime patch,
  which is obfuscated and could not be checked offline. The revoked-type path is the fallback.

## 4. Load earlier from WhatsApp

- **The button.** It appears at the top of a v2 thread once the stored history is exhausted.
- **The command.** `LOAD_EARLIER_MESSAGES` (payload `{ chatId }`), handled in this order:
  1. `loadEarlierMessages` asks the phone for one more page (about 50);
  2. `getAllMessagesInChat` reads everything the session holds for that chat;
  3. `storeHistoryMessages` writes what is new.

  Each call is bounded at 60 s. A second press while one runs joins it.
- **Store-only, on purpose.** A loaded message can be months old, so it runs no rules, AI, waits
  (SupportResponseEpisode), Support Assignment cases, escalation, mood or support activity.
  - It is stored IGNORED (customer) or PROCESSED (ours), with `loadedFromHistoryAt` set.
  - Its attachment is registered, and the sender's attendance for that day is recomputed (a
    recompute, so it converges).
  - `ProcessingCheckpoint` is not moved.
  - The test runs with response tracking ON, and a control case proves the catch-up path WOULD
    open a wait for the same message.
- **Deduplication.** By `@@unique([accountId, whatsappMessageId])`. Only that chat's messages, and
  only for a group or personal chat. A stored message the page shows as revoked is marked deleted.
- **Display.** These messages carry a history icon and "loaded from WhatsApp history on request"
  in their time tooltip.

## 5. Polls, locations, stickers, forwards (composer and message menu)

- **Poll** (groups only — WhatsApp's own rule). `validatePoll`:
  - question ≤ 255 characters;
  - 2–12 options, each ≤ 100, different from each other;
  - optional multiple answers.

  Sent with `sendPoll`. Votes are counted on WhatsApp; this connection does not collect them, so
  none are shown. A received poll is stored as `[Poll] <question>` with its options in
  `richContent`. `isMediaOnlyBody` treats every poll as having nothing for the AI to answer.
- **Location.** Typed or pasted (`parseCoordinates`: "lat, lng", Google Maps `@`/`q=`/`query=`, OSM
  `mlat`/`mlon`). A short link carries no coordinates and is never fetched. `validateLocation`
  refuses 0,0. Sent with `sendLocation` (name only: address/url are licence-only parameters). A
  received location is `[Location] <name>` plus its coordinates, with its map preview never stored
  as text.
- **Sticker.** Only stickers already stored in this project's media storage are offered, one per
  file: WebP, STORED, ≤ 1 MB. They are sent as-is with `sendRawWebpAsSticker`.
  - **Never `sendImageAsSticker`**: it uploads the image to the library's own conversion server, and
    a customer's picture must never leave this deployment.
- **Forward.** From a message's menu, to ONE other conversation of the same account. A broadcast
  has its own page and throttles. The source must belong to that account and not be deleted. Sent
  with `forwardMessages`.

## 6. Star, and pin / archive on the phone

- **Star.** `STAR_MESSAGE` → `starMessage` / `unstarMessage`. `Message.starredAt` is written only
  after WhatsApp accepted it, and only on the command's own account.
- **Pin / archive.** `PIN_CHAT` / `ARCHIVE_CHAT`, from the v2 header's "⋮" menu. They change the
  **phone**, not the inbox: the inbox's own pin and archive stay as they were, and neither ever
  changes monitoring or AI.
  - The library answers `false` for "already in that state", which is reported as such.
  - WhatsApp allows three pinned chats.

## 7. Files

| Layer | Files |
|---|---|
| Rules | `packages/shared/src/chatRichMessages.ts`; `mediaPlaceholders.ts` / `messageMedia.ts` (the `[Poll]` label) |
| Schema | `Message` receipt / revoked / starred / richContent / loadedFromHistoryAt columns; `OutboundMessage.contentType` + `content`; four `WorkerCommandType`s. Migrations `20261016130000_chat_rich_commands`, `20261016130100_chat_rich_messaging` — additive, nullable or constant default |
| Worker | `provider/openwa/OpenWAProvider.ts` (conversion, listeners, actions); `provider/WhatsAppProvider.ts` (optional methods); `pipeline/messageUpdates.ts`; `pipeline/processIncomingMessage.ts` (revoked, initial columns); `queue/outboundQueueProcessor.ts` (`sendRichContent`); `commands/commandProcessor.ts` |
| Web | `server/actions/chatRich.ts`; `server/chatInbox.ts` (entry fields); `chat/v2/RichComposer.tsx`, `RichContentViews.tsx`, `ForwardDialog.tsx`, `PhoneChatMenu.tsx`; bubble, action sheet, conversation, composer and both page headers |

## 8. Verification (16 Oct 2026)

**Tests:**
- shared `chatRichMessages.test.ts` (15);
- worker `richMessageConversion.test.ts` (7) and `richMessaging.integration.test.ts` (21);
- web `chatRich.integration.test.ts` (12).

**Each protection was confirmed to fail first.** Fourteen worker mutations and eight dashboard
mutations each turned a test red:
- history through the pipeline;
- receipts not monotonic, rewriting a time, or touching incoming rows;
- deletion rewriting its time;
- pipeline ignoring revoked;
- no echo / incoming columns;
- rich sends for automation;
- no poll validation;
- forward from any account;
- sticker of any status;
- star before accepted or on any account;
- no feature gate;
- poll to a person;
- no dedupe for star or load;
- reading any command;
- no send-target check;
- the thread dropping rich content.

**Not verified: a live WhatsApp account.** Nothing here was run against a real phone. Before
switching `CHAT_UI_V2` on for customers, check each on a lab number:
1. two ticks, then blue;
2. a deletion marked (and whether `onMessageDeleted` fires);
3. "Load earlier" on a long chat;
4. a poll, a location, a stored sticker and a forward arriving correctly;
5. a received poll and location rendering;
6. star, pin and archive visible on the phone.

## 9. Rollback

- Switch `CHAT_UI_V2` off for the project. Every action refuses and v1 renders exactly as before.
- Receipts and deletions keep being recorded: they are columns nothing else reads.
- The migrations are additive, so roll forward. Dropping the columns is safe only before rows use
  them (see each migration's header).
