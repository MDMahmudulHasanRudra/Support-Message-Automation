# WhatsApp group sync

How each WhatsApp account's group list reaches the database, and why a second, newly linked
account used to take far longer than the Primary to show its groups. Built locally on `rudra`;
not deployed. Migration `20261011090200_group_sync_state` is not applied to any live database.

## 1. What the audit found

The DB side was already bulk, and nothing per-group is fetched.

| Stage | How it works | Cost for 2,000 groups |
|---|---|---|
| **Discovery** (`OpenWAProvider.getGroups` → `listGroupChats`) | **One** `page.evaluate` over WhatsApp Web's own chat store. It returns id, name, formattedTitle and `t` per group. It makes no per-group call, fetches no participants and downloads no profile pictures. If the store's shape changes, it falls back to `getAllGroups()`, which is heavy. | One round trip into the page. |
| **Persistence** (`syncGroups`) | One read of the account's rows, then `createMany` for new groups, an `update` per renamed group, one `updateMany` stamp, and the deactivation sweep. | Measured on the test DB: about 1.2–1.6 s for a new account, about 0.2–0.3 s for an unchanged rerun. |
| **Participants** | Never read during a sync. They are read on demand (`GET_GROUP_PARTICIPANT_COUNT` / `GET_GROUP_PARTICIPANTS`). | None. |

So there was no expensive enrichment to split out, and no per-group provider call to parallelise.
The spec's "Stage 2 enrichment", bounded concurrency and `GROUP_SYNC_ENRICH` job do not apply. They
are not built, because a queue with nothing to do would be a dead feature.

### The real causes

**1. A newly linked phone sends its chat list over several minutes.**
- The first sync runs the moment the session comes up, so it reads whatever has arrived so far. On
  24 Sep 2026 that was 498 of 1,952 groups.
- The rest were only read by fixed passes 5 and 15 minutes later, or one at a time as messages
  arrived (`resolveGroup`).
- The Primary looked fast because its long-linked session already had the whole list.
- This is a property of WhatsApp's multi-device sync, not of our code. What was ours was waiting
  five minutes to look again.

**2. RESYNC_GROUPS held the strictly serial command processor.**
- "Sync Groups" queues one RESYNC per account. The processor **awaited** each sync before claiming
  the next command.
- A sync can take three attempts at up to 150 s each, plus backoff. Account B's sync, Show QR and
  Reconnect all waited behind account A's whole sync.
- Measured with a 3 s discovery delay on A: before the change, B's groups first appeared at
  **5.4–7.4 s**. After it, B's appeared at **0.4–0.5 s**, while A was still reading.

**3. Nothing showed per-account progress.** A second account still filling in looked exactly like a
short list.

## 2. What changed

### Discovery: read the list as it arrives

After every connect, the existing post-connect flow (sync, then catch-up) now ends by starting
**arrival passes** (`watchGroupListArrival`).
- **Interval:** one pass every `GROUP_ARRIVAL_SETTINGS.intervalMs`. The default is 30 s, set by
  `WHATSAPP_GROUP_ARRIVAL_INTERVAL_MS`.
- **What a pass is:** an **ADD_ONLY** sync. It saves groups that have appeared, renames, and
  reactivates. It does **not** stamp every row and **never runs the deactivation sweep**, which must
  only ever see a complete list.
- **When it stops:** after 3 passes in a row find nothing new (`groupArrivalDecision`), or after
  20 minutes. Then one FULL sync records the finished list and runs the sweep. The 15-minute FULL
  follow-up is kept as a safety net.
- **Result:** a group appears within one interval of WhatsApp delivering it, not at the next
  5-minute mark. A long-linked number settles in about three cheap reads.
- **Overlap:** a pass skips while another sync of the account is running. It is registered in the
  same in-flight map, so a manual resync joins it rather than racing it.

### No account waits for another

- `RESYNC_GROUPS` now starts the sync **in the background** and settles the command row
  (DONE/FAILED) when the sync finishes. The serial processor moves straight on to the next command.
- The command stays PROCESSING while the sync runs, so the dashboard's per-account dedup still sees
  it.
- Duplicate syncs for one account are still joined in memory (`syncInFlight`). This is correct
  because only the one process holding the account's browser can sync it. A database lock would
  guard against a second worker that cannot exist without also fighting over the WhatsApp session.

### Logout and Reconnect stop a running sync (CANCELLED)

Since a resync runs in the background, it can overlap a Logout or Reconnect of the same account.
That overlap is now handled deliberately.

- **Generation token.** Every sync carries the account's sync *generation* from when it started.
  - LOGOUT and RECONNECT call `cancelGroupSync` before they touch the session: before
    `provider.logout()` and before `provider.disconnect()`.
  - `cancelGroupSync` bumps the generation and records **CANCELLED**, with the reason as
    `groupSyncError`. It frees the in-flight slot, so the reconnect's own sync is a new one rather
    than a join of the cancelled one.
  - It waits up to 5 s for a write already under way. It never waits on the WhatsApp read, which may
    be what is hanging.
- **The cancelled sync writes nothing more.** It checks the generation before every write: after the
  read, before each batch, before the stamp and before each sweep batch.
  - It records no state, so it can never overwrite CANCELLED or a newer sync's state.
  - Its RESYNC command settles as DONE with `{ cancelled: true, reason }`, not FAILED.
    `WorkerCommandStatus` has no CANCELLED value; the account's `groupSyncStatus` carries it.
  - Arrival passes and the 15-minute follow-up of the old connect stop too.
- **Why this matters beyond the label.** LOGOUT switches every group of the account off. Without the
  checks, a sync that had already read the list would switch them all back on at its stamp, leaving
  an inbox full of groups the number can no longer reach. `groupSyncPipeline.integration.test.ts`
  drives exactly that: a Logout while the read hangs, then the read returning with ten more groups
  afterwards. Nothing is written and every group stays off.
- **What the operator sees:** "Group sync stopped — Stopped because the account was logged out."
  (or "...for a reconnect. A new sync starts once the account is connected again."). It is a grey
  line, never a red failure.

### Persistence: same data, bounded and partial-failure tolerant

- **One read decides everything.** It covers inserts, renames, reactivations and the sweep. The two
  `count` queries the sweep used are now worked out from that read.
- **Batches of 500** (`GROUP_SYNC_BATCH_SIZE`) for `createMany`, and of 5,000 for `in` lists.
  Postgres allows at most 65,535 bind parameters in a statement, so a single statement stops working
  for very large rosters.
- **A batch that fails** is retried one row at a time. One bad group costs only itself, is counted
  in `failed`, and is retried by the next pass.
- **What a sync writes:** only the name, `isActive` and `lastSyncedAt`. It never touches monitoring,
  AI, exclusions, priority, the assigned member, test mode, category, pin, archive or knowledge
  watermarks.
- **Identity** stays `@@unique([accountId, whatsappGroupId])`. Nothing ever keys on the name.

### Per-account sync state

New `WhatsAppAccount.groupSync*` columns, written by the worker and best effort (a failed write
never fails the sync):

| Column | Meaning |
|---|---|
| `groupSyncStatus` | `GroupSyncStatus`: RUNNING / COMPLETED / PARTIAL / FAILED / CANCELLED. Null means never synced. |
| `groupSyncStage` | What is happening now, e.g. "Receiving chats from the phone — 1,500 groups so far". |
| `groupSyncStartedAt`, `groupSyncCompletedAt`, `groupSyncDurationMs` | Timing. |
| `groupSyncDiscovered`, `groupSyncNew`, `groupSyncUpdated`, `groupSyncDeactivated`, `groupSyncFailed` | Counts from the last pass. |
| `groupSyncError` | The reason for FAILED, or the warning for PARTIAL. |

- **PARTIAL** means some groups were not saved, or the list looked incomplete so the sweep held.
- **FAILED** carries the reason.
- **Worker restart:** a RUNNING state left by a restart is closed as FAILED at boot
  (`reconcileAccountStatusesOnBoot`).

### Dashboard

- **Accounts:** each card shows its own sync line, for example "Syncing groups — Receiving chats
  from the phone · 1,500 found so far" or "Groups synced — 1,964 groups, 12 new · took 1.4 s". The
  page polls while any sync is RUNNING.
- **Resync Groups:** answers "Sync already in progress" when one is queued or running for that
  account.
- **Groups:** a status box lists accounts that are syncing or ended PARTIAL/FAILED, and the page
  refreshes every 5 s while one runs. "Sync Groups" reports how many accounts were queued and how
  many were already syncing.
- **Pagination:** unchanged (50 rows by default). Nothing renders the whole roster.

### What the "full sync" at the end costs

When the arrival passes settle (three in a row find nothing new), one FULL sync runs. It is the
roster reconciliation, nothing more. For 2,000 groups it does the following:

| Step | Statements |
|---|---|
| Read the list from WhatsApp | 1 call into the page |
| Read the account's group rows | 1 `SELECT` (id, name, active) |
| Insert new groups | none when nothing is new |
| Rename | one `UPDATE` per renamed group; normally none |
| Stamp `lastSyncedAt` on every listed group | 1 `UPDATE` (per 5,000 ids) |
| Deactivation sweep | worked out in memory from the one read; 1 `UPDATE` only if groups were left |

It performs no participant reads, no per-group calls and no re-enrichment. On the test DB this is
the "unchanged rerun" row: **0.15-0.19 s for 2,000 groups**.

It exists for two things the ADD_ONLY passes deliberately never do:
1. switching off groups the account left while the list was arriving;
2. stamping `lastSyncedAt`.

The stamp is the only part that touches every row: one statement that rewrites `lastSyncedAt` on all
listed groups. If that write ever matters, the stamp could be limited to rows whose stamp is older
than a threshold. It has not been changed, because the column's meaning ("last seen by a sync") would
change with it.

### Logging

Three SystemLog events. No credentials are logged.
- **`GROUP_SYNC_COMPLETED`** carries `discoveryMs`, `persistMs`, `totalMs` and every count: created,
  renamed, reactivated, deactivated, failed and sweepHeld.
- **`GROUP_ARRIVAL_SETTLED`** is written once per connect when the arrival passes end. It carries
  the timeline (`[{ atSeconds, total, new }]`, measured from the connect), the number of passes and
  `totalSeconds`. This is the real-world measurement in section 6.
- **`GROUP_SYNC_CANCELLED`** carries the reason.

The console also logs `GROUP_ARRIVAL` for each pass that found groups.

## 3. Measurements (isolated test DB, MockProvider, 2,000 groups)

Discovery against real WhatsApp could not be measured here: there is no real WhatsApp session in the
test environment. The figures below cover persistence and cross-account blocking. Each was run three
times.

| | Before | After |
|---|---|---|
| New account, 2,000 groups | 1,363 / 1,570 / 1,497 ms | 1,478 / 1,482 / 1,225 ms |
| Rerun, 2,000 unchanged | 283 / 243 / 320 ms | 149 / 190 / 173 ms |
| Rerun, 10 renamed + 50 new + 10 gone | 731 / 1,124 / 500 ms | 247 / 316 / 271 ms |
| Sync Groups for A and B, A's discovery 3 s — B's groups first visible | 5,976 / 6,065 / 7,379 ms | 387 / 482 / 532 ms |
| New phone delivering 2,000 groups in steps — all visible | at the 5-minute follow-up | within one arrival interval of the last group (test: 50 ms interval, all within seconds) |

Database statements per sync, for 2,000 groups:
- **Before:** 1 read, 1 `createMany`, R renames, 1 stamp `updateMany`, 2 `count`s, and the sweep
  `updateMany`.
- **After:** 1 read, ⌈new/500⌉ `createMany`, R renames, ⌈listed/5,000⌉ stamp, and the sweep in
  batches. The two counts are gone.
- **Provider calls:** 1 per pass, before and after.

## 4. Tests

`apps/worker/src/__tests__/groupSyncPipeline.integration.test.ts` (16 tests):
- new account with 2,000 groups;
- an unchanged rerun of 2,000 that keeps every setting a person made, with a rename;
- account + WhatsApp-id identity across two accounts, and isolation of one account's sweep;
- one unsaveable group (a NUL byte) giving PARTIAL, then saved on the next pass;
- a short list holding the sweep, giving PARTIAL;
- FAILED with the reason;
- two requests sharing one read;
- B's resync not held behind a slow A;
- the arrival decision;
- arrival passes filling in a growing list without switching anything off, then COMPLETED;
- ADD_ONLY never switching off or restamping;
- the boot reconcile;
- Logout during a hanging resync (CANCELLED, nothing written afterwards, groups stay off);
- a cancelled sync never overwriting the newer sync after a reconnect;
- cancel with nothing running recording nothing;
- both commands cancelling before they tear the session down.

Each protection was confirmed to fail its test with that protection removed: 10 of 11. The
eleventh is a generation guard on the state writes. It is defence in depth: the write checkpoints
already stop a cancelled sync before it can reach a state write, so removing the guard alone changes
no outcome a test can produce.

`apps/web/src/__tests__/groupSyncRequests.integration.test.ts` checks the per-account dedup and the
"already in progress" answer, and was confirmed to fail without it.

Existing tests that still pass: the deactivation-sweep guard, the post-connect sync,
retry/not-ready, the command processor, and recovery.

## 5. Migration name

`20261011090200_group_sync_state` is dated ahead of today (6 Oct 2026). This is on purpose:
- **The chain already runs ahead of the calendar.** Since 4 Oct each migration on this branch took
  the next day-slot: `20261007...`, `20261008...`, `20261009...`, `20261010...`, `20261011090000`,
  `20261011090100`. All of them are committed and pushed.
- **Prisma orders by name.** A name dated today (`20261006...`) would sort before seven existing
  migrations.
- **Prisma does not refuse that.** Checked on the test DB: an out-of-order migration is reported as
  pending and applied silently by `migrate deploy`, after the later-named ones. A fresh database
  (name order) and the live one (apply order) would then have run them in different orders.
- **The fix.** It was first named `20261012090000`. It is now `20261011090200`, directly after the
  last pushed migration, so the chain does not reach any further into the future.
- **Until 12 Oct 2026:** do not take the name `prisma migrate dev` generates. Name a new migration
  after `20261011090200` by hand.

## 6. The real-world test (still to do)

Simulated providers cannot show how fast WhatsApp hands a new device its list. To measure it:

1. **Account A**, already connected (~2,000 groups): note its card. It should say "Groups synced"
   and stay usable throughout.
2. **Account B:** connect a fresh phone. From the moment it shows CONNECTED, watch B's card. It
   moves through "Syncing groups — Receiving chats from the phone — N groups so far" about every
   30 s.
3. **Groups page:** filter by B. The count grows pass by pass. Note when it is usable.
4. **During the arrival:** use A (resync, open the chat inbox, Show QR on another account). None of
   it should wait on B.
5. **System Logs:** search `GROUP_ARRIVAL_SETTLED` for B. Its `timeline` gives exactly when each
   batch of groups arrived and `totalSeconds` gives when the list settled. `GROUP_SYNC_COMPLETED`
   gives the final discovery and save times.
6. **Cancellation:** press Resync on B, then Logout before it finishes. B's card should show
   "Group sync stopped — Stopped because the account was logged out.", its groups should all be
   inactive, and nothing should reappear afterwards. Repeat with Reconnect. The line should be
   replaced by a new "Syncing groups" once it connects.

## 7. Provider limits

- **List size:** WhatsApp Web only lists what the phone has delivered to the linked device. No API
  makes the phone send faster, and no OpenWA call reports "history sync finished". Settling is
  therefore judged by evidence: passes that find nothing new.
- **Pagination:** the chat store has none. The lean in-page read returns a few fields per group, so
  one response is small.
- **Fallback:** if WhatsApp Web reshapes its internal store, the fallback `getAllGroups()` is heavy
  and has timed out on large rosters before. That remains the slow path.
