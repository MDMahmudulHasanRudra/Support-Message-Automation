# 02 — OpenWA capability matrix (what the provider can and cannot tell reporting)

Status: planning input for the unified-reporting upgrade. Read-only investigation. No source,
schema, test or config was changed. No phone number, message text or secret appears here.

## 1. Installed version

| Source | Value |
|---|---|
| `apps/worker/package.json` | `"@open-wa/wa-automate": "^4.76.0"` |
| `pnpm-lock.yaml` | resolved `@open-wa/wa-automate@4.76.0`, listed under `patchedDependencies` |
| `apps/worker/node_modules/@open-wa/wa-automate/package.json` | `"version": "4.76.0"` |
| Local patch | `patches/@open-wa__wa-automate@4.76.0.patch` (declared in `pnpm-workspace.yaml`) |

- **Version family:** v4.x, the last 4.x line. The patch touches only `dist/controllers/initializer.js`.
  It replaces the `window.Debug` wait, which current WhatsApp Web never satisfies (upstream #3346), with
  `typeof require !== "undefined"` and a 45 s timeout. The patch changes no message model and no API.
- **Docs mismatch:** `docs.openwa.dev` now redirects to `openwa.dev/docs`, which says it documents
  **v5** and tells readers to compare against the version they have installed. So the **installed
  4.76.0 type definitions are the authority** for this matrix (`dist/api/model/*.d.ts`,
  `dist/api/Client.d.ts`). The public docs only support it. Where a 4.76.0 declaration and WhatsApp
  Web's runtime behaviour differ, the codebase comments record what production actually showed. Those
  comments are cited, because they are the only evidence of runtime behaviour.
- **Runtime coupling:** OpenWA serialises WhatsApp Web's own in-page models. A WhatsApp Web build can
  add, rename or remove fields without any library release. This has already happened:
  `isGroupMsg`/`isGroup` disappeared on 8 Oct 2026 (`isGroupChatId` comment). Every field below is
  therefore at least weakly VERSION_DEPENDENT. The label is used explicitly only where the dependency
  has been observed or is declared.

### Classification key

- **SUPPORTED_AND_USED**: declared in 4.76.0 (or a public call), and read or called by `apps/worker/src`.
- **SUPPORTED_NOT_USED**: declared or public, and not used today.
- **VERSION_DEPENDENT**: works, but its presence or shape changes with the WhatsApp Web build or the
  read path (live versus history).
- **UNVERIFIED**: present only at runtime (undeclared), or its contract is unconfirmed on this deployment.
- **UNAVAILABLE**: needs a licence we do not hold (Insiders/restricted), or is impossible in principle.

## 2. Capability matrix

All code references are in `apps/worker/src/provider/openwa/` unless another path is given. `P` means
`OpenWAProvider.ts`.

### 2.1 Identity, ids and addressing

| Capability | Declared (4.76.0) | Class | Where used / notes |
|---|---|---|---|
| `Message.id` (`MessageId` = `` `${boolean}_${ChatId}_${string}` ``) | `message.d.ts`, `aliases.d.ts` | SUPPORTED_AND_USED, VERSION_DEPENDENT shape | `toRawIncomingMessage` → `whatsappMessageId` via `serializeMessageId` (`messageId.ts`). On the live path it is a string. On the history path (`getAllMessagesInChat`) a nested id can arrive as a **key object** `{fromMe, remote, id, participant, _serialized}`. `serializeMessageId` rebuilds it, adding a 4th `_participant` segment for groups. |
| `true_`/`false_` prefix | `MessageId` | SUPPORTED_AND_USED | The prefix is **per account**: the sending account sees `true_`, our other accounts see `false_`. It is not a global message key. Deduplication across accounts uses `logicalMessageKey`/`messageKeySql()` (`packages/shared/src/whatsappIdentity.ts`), never the raw id. |
| `chatId`, `from`, `to` | `message.d.ts` | SUPPORTED_AND_USED | `chatId` → `Message.chatId`. In a group `from` is the **group's** id, not the person's (P comment above `resolveMessageBody`). It is used only as the last fallback, and kept with `@g.us` so identity resolution reads it as `NOT_A_PERSON`. `to` is not used. |
| `author` | `author: string` (declared non-optional) | SUPPORTED_AND_USED, not reliably populated | `senderJid` for group messages: `author \|\| sender?.id \|\| from`. It can be empty, and it is often an `@lid`. |
| `sender` (`Contact`), `sender.id` | `message.d.ts`, `contact.d.ts` | SUPPORTED_AND_USED | Second witness for the group sender. `sender.pushname`/`formattedName` feed `senderName`. |
| `senderId?` | `message.d.ts` | SUPPORTED_NOT_USED | Optional and undocumented beyond "ID of the message sender". |
| `isGroupMsg` | declared `boolean` | VERSION_DEPENDENT (removed at runtime) | Honoured if set, but `isGroupChatId(chatId)` (`@g.us`) decides. Build 2.3000.1049703040 removed the getter, and it reads `undefined`. |
| `fromMe` | `message.d.ts` | SUPPORTED_AND_USED | `direction` OUTGOING/INCOMING. It also gates ack recording. It says "sent by this account's session". It does **not** say which person or device typed the message. |
| `@lid` vs `@c.us` | **not modelled**: `ContactId` is typed `` `${number}@c.us` `` only | VERSION_DEPENDENT / runtime only | `senderJid` keeps the domain (`Message.senderJid`), and `senderPhone` = `stripJidDomain` (also drops the `:device` suffix). `verifyPersonalChat` accepts `@c.us\|@lid`. The store sweep accepts `@g.us\|@c.us\|@lid`. 4.76.0 declares **no LID↔phone call**. |
| `notifyName`, `pushname`, `formattedName` | `message.d.ts`, `contact.d.ts` | SUPPORTED_AND_USED | `senderName = sender.pushname \|\| notifyName \|\| sender.formattedName`. These are self-chosen display names: never identity, often absent, and `formattedName` is often the number itself. |
| Host identity: `getHostNumber`, `getMe` | `Client.d.ts` | SUPPORTED_AND_USED | `getAccountInfo` (P). |

### 2.2 Time, type, content, media

| Capability | Declared | Class | Where used / notes |
|---|---|---|---|
| `timestamp` / `t` (seconds) | both declared | SUPPORTED_AND_USED, VERSION_DEPENDENT | `messageTime`: `timestamp ?? t`. With neither, the time is invalid and the message is **not stored**, so no receive time is ever invented (WHATSAPP_IDENTITY.md §9). |
| `type` (`MessageTypes` enum + raw strings) | enum: chat, audio, ptt, image, video, document, sticker, location, vcard, multi_vcard, revoked, order, buttons_response, list_response, unknown | SUPPORTED_AND_USED, VERSION_DEPENDENT | `resolveMessageBody`, `MEDIA_TYPES`, `NON_CONTENT_TYPES` (gp2, notification*, e2e_notification, call_log, protocol, pinned_message…). `ptv`, `poll_creation` and `ciphertext` are runtime strings that are **not in the enum**. |
| `body`, `caption`, `filename`, `isMedia`, `isNotification` | declared | SUPPORTED_AND_USED | A media `body` is a base64 preview, never text. A vCard body is never stored, because it carries a phone number. |
| `mimetype`, `filehash`, `duration`, `isAnimated`, `deprecatedMms3Url`, `clientUrl` | declared | SUPPORTED_AND_USED | `toMediaDescriptor` / `toMediaDownloadInfo`. |
| `mediaKey`, `size`, `directPath`, `encFilehash`, `width`, `height`, `isGif` | **not declared** | UNVERIFIED (runtime-present) | Read through the local `WaMediaFields` interface (P). The comment says they are present at runtime and are what `@open-wa/wa-decrypt` reads. With no `mediaKey` there is no download info. |
| `ciphertext` (undecrypted) | not declared | SUPPORTED_AND_USED (runtime) | `isStillEncrypted` → `awaitDecryption` re-reads through `getMessageById` on a 15 s → 1 h schedule. When the message is finally read it is handed over `deliveredLate`. Each one is counted (`recordCollection`). |
| `lat`, `lng`, `loc`, `pollOptions` | declared | SUPPORTED_AND_USED | `toRichContent`. `pollName` and `pollSelectableOptionsCount` are undeclared and read defensively. |
| `isForwarded`, `star`, `broadcast`, `isViewOnce`, `labels` | declared | SUPPORTED_NOT_USED for reporting | Forward and star are written through `forwardMessages`/`starMessage` (Chat v2). They are not read from incoming payloads. |

### 2.3 Quotes and mentions

| Capability | Declared | Class | Where used / notes |
|---|---|---|---|
| `isQuotedMsgAvailable` | declared | SUPPORTED_AND_USED | Gate for the quote. **If false, the quote is lost** even when the message really is a reply, because the quoted message is not loaded in WhatsApp Web. |
| `quotedMsg?: Message` | declared | SUPPORTED_AND_USED, VERSION_DEPENDENT shape | `quotedWhatsappMessageId = serializeMessageId(quotedMsg?.id)`. Live gives a string id. History gives a key object (`messageId.ts`: 29 of 706 quoted replies were dropped before normalisation). |
| `quotedMsgObj?`, `quoteMap` | declared | SUPPORTED_NOT_USED | `quoteMap` can walk a quote chain. |
| `quotedStanzaID`, `quotedParticipant` | **not declared in 4.76.0** | UNVERIFIED | Not used. They may exist as raw WhatsApp Web attributes, but they are not a library contract. |
| `quotedRemoteJid`, `quotedParentGroupJid` | declared (group-join requests) | SUPPORTED_NOT_USED | Not a reply signal. |
| `mentionedJidList: ContactId[]` | declared | SUPPORTED_AND_USED | `mentionedPhones` = the part before `@`. **The domain is dropped**, so a mentioned LID and a mentioned phone number look alike in `Message.mentionedPhones`. |
| Resolution to our row | — | USED (pipeline) | `processIncomingMessage.ts` ~L566 and `messageUpdates.ts` ~L156 look up `(accountId, whatsappMessageId)` → `Message.quotedMessageId`. **The lookup is scoped to the same account**, and it is null when the quoted message predates tracking. |

### 2.4 Receipts, deletions, edits, reactions

| Capability | Declared | Class | Where used / notes |
|---|---|---|---|
| `ack` (`MessageAck` −1…4) and `onAck` | declared, public | SUPPORTED_AND_USED | `attachUpdateListeners` handles **`fromMe` only**, and `recordableAckLevel` → `ackLevel`/`deliveredAt`/`readAt`/`playedAt` (receipts only rise). In a group, the ack is an aggregate and does not name who read the message. |
| `getMessageInfo` (per-recipient delivery/read) | `{@license:insiders@}` | UNAVAILABLE | — |
| `getMessageReaders` | public | SUPPORTED_NOT_USED, VERSION_DEPENDENT | Fails if read receipts are disabled. It would expose individual readers, so it needs a privacy decision before any use. |
| `onMessageDeleted`, `type === "revoked"` | public, enum `REVOKED` | SUPPORTED_AND_USED, UNVERIFIED delivery | Sets `revokedAt` and keeps the row. The code comment says firing "cannot be checked offline", so the history and catch-up paths also detect `revoked`. |
| Receive-side edits (edited body / latest edit key) | **no field and no event in 4.76.0** | UNAVAILABLE (as a contract) | `editMessage` (send-side) is used for **our own** sends (P `editMessage`). An incoming edit arrives at most as a `protocol` message, which is deliberately dropped (`NON_CONTENT_TYPES`). The stored body is the **original** text. |
| `onReaction` | `{@license:insiders@}` | UNAVAILABLE | Not wired. `Message.reactions[]`/`reactionByMe` are declared, but they are populated in-page, and others' reactions are not relied on (CLAUDE.md: Insiders licence). `react()` (send) is used for this account's own reactions only (`reactToMessage`). |
| `onPollVote`, `getPollData` | public | SUPPORTED_NOT_USED | Polls are sent (`sendPoll`) and the poll message is stored. Votes are not collected. |

### 2.5 Groups

| Capability | Declared | Class | Where used / notes |
|---|---|---|---|
| `getGroupMembers` → `Contact[]` | public | SUPPORTED_AND_USED | `getGroupParticipants` (P): `rawId` keeps its domain (LID or `c.us`). `isAdmin: null` because contacts carry no admin flag. |
| `getGroupAdmins` | public | SUPPORTED_AND_USED | `getGroupAdminIds`, used by Groups Admin Maker. |
| `getGroupMembersId`, `getGroupInfo` (`Promise<any>`, title and description) | public | SUPPORTED_NOT_USED | `getGroupInfo` is untyped. |
| `GroupMetadata.participants[]` (`isAdmin`, `isSuperAdmin`), `owner`, `creation` | `group-metadata.d.ts` | SUPPORTED_NOT_USED | Reachable through `Chat.groupMetadata`. Not read today. |
| Group list | `getAllGroups` / `getAllChats` | SUPPORTED_AND_USED + in-page | A lean `getPage().evaluate` over `Store.Chat` (`readGroupChats`, `readActivePersonalChats`), with the public call as fallback. |
| `onGlobalParticipantsChanged`, `onParticipantsChanged`, `onGroupChange` | public | SUPPORTED_NOT_USED | Membership history is not recorded live. |
| `onAddedToGroup`, `onRemovedFromGroup` | Insiders-tagged in the 4.76.0 JSDoc | UNAVAILABLE | — |

### 2.6 History retrieval

| Capability | Declared | Class | Where used / notes |
|---|---|---|---|
| `getAllMessagesInChat(chatId, includeMe, includeNotifications)` | public. The docs say it "does not load every single message" | SUPPORTED_AND_USED | Catch-up (`probeCollection`), Chat v2 "load earlier" and the personal backfill (`readChatHistory`). It returns only what WhatsApp Web holds. |
| `loadEarlierMessages(contactId)` | public, about 50 per call | SUPPORTED_AND_USED | `loadEarlierMessages`/`readChatHistory`, bounded by `HISTORY_LOAD_TIMEOUT_MS` (60 s). History is stored **store-only** (`storeHistoryMessages`). |
| `loadAllEarlierMessages`, `loadAndGetAllMessagesInChat` | public | SUPPORTED_NOT_USED | Unbounded. Deliberately avoided. |
| `getMessageById` | public | SUPPORTED_AND_USED | `readDecrypted`, `readMessagesById` (store sweep), `getMediaDownloadInfo`. |
| In-page `Store.Msg` id/time enumeration | **not a library API** | UNVERIFIED (internal store) | `listStoreMessageRefs` reads only `id._serialized`, `id.remote` and `t`. The full message is then read through the public `getMessageById`. It depends on the build, so it returns `null` when the store is missing. |

### 2.7 Session lifecycle and device

| Capability | Declared | Class | Where used / notes |
|---|---|---|---|
| `onStateChanged(STATE)` | public | SUPPORTED_AND_USED | P ~L1522 → `mapLibraryState`. |
| `kill`, `logout(preserveSessionData)` | public. `logout` warns it "can exit the whole process" | SUPPORTED_AND_USED | Both are wrapped in `withTimeout` (P ~L1564, ~L1587). |
| `onLogout` | public | SUPPORTED_NOT_USED | — |
| `getConnectionState`, `healthCheck`, `isPhoneDisconnected` | public | SUPPORTED_NOT_USED | Health is checked in-page instead (`Store.Chat` presence, `checkSessionHealth`). |
| `getWAVersion`, `getSessionInfo`, `getLicenseType` | public | SUPPORTED_NOT_USED | Useful for **recording the WhatsApp Web build** next to collection health (see §4). |
| Linked-device metadata (which phone or desktop sent an outgoing message) | not modelled. A JID `:device` suffix exists at runtime | UNAVAILABLE for attribution | `stripJidDomain` drops `:N`. The device index identifies a device slot, not a person. |
| `onBattery`, `onPlugged` | public, legacy | UNAVAILABLE in practice | Pre-multi-device. |

### 2.8 Sending (for completeness: provenance of OUTGOING rows)

| Capability | Class | Where used |
|---|---|---|
| `sendText`, `sendTextWithMentions` (no licence), `reply(to, content, quotedMsgId)` | SUPPORTED_AND_USED | `sendMessage` (P ~L2415). Mentions are used only when non-empty, and reply together with mentions is refused. |
| `sendPoll`, `sendLocation` (address/url are Insiders), `sendRawWebpAsSticker`, `forwardMessages`, `starMessage`, `pinMessage`, `editMessage`, `react` | SUPPORTED_AND_USED (Chat v2) | P ~L2816–2890. `sendImageAsSticker` is never used (it uploads to a third party). |
| `sendText` to a **new** number | `{@license:restricted@}` | UNAVAILABLE. Sends go only into existing chats (`verifyPersonalChat`). |

## 3. Fields that are not consistently populated

1. **`author`** can be empty or an `@lid`. `sender.id` is the fallback. When neither is set, `from` is
   the group id, which is stored as `NOT_A_PERSON`, never as a customer phone.
2. **`isGroupMsg` / `isGroup`** are `undefined` on current builds. Use the `@g.us` domain.
3. **Quoted message** is null whenever `isQuotedMsgAvailable` is false (the quoted message is not
   loaded in the page). Its id arrives as a key object on history reads. `quotedStanzaID` is not part of
   the 4.76.0 contract.
4. **`timestamp`** can be missing (then `t`). With neither, the message is not stored at all.
5. **`ciphertext`** messages have no body until WhatsApp Web decrypts them in place. No event fires
   when that happens. They are covered by bounded re-reads, and the remainder are counted as given up.
6. **Media fields** (`mediaKey`, `size`, `directPath`) are undeclared. Their absence means "cannot
   download", not "no media".
7. **Display names** (`notifyName`/`pushname`) are user-chosen and often missing. They are never identity.
8. **`chat`** is not always attached on history reads, so `groupName` can be null.
9. **Ack** is recorded only for `fromMe`. In groups it is an aggregate, never "who read".
10. **Deletions** depend on `onMessageDeleted` actually firing, and history reads are the backstop.
11. **Edits** are invisible: reporting sees the original text only.

**Privacy rule (binding for this project):** do not use undocumented store access (`Store.Lid`,
`Store.Contact` internals, `WidFactory` and similar) to turn a LID into a phone number. Neither does
the codebase: `listStoreMessageRefs` reads only ids and times from `Store.Msg`, and the lean chat
reads only id, name and time. A LID is a privacy boundary WhatsApp chose to draw. CLAUDE.md is
explicit: "No LID→phone table exists… add one only when a provider supplies it." Collect only what a
report needs. Do not store `sender` contact objects, profile pictures, vCard bodies, per-reader receipt
lists or the `quoteMap` text.

## 4. Implications for reporting

### What customer-specific reply attribution CAN rely on

- **An explicit quote:** `Message.quotedMessageId` is set when a team member's (or the business
  number's) message quotes a customer message that is stored **on the same account**. This is the
  strongest signal: WhatsApp itself recorded the "reply to X" intent. For Chat v2 sends,
  `OutboundMessage.replyToMessageId` is the intent, and the echo's `quotedMessageId` is the proof.
- **Mentions:** `Message.mentionedPhones` lists who a message tagged. A mention of a customer is a
  medium-strength signal. Because the domain is stripped, a mentioned id must be compared with the
  customer's `senderPhone` **and** `senderJid` digits together, never assumed to be a phone number.
- **Sender identity:** `senderJid` (domain kept) plus `createSenderResolver` (`whatsappIdentity.ts`)
  decides which roster member wrote a message, at read time. `CONFLICT`/`AMBIGUOUS` credit nobody.
- **Ordering:** `timestampWa` is WhatsApp's send time. Order by `(timestampWa, id)`, never by arrival order.
- **Provenance of outgoing rows:** `OutboundMessage` (AI, RULE, BROADCAST, OPERATOR with
  `createdById`) matched by `providerMessageId`. An outgoing row with no outbound match is
  `BUSINESS_PHONE`.
- **The logical message key** (`logicalMessageKey`) collapses the `true_`/`false_` copies held by
  several accounts.

### What CANNOT be known

- **Which human held the business phone.** `fromMe` with no `OutboundMessage` means "typed on the
  phone or a linked device of this number". The library has no per-person signal, and the device
  suffix names a slot, not a person. Report these as `BUSINESS_PHONE` (unattributed). Never guess
  them from shift rosters.
- **Others' reactions** (`onReaction` is Insiders) and **per-reader group receipts**
  (`getMessageInfo` is Insiders). A 👍 that answered a customer is invisible.
- **Edits** made after sending. Only the original text is known.
- **A LID's phone number**, unless the person was added to the roster with a typed number.
- **Messages never delivered to the linked device** (phone offline, encryption never resolved, sent
  before the link). The store sweep, catch-up and backfill cannot recover what WhatsApp Web never
  received. `CollectionGap` and the undecrypted counters are the only honest record of these.
- **A quote whose target is not loaded** (`isQuotedMsgAvailable: false`) or is not stored on the same
  account. The reply exists, and the link to its customer is lost.
- **Calls.** No call records exist (see the inferred Call Activity report).

### Recommendations

1. **Attribution confidence ladder:** explicit quote (HIGH) → mention of the waiting customer (MEDIUM)
   → temporal adjacency in the same group with one open waiting customer (LOW, labelled "inferred")
   → otherwise unattributed. Expose the tier on every figure, as Support Intelligence already does.
2. **Resolve quotes across accounts at read time, not in the pipeline.** Map the quoted id to the
   logical key (chat + stanza part of the id, ignoring the `true_`/`false_` prefix and participant
   suffix) so that a quote whose target was stored only on another of our accounts still links. Keep
   the pipeline's same-account `quotedMessageId` untouched as the strict signal.
3. **Count the unknowns.** Add counters (not rows) for "reply had a quote flag but no resolvable
   target" and "quote not available", beside the existing `collectionByKind` counters, so a report can
   state how much attribution was impossible.
4. **Record the WhatsApp Web build** (`getWAVersion`) on gap or health records. Field disappearances
   (`isGroupMsg`) are build events, and reports should be able to correlate a shape change with a date.
5. **Do not adopt Insiders-only or undocumented store calls** for reporting. Do not add
   `getMessageReaders` without an explicit privacy decision.
6. **Keep history store-only.** Anything a report backfills goes through `storeHistoryMessages`, never
   `persistIncomingMessage`.
7. **Pin the matrix to the version.** Any upgrade to v5 (which the official docs now cover) needs this
   matrix re-derived from the new `.d.ts` files before reporting logic depends on a field.
