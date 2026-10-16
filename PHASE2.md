# Phase 2 — WhatsApp backend, sync, collection, identity and reporting

Builds on Phase 1 (`CHAT_UI_V2.md`), which stays uncommitted in the same working tree and was backed up
before any Phase 2 change. Reference: rmyndharis/OpenWA@`078b8aa458584762b9dee6d6e83fc42680fa14e5`
(MIT; patterns only — `docs/third-party/OPENWA_REFERENCE.md`). Nothing here is deployed.

## Stage 0 — what already exists, and the real gaps

The existing worker is far more mature than the brief assumed: `GROUP_SYNC.md` §2–§10 and
`INCIDENT_RUNBOOK.md` describe connect, discovery, recovery and collection logic that is already
mutation-tested. Phase 2 therefore targets the gaps below rather than rebuilding those.

| Area | Existing implementation | OpenWA reference | Gap | Phase 2 change | Risk |
|---|---|---|---|---|---|
| QR / link lifecycle | Progress-watched link load (IndexedDB growth, 10 min stall / 45 min cap), resumable accepted scans, orphan-browser kill, busy-vs-dead health check, sequential connects, `connectionStage` | State machine, reconnect budget with jitter, rebind rejection | None material; state is `status` + `connectionStage` + `groupSync*` | Keep. Connection readiness and group completeness are already separate columns | — |
| Automatic group discovery | Arrival passes every 30 s after every connect, settle on 3 passes with nothing new, then FULL sync; FOLLOW re-reads for 24 h | Engine `getGroups` | **Status says COMPLETED for "observed stable"** — the provider has no completion signal | Record and show the *basis*: stable across N reads vs a single read; never "verified complete" (Stage 2) | Low |
| Partial-list protection | 10 % sweep guard, empty list refused, checked reads (`hasLiveClient` before/after), ADD_ONLY passes never deactivate | — | None | Keep | — |
| Durable sync coordination | Per-account generation + in-flight map, cancellation, RETRY/VERIFY/FOLLOW recovery loop reading need from the DB, load deferral | Queue-based | Job *history* only in System Logs | Keep (one worker process owns the browser; a DB job table would add no correctness) | — |
| Message collection | Push listener re-attached on every connect, dedup by `(accountId, whatsappMessageId)`, stranded-row recovery, drop counter, watchdog probe | Persist-before-ack ingress table | **Catch-up covers groups only** — a personal message that arrives while the worker is down is lost | Catch-up reads active personal chats too (Stage 4) | Low |
| Historical recovery | 12 h bounded sweep from `ProcessingCheckpoint`, 15 min automation window, `CollectionGap` RECOVERED/PARTIAL/FAILED/NOT_ATTEMPTED | Live history endpoint | Personal chats (above) | Stage 4 | Low |
| Edits / deletions | Not captured (`WHATSAPP_IDENTITY.md` §9) | Revoke/edit events | `onMessageDeleted` and `onAck` are public in wa-automate 4.76 | Deferred — needs a lab number to see what the events carry | — |
| Identity | One resolver (exact WhatsApp id, digits-only phone, CONFLICT/AMBIGUOUS credit nobody), `senderJid` kept, reconcile script | `lid_mappings` learned from the engine | **No LID→phone source exists in this provider.** Attribution ignores when a person joined the roster | Provider-limited mapping documented; optional per-member "attribute from" date (Stage 5) | Low |
| Messaging capabilities | Phase 1: quote, mentions, own reactions | Wide | Inventory only | `CAPABILITIES.md`-style table in this file (Stage 6) | — |
| Team Report accuracy | One pure `computeTeamReport`, logical-message dedup, Team membership history | — | **Any business-number message closes a wait** (AI, rule, broadcast alike); a run of customer lines split by a period boundary counts twice; no data-quality figures | Reply provenance (human / AI / rule / broadcast / unattributed), first *human* response beside the existing figures, boundary context, reliability panel (Stage 7) | Medium — additive figures only |
| Redis / queues | All queues are PostgreSQL rows claimed with conditional updates; one worker | BullMQ / Redis | No measured need | Not added; reasoning in Stage 8 | — |
| Real-time | 4 s visibility-aware poll | WebSocket | Unchanged from Phase 1 | Not added | — |

## Stage 2 — group discovery: say what "completed" rests on

WhatsApp gives no signal that a group list is complete, so a COMPLETED status can only ever mean
"what the evidence showed". `WhatsAppAccount.groupSyncBasis` (migration
`20261016110000_group_sync_basis`, one nullable column, additive) records that evidence beside
COMPLETED / PARTIAL, and Accounts and Groups print it after the count, with the caveat on hover:

| Basis | Written by | Meaning shown |
|---|---|---|
| `STABLE_READS` | the FULL sync the arrival passes start once three reads found nothing new | list stable across consecutive reads |
| `WINDOW_ENDED` | the FULL sync started when the 20-minute arrival window ran out | list had not settled when the arrival window ended — later groups are still added |
| `SINGLE_READ` | a manual resync, the first sync of a new account, the 15-minute follow-up | one read of the list |
| `KNOWN_GROUPS_PRESENT` | the recovery loop's RETRY once no active group is missing | every group recorded as active was listed |

RUNNING, FAILED, CANCELLED and a disconnect's PARTIAL clear it, so the column never carries an older
answer. No status value, count or loop changed. `packages/shared/src/groupSyncBasis.ts` holds the
labels; its test refuses any label claiming "verified", "complete", "100 %" or "all groups".

Verified on a throwaway PostgreSQL (tmpfs, `127.0.0.1:5434`, no volume): `groupRecovery` (38) and
`groupSyncPipeline` (16) pass. Each of four mutations fails a test — the basis ignored, a single read
called stable, the recovery's PARTIAL given a basis, the recovery's COMPLETED given none.

## Stage 4 — personal chats are recovered after a gap

The live path stores one-to-one messages, but the gap sweep, the 10-minute reconcile loop and the
watchdog probe read groups only, so a customer who wrote to the number directly while the worker was
restarting was lost for good. `probeCollection` now also lists one-to-one chats active since the gap
began (an in-page read of ids and activity times only, `getAllChats()` as the fallback, one read per
session at a time) and reads them exactly as it reads groups. One rule decides what is read,
`selectCatchUpChats` (`packages/shared/src/whatsappChats.ts`): `@g.us`, `@c.us` and `@lid` chats
touched after the gap began, most recently active first; status, channels and broadcast lists never.
The inbox's `isPersonalChatId` is now that same function, re-exported.

Unchanged: the 12-hour reach, the 15-minute automation window (an older recovered message is stored
without rules), the 2,000-message cap, dedup on `(accountId, whatsappMessageId)`, and the watchdog's
judgement (its "newest stored message" already counted personal messages).

New: a read that answered but could not check everything — the personal-chat list, or a chat whose
history would not load — returns `incomplete`, and the gap is recorded PARTIAL with that reason
instead of RECOVERED. Before this, a chat skipped on a read error still produced RECOVERED.

Tests: `whatsappChats.test.ts` (5), `collectionProbe.test.ts` (+3), `personalCatchUp.integration.test.ts`
(4: stored under its own chat with no group, old one stored without rules, recent one through the
pipeline, a replay stored once, PARTIAL with every reason). Mutations caught: groups only, a silent
personal-list failure, a silent unreadable chat, an incomplete read called RECOVERED, status chats
selected. Watchdog, reconcile and gap suites unchanged and passing (36 + 13).

Not verifiable without a lab number: that WhatsApp Web's chat store exposes `t` on one-to-one chats
the way it does on groups (the code falls back to `toJSON().t`, then to `getAllChats()`).

## Stage 7 — Team Report: who answered, the human response, and reliability

No existing figure changed meaning. A wait still ends at the first reply of any kind; what is new sits
beside the figures (`packages/shared/src/teamReportReliability.ts`, the loader, a page section and an
Excel sheet).

**Reply provenance (Workstream H §12.2).** An outgoing message is classified from the
`OutboundMessage` it echoes (`providerMessageId = whatsappMessageId`), never from direction alone —
one rule, `outgoingActorFor`, now shared by the Team Report and Support Intelligence:

| Category | Evidence |
|---|---|
| CUSTOMER | incoming, nobody on the roster |
| HUMAN_TEAM_MEMBER | a roster member on their own WhatsApp, or a MANUAL_REPLY a signed-in user sent |
| AUTOMATED_AI | AUTO_REPLY with no rule (the AI fallback, its holding reply and handover mention) |
| AUTOMATED_RULE | AUTO_REPLY with a rule |
| OTHER_BUSINESS_REPLY | a broadcast, or an outgoing message that echoes no send (typed on the phone, or a worker alert — `Notification` keeps no WhatsApp id) |
| UNKNOWN_OR_UNATTRIBUTED | stamped as staff, but the roster names nobody (CONFLICT, AMBIGUOUS, former member) |

**Three response measures, each defined once (§12.3).**
- *First observed response* — the Team Report's own wait; any reply ends it. Computed with Response
  SLA's `responseStats`, so the two pages agree. Adds unanswered and pending group counts.
- *Automated response* — the waits whose closing reply was the AI or a rule, with median and p90.
- *First human response* — Human Response SLA's `humanWaits` (only a person ends it, a closing remark
  opens none), over the same groups as the waits; its time is measured to a verified person
  (HUMAN_TEAM_MEMBER), and waits ended by the business phone or unidentified staff are counted apart.

**Boundaries (§12.5).** The loader also reads the 4 hours before the period (Support Intelligence's
look-back) and each group's last message before that (one index probe per group). They are context
only — never counted — so a customer line after midnight that continues an open wait is not a second
wait, and a month's waits equal the sum of its days'. Before this, such a line counted on both days.
`TeamReportData.messages` (what `/reports/<id>` builders read) is unchanged: the period and its
look-ahead only.

**Reporting reliability (§12.6).** Stored copies, logical messages after dedup, messages by category,
attribution strength (WhatsApp id + phone / id only / phone only), conflicting identities,
unidentified staff senders, collection gaps (all / may have lost messages / messages recovered),
days that may be missing messages, unverified days. Counts only; the page says why there is no
accuracy score, and a test refuses any percentage, "accuracy" or "score" in those lines.

Also: the help now says an automated reply ends a wait, and that support time is what message
timestamps show, not verified working hours (§12.4). The Excel export gains a "Data quality" sheet
(the page's lines, verbatim) and a "Reply came from" column on Missed & Recall.

Tests: `teamReportReliability.test.ts` (9, shared) and `teamReportReliability.integration.test.ts`
(6, web, real rows: AI/rule/dashboard replies with their OutboundMessage, an unmatched phone reply,
two of our numbers storing one message, a wait from 18:00 continued after midnight, an AI answer at
23:01 followed by a customer line at 00:30). Mutations caught: no earlier-message context, no 4-hour
window, provenance by direction only, context counted as period messages, context leaked to
`/reports`, the business phone treated as a verified person. Existing suites: 172 of 173 passed; the one
failure was an exact-shape assertion that now also sees `actor: "BUSINESS_PHONE"`. Its expected value
was updated; that is the only change to an existing test.

## Stage 5 — identity: verified evidence only, and history keeps its owner

What already met Workstream F, and stays: identifier kinds are explicit and a LID is never read as a
phone number (`parseWhatsAppId`: PHONE, LID, GROUP, BROADCAST, NEWSLETTER); one resolver credits a
message only when exactly one member is named (WhatsApp id + phone, id only, phone only; CONFLICT
and AMBIGUOUS credit nobody); `Message.senderJid` keeps the original id; every identifier change is a
System Log entry; personal chats are never merged.

**No identity-mapping table was added.** wa-automate 4.76 exposes no LID→phone source, and Workstream I
says to add schema only for a concrete feature. The only verified association evidence available is
an admin's own record (a member holding both a WhatsApp id and a typed phone number, or a sender
linked from WhatsApp Chat), and that is already stored on `InternalTeamMember` and logged. A mapping
table becomes worth adding the day a provider supplies LID↔phone evidence, with `evidenceSource`,
`verifiedAt`, `firstSeenAt`/`lastSeenAt` and a conflict state.

**New: "Count their messages from" (§10.3).** `InternalTeamMember.attributeFrom` (migration
`20261016120000_team_member_attribute_from`, one nullable column). Reports credit a member only from
that Dhaka day on, so a customer's number that later joins the team keeps its customer history.
- `createSenderResolver(...).resolve(phone, jid, at)`: given the message's time, a member whose date
  is later is not a candidate. The decision is taken on the members who were on the team then, so a
  shared identifier is credited to whoever held it at the time.
- Applied in the Team Report, Support Intelligence, the activity (calls) report and group reports.
  Not in the live pipeline, which passes no time: anyone on the roster is staff for automation.
- Set on the member's edit page, empty by default (every existing member: unchanged). A form that does
  not carry the field leaves it alone. The change is a System Log entry with the old and new dates.

Tests: `attributeFrom.test.ts` (4, shared) and `teamMemberAttributeFrom.integration.test.ts` (6, web:
the action called as the browser posts it, the report before and after, the log entry, a missing field
leaves the date as it is, an unreadable date refused, cleared again). Mutations caught: the report
ignores the date, a missing field clears it, the log ignores it, the resolver ignores it. Support
Intelligence and the two smaller reports pass the time through the same tested function. They have no
test of their own for it.

## Stage 6 — messaging capability inventory (wa-automate 4.76)

From the library's own declarations (`dist/api/Client.d.ts`, including its `{@license:insiders@}` and
"experimental" notes) and what our provider actually calls. "Live" is what has been seen on real
WhatsApp, not inferred: *production* = in use on live numbers before Phase 2; *boundary* = verified
up to the provider/queue boundary with a mock provider only.

| Capability | Status | Provider basis | Live | Notes / alternative |
|---|---|---|---|---|
| Text messages (send) | SUPPORTED | `sendText` through the one outbound queue | production | — |
| Group messages (receive) | SUPPORTED | `onAnyMessage`, re-attached on every connect | production | — |
| Personal messages (receive, reply) | SUPPORTED | same listener; replies only into an existing chat (`verifyPersonalChat`) | production | No cold messages, by design |
| Gap recovery, groups | SUPPORTED | `getAllMessagesInChat` (what WhatsApp Web has loaded) | production | 12 h reach, 2,000 cap |
| Gap recovery, personal chats | NOT_VERIFIED | same read + in-page personal-chat list (Stage 4) | no | Needs a lab number to confirm `t` on 1:1 chats |
| Native quoted replies | NOT_VERIFIED | `reply()` (public) | boundary | Phase 1; the thread shows a quote only from the echo |
| Group mentions | PARTIALLY_SUPPORTED | `sendTextWithMentions` (public) | production (handover mention) | Phone-number ids only; a LID cannot be mentioned (PROVIDER_LIMITED) |
| Reply + mentions together | PROVIDER_LIMITED | `sendReplyWithMentions` is a stub returning false | — | Refused with a reason, never sent unquoted |
| Emoji reaction (send) | NOT_VERIFIED | `react()` | boundary | Only this account's own reactions are shown, as the worker settled them |
| Reaction removal | NOT_VERIFIED | `react()` with an empty emoji — contract undocumented | — | Not offered |
| Incoming reaction events | LICENCE_LIMITED | `onReaction` is `{@license:insiders@}` | — | Never invented; no REACTION trigger |
| Message edit (send) | PARTIALLY_SUPPORTED | `editMessage` — library: "experimental, most accounts do not have access" | production (EDIT_MESSAGE command) | A failure is the normal outcome on many accounts |
| Incoming edit events | UNSUPPORTED | no edit event in 4.76 | — | Stored text is the original |
| Message revocation (incoming) | NOT_VERIFIED | `onMessageDeleted` (public), not wired | — | Needs a lab number to see what the event carries before storing anything |
| Message delete (send) | UNSUPPORTED (in product) | `deleteMessage` exists, not called | — | Deliberately not offered |
| Delivery status | NOT_VERIFIED | `onAck` (public), not wired | — | `OutboundMessage.SENT` means WhatsApp accepted the send, not delivered |
| Read receipts | NOT_VERIFIED | `onAck` ack 3; `getMessageReaders` documented as unreliable | — | Not shown |
| Media (receive) | SUPPORTED | own streaming decrypt from the CDN, MAC + `filehash` checked | production | `MEDIA_STORAGE.md` |
| Media (send) | UNSUPPORTED (in product) | `sendImage`/`sendFile` exist, not wired | — | Outbound is text by design |
| Group metadata | SUPPORTED | lean in-page `Store.Chat` read (name, activity) | production | `getGroupInfo` (description) not used |
| Contact metadata | PARTIALLY_SUPPORTED | push name on each message (`senderName`) | production | `getContact` not used |
| Chat identity | SUPPORTED | id kinds from the domain; a LID is never a phone number | production | No LID→phone source exists |
| Media retrieval | SUPPORTED | `/p/<slug>/api/whatsapp/media/<id>`, Range + ETag | production | — |
| Message search / history | PARTIALLY_SUPPORTED | search over stored messages; history = what was collected | production | `loadEarlierMessages` exists; history import deliberately not built |
| Group participants | SUPPORTED | `getGroupMembers` / `getGroupMembersId` | production | LID rosters are CANNOT_VERIFY for phone matching |
| Group admin operations | SUPPORTED (promote, add) | `promoteParticipant` (read back via `getGroupAdmins`), `addParticipant` | production | demote / remove not offered |
| Create / join group, own profile | SUPPORTED | `createGroup`, `joinGroupViaLink`, `setMyName`/`setMyStatus`/`setProfilePic` | production | Worker commands |
| Chat state (send typing/presence) | UNSUPPORTED (in product) | `simulateTyping` exists | — | No product need |
| Chat state (incoming typing) | LICENCE_LIMITED | `onChatState` is `{@license:insiders@}` | — | — |

Nothing here emulates an unsupported operation; every refusal carries its reason. Delivery status and
revocation are the next candidates, but only after a lab number shows what `onAck` and
`onMessageDeleted` actually deliver on this build.

## Stage 8 — PostgreSQL, indexes and Redis

**No schema beyond three nullable columns.** Phase 2 adds `OutboundMessage.replyToMessageId` (Phase 1),
`WhatsAppAccount.groupSyncBasis` and `InternalTeamMember.attributeFrom`. No new table: every candidate
in Workstream I was checked against a concrete need (sync jobs — one process owns the browser and
the state already lives on the account; identity mappings — no evidence source, Stage 5; provenance —
derived from the existing `OutboundMessage.providerMessageId`).

**No new index.** Each new read uses an existing one, checked with `EXPLAIN (ANALYZE)` on the
benchmark data:
- each group's earlier message — `Index Scan Backward using "Message_groupId_timestampWa_idx"`,
  1,052 probes, 47 ms;
- provenance — `OutboundMessage_providerMessageId_idx` for a single lookup. The report joins the
  project's sends once as a hash instead; see Stage 9;
- copies count — `Message_timestampWa_idx`, the same range scan as the main read.

**Redis: not added.** Compared against what exists, case by case:

| Candidate (Workstream J) | Today, in PostgreSQL | What Redis would change | Decision |
|---|---|---|---|
| Durable queues (outbound, commands, notifications, adds) | Rows claimed with conditional updates; survive restarts; idempotency keys; stuck-row recovery | BullMQ adds a second source of truth that must agree with the rows; AOF/RDB persistence becomes part of every send guarantee | No — the row IS the guarantee |
| Worker coordination | One worker owns every browser; per-account generation + in-flight maps; advisory locks where two processes could meet | Only needed with several worker processes, which OpenWA's process-global `chdir` rules out | No |
| Rate limiting | Counted from `OutboundMessage` rows in the window | Faster counters, but a lost counter would re-open the limit that protects the number | No |
| Real-time fan-out | 4 s visibility-aware polling of indexed rows | Pub/sub is not durable; still needs the row for correctness | No — revisit only with a measured polling cost |
| Caches / presence | Computed at read time from rows | Cache invalidation risk on reports that must not drift | No |

The benchmarks (Stage 9) found no loop or query that Redis would remove: the costs are the report's
sort over a month of messages and the browser's own reads. Redis would add a service, health checks
and an outage mode, and gain nothing that was measured. The production Compose file is unchanged.

## Stage 9 — measured performance

Fixtures: `apps/worker/src/__tests__/phase2Benchmark.integration.test.ts` and
`apps/web/src/__tests__/phase2ReportBenchmark.integration.test.ts`, skipped unless
`PHASE2_BENCHMARK=1`, throwaway database only. Machine: this Windows workstation, Docker Desktop
PostgreSQL 16 on tmpfs through the loopback port forward (every query pays the forward's round trip —
absolute times are pessimistic, the comparisons are like for like). The WhatsApp side is the
MockProvider: the browser's own chat-store read is not measured, and cannot be without a live number.

**Group sync (unchanged code path apart from the basis column; a baseline for later work).**

| Groups | First sync | Unchanged re-read | Event-loop delay p99 / max | Peak DB connections |
|---|---|---|---|---|
| 50 | 254 ms | 23 ms | 21 / 21 ms | 2 |
| 500 | 518 ms | 95 ms | 22 / 22 ms | 2 |
| 1,800 | 1,656 ms | 175 ms | 21 / 27 ms | 2 |
| 2,500 | 2,114 ms | 217 ms | 23 / 26 ms | 2 |

**Incoming messages.** 500 customer messages one after another: p50 71 ms, p95 80 ms each (14/s,
sequential, the port forward dominating). While a 2,500-group sync ran: p50 68 ms, p95 90 ms, worst
188 ms, against 71 / 76 ms idle — collection keeps its priority during a sync.

**Team Report at production scale** (1,800 groups on two numbers, 30 days, 172,530 stored rows,
152,164 logical messages, 12,126 sends):

| Month | HEAD | Stage 7 first draft | Shipped |
|---|---|---|---|
| Main SQL | 3.1 s | 7.8 s | 3.9 s |
| Counting (JS) | 2.1 s | 2.0 s | 1.8 s |
| Core total | 5.2 s | 9.8 s | 5.8 s |

The first draft probed `OutboundMessage` once per message (~3 s) and read text for every row
(~0.7 s). The shipped query joins the project's sends once as a hash, and reads text only where a
customer's line can be. The benchmark proves it returns the same rows, provenance included, as the
per-row form Support Intelligence uses. Whole loader with the new sections: day 0.66 s, week 2.2 s,
month 7.1 s, five months in parallel 25.5 s, heap growth for a month about 220 MB (garbage included).
At scale, the 30 daily wait counts add up to the month's: 28,163 = 28,163.

Follow-up, not done (outside Phase 2's scope): Support Intelligence's loader still uses the per-row
lookup and would gain the same ~3 s from the same rewrite.

## Final isolated validation (Stage 9)

Everything below ran on throwaway PostgreSQL 16 containers (tmpfs, loopback ports, no volume, removed
afterwards) or the isolated stack described next. No production container, volume, session, database
or environment value was started, read or changed, and no live WhatsApp account was connected.

| Suite | Result |
|---|---|
| shared / engine / ai-client / forge-client / media-storage | 764 / 79 / 31 / 51 / 14 passed |
| Worker, every file, fresh migrated database | 1,244 passed, 0 failed (6 skipped: the env-gated benchmark) |
| Web, every file, fresh migrated database | 725 passed, 0 failed (4 skipped: the benchmark) |
| Typecheck: shared, worker, web | clean |
| Lint (web) | 0 errors, 8 warnings, all in files Phase 2 did not touch |

**Isolated stack** (`docker-compose.validate.yml`, kept in the scratchpad, not in the repository): its own
Compose project, its own image tags, PostgreSQL, migrate, app and worker built from this working tree.
PostgreSQL, sessions and media on tmpfs, no named volume; the worker on an internal-only network (checked:
it cannot reach web.whatsapp.com) with no mount and no session data; the app on 127.0.0.1 only. Migrate
applied all 122 migrations to a blank database, the last being `20261016120000_team_member_attribute_from`;
the app reported healthy. A headless Chromium then drove it: 15 of 15 checks passed (sign-in; the sync basis
on Accounts and its absence on Groups, as before; every new Team Report section; the Excel "Data quality"
sheet; a 390 px phone with no sideways scroll; the "Count their messages from" date saved as Dhaka midnight and
logged; Chat v1 rendering with `CHAT_UI_V2` off). Three of the first run's failures were mistakes in the check
script (it submitted the sidebar's sign-out form; it expected uppercase headings that CSS produces; it expected
a line on Groups that this page never shows for a healthy sync), not in the application. Nothing in the
application was changed to make a check pass.

Not tested, by design: anything that needs a connected WhatsApp number (a real QR link, a real group read,
quoted replies, mentions, reactions, personal-chat recovery on real chats). Each needs a dedicated lab number.

## Production readiness (Stage 10)

**Nothing is committed, pushed, merged or deployed.** All of Phase 1 and Phase 2 is uncommitted on `rudra`.

**Migrations, in order, all additive and nullable** (older code runs against the new schema side by side):
1. `20261016100000_outbound_reply_to` — `OutboundMessage.replyToMessageId` + FK (Phase 1).
2. `20261016110000_group_sync_basis` — `WhatsAppAccount.groupSyncBasis TEXT`.
3. `20261016120000_team_member_attribute_from` — `InternalTeamMember.attributeFrom TIMESTAMP(3)`.
They sort after `20261015100000_project_role_sections`, the newest already on `github/main`.

**Rollout order** (as in `docker compose up -d --build --no-deps migrate app`, worker last): back up and
confirm a restore; `migrate` (applies the three); `app` (nothing in it needs the worker); `worker` only when
the group-sync status wording and personal-chat recovery are wanted, since it restarts WhatsApp sessions —
choose a quiet hour, and expect the usual reconnect, arrival passes and catch-up. `CHAT_UI_V2` stays off.

**Behaviour that changes the moment the code runs** (worth saying to the people who use it): Team Report
gains sections and an Excel sheet; a wait spanning midnight now counts once (a month's figures can move by
the handful of waits that were counted twice); the catch-up after a restart now also reads personal chats, so a
message that was never stored may appear; Accounts shows what a finished sync rests on.

**Rollback.**
- Code: redeploy the previous images; the extra columns are ignored by older code.
- Schema, only if a column must go: `ALTER TABLE "InternalTeamMember" DROP COLUMN "attributeFrom";`
  `ALTER TABLE "WhatsAppAccount" DROP COLUMN "groupSyncBasis";` then `DELETE FROM _prisma_migrations WHERE
  migration_name IN (…)`. Dropping `replyToMessageId` is Phase 1's (`CHAT_UI_V2.md`).
- No data is rewritten by any of this, so no restore is needed for a code rollback.

**After deploying, check:** Accounts shows a basis line after the first sync; the Team Report loads in a
month view in seconds (7 s on the 172,000-row benchmark; the worker's collection watchdog and group recovery
logs are quiet); Team Members' edit page offers the date; System Logs show `GROUP_SYNC_*` as before.

**Open items needing a lab number or a decision.**
1. Live verification of quote, mention, reaction (Phase 1) and of personal-chat recovery (Stage 4).
2. `onAck` / `onMessageDeleted` (delivery status, revocation): wire only after seeing what they carry.
3. Support Intelligence's loader still probes sends per row (a ~3 s saving at this scale).
4. Group sync time itself at 1,800 groups with a real browser read is unmeasured.
5. Attribution date is not yet asked for when adding a member from message history.
