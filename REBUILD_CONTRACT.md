# Rebuild / Backfill Contract — Support Activity & Team Management

**Status: audit findings. Nothing here is implemented.** This documents what the code does today, so
recovery logic is built against facts rather than assumptions.

Every claim below was checked against the code or proved against the isolated test DB on :5433. Where
it was proved, the result is quoted.

---

## The central question

> Can we delete/rebuild the derived Team Management records without losing historical truth?

**Three derived tables, three different answers.** Treating them as one "rebuild" is the mistake this
document exists to prevent.

| Table | Rebuildable? | Why |
|---|---|---|
| `TeamAttendanceDay` / `TeamAttendanceGroup` | **Yes, with one blocker** | Derived from `Message` + the roster. No rule dependency. |
| `SupportActivity` | **No** | Depends on rule configuration *as it was*, and rules have no history. |
| `SupportSession` | **No** | Derives from `SupportActivity`, and carries manual admin closes that are not derivable from anything. |

---

## 1. Source of truth

**Authoritative — human-authored, never recomputed:**

`DutyAssignment` · `DutyAssignmentChange` · `LeaveRequest` · `LeaveType` · `Holiday` ·
`WeeklyScheduleEntry` · `ShiftTemplate` · `InternalTeamMember` · `Message`

**Derived — reconstructible in principle:**

`TeamAttendanceDay` (evidence columns only) · `TeamAttendanceGroup` · `SupportActivity` ·
`SupportSession`

**Writer map** (verified by grep, no other writers exist):

| Table | Written by |
|---|---|
| `SupportActivity` | `detector.ts`, `recordAiSupport.ts` |
| `SupportSession` | `sessionTracker.ts`, `supportSessions.ts` (manual close) |
| `TeamAttendanceDay` | `attendance.ts` (evidence), `teamManagement.ts` (override) |
| `TeamAttendanceGroup` | `attendance.ts` |
| `DutyAssignment` / `Change` | `teamManagement.ts` |

### Snapshot fields a rebuild must never recompute

| Field | Why |
|---|---|
| `DutyAssignment.shiftName` / `shiftStartMinute` / `shiftEndMinute` | The shift *as it was*. Editing "Late" from 13:00–22:00 changes what Late means from now on, never what somebody worked last Tuesday. |
| `LeaveRequest.dayCount` | Counted once at creation, so a holiday declared later cannot resize a decided request. |
| `SupportSession.durationSeconds` | Computed at completion; an immutable fact once closed. |
| `SupportActivity.ruleId` / `keywordId` | **Which rule matched at the time.** See §3. |
| `TeamAttendanceDay.override` / `overrideReason` / `overriddenByUserId` / `overriddenAt` | A manager's verdict, stored *beside* the evidence, not derived from it. |

**`TeamAttendanceDay` has two writers of different kinds, and that split is the contract.** A rebuild
may touch `messageCount`, `uniqueGroupCount`, `firstActivityAt`, `lastActivityAt`. It must never
touch the override columns.

*Proved:* after setting `override: ABSENT` and re-running the recompute —
`override=ABSENT reason="manager verdict"`. The current code already respects this.

---

## 2. Historical assignment preservation

`DutyAssignment` remains the date authority and is never derived. `deriveDutyState` joins plan +
evidence + approval at **read** time and stores nothing, so there is no stored derivation to drift.

**This half is already safe.** A rebuild that only rewrites attendance evidence cannot change what
shift somebody was on, because the shift is snapshotted onto the assignment row and the assignment
row is human-authored.

---

## 3. Message backfill — the blocking finding

**`SupportActivity` is not deterministically reconstructible from `Message`.**

`detector.ts` reads rules **live at evaluation time**:

```ts
const candidateRules = await prisma.supportRule.findMany({
  where: { isActive: true, triggerType: { in: [...] }, ... },
});
```

and there is **no version history** for any input it reads:

| Model | Version history |
|---|---|
| `SupportRule` | none |
| `SupportKeyword` | none |
| `SupportRuleGroup` / `SupportRuleTeamMember` (scope) | none |
| `SupportActivitySettings` | none |

This is an absence, not a convention gap — the schema keeps history where it decided to
(`AiKnowledgeVersion`, `DutyAssignmentChange`, `ReleaseNote.currentVersion`).

So a rebuild replays historical messages against **today's** rules:

- a rule deactivated since → activities that really happened **disappear**
- a rule added since → activities that never happened **appear**
- scope narrowed → attribution silently changes
- `marksCompletion` changed → session completion changes
- `SupportActivitySettings.enabled` toggled off → all of it vanishes

**Conclusion: a `SupportActivity` rebuild rewrites history to match current configuration.** That is
exactly the failure mode this workstream is meant to prevent. Do not build one without first giving
rules an effective-dated history — which is a much larger change than the recovery job itself.

### Identity resolution over time

`resolveActiveTeamMember` filters `status: "ACTIVE"`.

*Proved on the isolated DB:*

```
1. ACTIVE member, after first record : messages=3 groups=1 date=2026-09-10
3. after DEACTIVATION, rebuild      : row still present (messages=3)
   -> did the rebuild UPDATE it?    : NO — the resolver skipped an INACTIVE member
```

Two consequences, and they pull in opposite directions:

- **Good:** a rebuild cannot destroy a deactivated member's existing history — the recompute simply
  never runs for them.
- **Bad:** a rebuild cannot *restore* it either. If that row were lost or corrupt, it is
  unrecoverable while the member is INACTIVE.

This matters because the codebase deliberately deactivates rather than deletes members *to preserve
history*. A recovery job that resolves only ACTIVE members cannot recover the very records that
policy exists to protect.

`InternalTeamMember.status` has no history, so "who was on the roster on 10 September" is not
answerable from the database at all.

### Shared / unattributed identities

WhatsApp now identifies participants by LID. `resolveActiveTeamMember` matches `whatsappId` exactly
first, then digits-normalised `phoneNumber`. A LID-only member has the same value in both columns.
A rebuild inherits this unchanged — but note it resolves against the roster **as it is now**, which
CLAUDE.md states is deliberate: filtering on `Message.isFromTeamMember` would mean adding a
colleague at noon silently discarded their morning.

**So attendance rebuild is intentionally *not* a faithful replay — it is a recomputation under
current identity.** That is correct for attendance and wrong for support activity, which is the
asymmetry at the heart of this document.

---

## 4. Attendance semantics

*Proved:* 3 messages at 08:00 UTC → `activityDate = 2026-09-10`. 08:00 UTC is 14:00 Dhaka, so the
Dhaka calendar bucketing is correct. `toDhakaDateOnly` / `getDhakaDayRange` use a fixed +6h offset,
correct for Bangladesh (no DST), and are shared by 9 files.

`NO_ACTIVITY` is derived at read time and `ABSENT` is reachable only from `AttendanceOverride`. Since
a rebuild writes only evidence columns and overrides live in their own columns, **the distinction
survives a rebuild** — proved in §1.

A rebuild must not infer absence from missing messages. No message is evidence of no message and
nothing more.

---

## 5. Idempotency

*Proved:* running the recompute twice produced `messages=3` both times, on the same row
(`same row? true`). `recordTeamAttendance` recomputes a member-day rather than incrementing, which
is what makes a re-run converge instead of accumulating.

A partial rebuild is therefore safe **per member-day**, which is the natural unit of work.

---

## 6. Concurrency

The existing lock is `pg_advisory_xact_lock(hashtext(key)::bigint)` on
`team-attendance:<memberId>:<YYYY-MM-DD>`, held inside `prisma.$transaction`, i.e. **transaction
scoped and per member-day**.

A rebuild that recomputes the same member-days through `recordTeamAttendance` inherits that lock and
cannot race a live recompute. A rebuild that writes `TeamAttendanceDay` **directly**, bypassing that
function, would bypass the lock — so it must not.

⚠️ Untested: no test currently exercises a rebuild racing a live recompute. The existing concurrency
test covers live-vs-live only. `teamAttendance.integration.test.ts` documents that this test was
written twice before it could detect a deliberately removed lock; the same care is required here.

---

## 7. Scope — what exists today

**Nothing.** There is no rebuild or backfill capability for either module: no job row, no
`WorkerCommand`, no admin action, no CLI. The schema's only "rebuild" mentions belong to
`CommunicationStyleProfile`, an unrelated feature.

What the current code makes naturally available:

| Granularity | Available? |
|---|---|
| Single member-day | **Yes** — `recordTeamAttendance` is already keyed this way and locked this way |
| Single member, date range | Yes, as a loop over member-days |
| Date range, all members | Yes, as a loop |
| Full historical | Yes in principle; bounded only by `Message` volume (~10⁶ rows) |

`KnowledgeImport` is the existing precedent for a resumable job row: `status`, `error`, `startedAt`,
`completedAt`, `rawText` retained so a retry needs no re-upload, and a failing chunk marks the job
`PARTIAL` while keeping every record the other chunks produced.

---

## 8. Failure recovery

**Nothing exists**, so this is a requirement list rather than a description:

- a job row (the `KnowledgeImport` shape) is the established pattern
- `PARTIAL` must keep completed work, per that precedent
- the unit of resumability should be the member-day, because that is the unit the lock and the
  recompute already use
- there is currently no audit trail for a rebuild; `DutyAssignmentChange` is the shape the schema
  already uses for "who changed what, when"

## 9. Production safety

**Nothing exists.** Required before any destructive backfill:

- dry-run producing before/after counts without writing
- anomaly detection — a rebuild that would *reduce* a member's recorded days is the signal that
  something is wrong (most likely an INACTIVE member, §3)
- explicit scope; no implicit "rebuild everything"
- the live DB safety convention in CLAUDE.md applies: nothing runs against production without
  explicit go-ahead

---

## What a correct recovery system must preserve

1. **Historical truth ≠ current configuration.** Rebuilding 10 September must use the
   `DutyAssignment` snapshot for that date, never today's default shift. Already safe, because
   assignments are authoritative and snapshotted — but only as long as a rebuild never touches them.
2. **No WhatsApp message ≠ absent.** Already safe: overrides live in their own columns and survive a
   recompute, proved in §1.
3. **A deactivated member's history must be recoverable.** *Not currently possible* — §3.
4. **Support activity must not be re-derived from today's rules.** *Currently unavoidable if a
   rebuild is written naively* — §3.

---

## Recommendation

Scope the first implementation to **attendance only** — `TeamAttendanceDay` / `TeamAttendanceGroup`
— because it is the only derived data that can be rebuilt without rewriting history. It needs two
things the current code does not have: resolution that includes INACTIVE members (for recovery only,
never for live capture), and a job row for resumability and audit.

**`SupportActivity` and `SupportSession` rebuild should be deferred** until rule configuration is
effective-dated. Until then, the honest position is that they are recoverable only from a database
backup, not reconstructible from source.

---

## What the remaining five dimensions changed

All nine dimensions have now run. Four findings change or sharpen the contract above; the rest are
ordinary defects and belong with the 53 leads rather than here.

### The blast radius is six of eight reports

Mapping each headline Support Activity report onto the rebuildability boundary:

| Report | Reads | Survives loss of derived data? |
|---|---|---|
| `getExecutiveWorkload` — *the headline report* | `SupportActivity` | **No** |
| `getTeamAvailability` | `SupportActivity` | **No** |
| `getPerTeamMemberBreakdown` | `SupportActivity` | **No** |
| `getActorBreakdown` | `SupportActivity` | **No** |
| `getGroupSessionHistory` | `SupportSession` | **No** |
| `getAverageResolutionTime` | `SupportSession` | **No** |
| `getFirstResponseStats` | `Message` | **Yes** |
| `getGroupsAwaitingReply` | `Message` | **Yes** |

The two that survive are the two that deliberately read `Message` directly, and CLAUDE.md says they
do so precisely to avoid depending on tracking being enabled. That decision turns out to be the only
reason any of this module is recoverable, which is worth knowing before anyone "simplifies" either
of them onto `SupportActivity`.

### Capture failures leave no durable trace — so incomplete work cannot be identified

All four capture hooks in `processIncomingMessage.ts` are awaited, wrapped in their own try/catch and
swallowed, which is correct — a failure to record must never stop a customer being answered. But
every one of them reports only through `console.error`:

```
[escalation]       failed to update support escalation state
[support-activity] failed to update support session
[support-activity] failed to record support activity
[team-attendance]  failed to record attendance evidence
```

Nothing durable is written. After a container restart there is no record that attendance failed for
any message, so **§8's "can we identify incomplete work?" is answered "no" even for live capture**,
not just for a rebuild. `MessageDropCounter` exists for exactly this reasoning on the drop path and
was never extended here. A rebuild cannot target the member-days that actually need it; it can only
be run blind over a range.

### The verification tool is itself truncated

`getDutyHistory` carries `take: 500`, and `api/team-management/export/route.ts` calls the *same*
function — its own comment says that is so "an exported figure can never differ" from the page. The
intent is right and the consequence is not: a month for twenty people is 600 member-day rows,
ordered `dutyDate desc`, so the **oldest days are silently dropped** from the payroll export.

This matters here rather than in the defect list because the export is the natural tool for
verifying a rebuild's before/after counts (§9), and it under-reports without saying so.

### Two things checked and cleared

- **`senderIdentifiers` vs `resolveActiveTeamMember`.** The resolver normalises *both* sides; the
  recompute builds literals for an exact `senderPhone IN (...)` match. That asymmetry is covered
  today only because `Message.senderPhone` is `stripJidDomain(...)` of WhatsApp's own output, which
  is digits, and the identifier list includes `normalizePhoneNumber(member.phoneNumber)`. **Not a
  defect, but a fragile coupling**: any future ingestion path that stored a `+`-prefixed or spaced
  number would make the recompute silently count fewer messages than the resolver matched, with no
  error. Cheap hardening: normalise on write, or compare normalised on both sides.
- **The advisory lock key.** `hashtext()` returns `integer`, so the key space is 2^32 rather than
  2^64 and distinct member-days can collide. A collision makes two unrelated member-days *share* a
  lock — over-locking, not under-locking. Safe for correctness; a negligible throughput cost.

### Unchanged by this pass

`TRIGGER_PRECEDENCE` genuinely orders `ANY_MESSAGE` last (3). `SupportActivity.messageId @unique` is
the real idempotency guard. The Dhaka bucketing is correct.

---

## Depth of this audit, honestly

Worker capture integrity and cross-module consistency were audited thoroughly, because those were
the two most likely to change the contract. Report accuracy was audited at the dependency level —
which report reads which table — rather than re-deriving every aggregate. Team Management
filtering/UX and missing features were sampled, not exhausted; their findings belong with the 53
leads.

## Still to verify

The audit that produced the original 53 findings completed 4 of 9 dimensions. Five remain:
Support Activity report accuracy, Team Management filtering/UX, missing features, cross-module
consistency, worker capture integrity. **Those 53 findings are audit leads, not facts** — none has
been reproduced against the isolated DB yet.
