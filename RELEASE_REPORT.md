# Release Report — `rudra` → `main`

**Prepared:** 18 September 2026
**Branch under review:** `rudra` @ `15f296e`
**Target:** `main` @ `d5b9248`
**Prepared by:** Claude (audit and validation only — see *Scope of this report*)

---

## Scope of this report

This report **audits, validates and plans**. It does not merge and does not deploy.

No branch was pushed, no branch was merged, no production system was contacted, and no live
database was read or written. Every command run against a database in producing this report ran
against a throwaway Postgres on `localhost:5433` that is dropped at the end. The merge into `main`
and the deployment are Rudra's to perform, after reading this.

---

## 1. Verdict

| Decision | Verdict | Why |
|---|---|---|
| **Merge `rudra` → `main`** | **GO** | Clean fast-forward, no conflicts, every locally-verifiable gate passes. Merging does not deploy anything (there is no CI/CD in this repository), so it is reversible and carries no production risk on its own. |
| **Deploy to production** | **NO-GO until three preconditions are met** | Three facts about the live system are unknown to me and cannot be guessed. They are listed in §6 and each takes one command to establish. |

The two decisions are genuinely separate here, which is why they get separate verdicts. There are
no GitHub Actions or other pipelines in this repository — pushing `main` runs nothing. Deployment
is a deliberate, manual `git pull` + `docker compose up -d --build` on the VPS, and *that* is the
step with a one-way door in it.

---

## 2. What is in this release

Nine commits, 90 files, **+6,791 / −479**. Four bodies of work:

| Commits | Work |
|---|---|
| `17d9ec5`, `1268432`, `c70f90b`, `546152d`, `9b441fe` | **Backend reliability & performance** — the response to the 18 Sep collection outage: obligation-based collection watchdog, a probe that can actually fail, `COLLECTION_BROKEN` alerting, per-loop liveness, bounded awaits into Chromium, the `recoverStuckCommands` age-cutoff fix, and five query/write rewrites. |
| `a7120f1`, `ef53bfb` | **BM25F knowledge ranking** — field-weighted retrieval replacing keyword counting. |
| `ef518cd` | **AI reply hardening** — the five findings from the final AI reply audit, plus a same-group routing test. |
| `15f296e` | **Evidence, provenance and isolation foundation** — knowledge scope as a data-isolation boundary, evidence snapshots, key-versioned encryption, content fingerprints, audit fields on `SystemLog`. |

### Migrations

`rudra` adds **6** migrations. **12** are pending deployment to production (the other 6 were already
merged to `main` but never deployed). Ten of the twelve are **pure DDL**. Only two write a single
data statement each:

| Migration | Data statement | Risk |
|---|---|---|
| `20260918130000_command_started_at_and_dead_statuses` | `UPDATE "WhatsAppAccount" SET status='DISCONNECTED' WHERE status IN ('OUTBOUND_PAUSED','RATE_LIMITED')` | **None expected.** Defensive only — nothing has ever written either value, and boot reconciliation has normalised both for weeks. It exists so the enum type swap on the next line cannot fail on a surprise row. |
| `20260918150000_evidence_provenance_foundation` | `UPDATE "AiKnowledgeItem" SET scope='GROUP' WHERE "sourceGroupId" IS NOT NULL` | **The one deliberate behaviour change in this release.** See §3. |

So the entire data-mutation surface of this deployment is two `UPDATE` statements, one of which is
expected to affect zero rows.

---

## 3. The one deliberate behaviour change

Knowledge distilled from a specific group's conversation, or researched live for one group's
question, stops grounding answers given in *other* groups.

Before this release, retrieval filtered on `humanVerified` + `ACTIVE` and nothing else.
`sourceGroupId` recorded where an entry came from and was used only as a ranking tiebreak — so an
entry learned from Customer A's conversation was immediately retrievable when answering Customer B.
That is the isolation requirement this work exists to satisfy.

**What changes on the day:** entries with a `sourceGroupId` narrow to their own group. Entries with
none — manual entries, document imports, the Forge repository sync, i.e. everything that is a
statement about the *product* — keep the `GLOBAL` default and behave exactly as before.

**Expected effect:** the AI will hand over to a human in cases where it previously answered from
another group's knowledge. That is the intended direction, but it is a real change in answer rate
and should be watched for the first day.

**Reversible in one statement**, with nothing else reading the column yet:

```sql
UPDATE "AiKnowledgeItem" SET "scope" = 'GLOBAL' WHERE "sourceGroupId" IS NOT NULL;
```

**What I could not establish: how many rows this touches in production.** In the rehearsal it was 91
of 394. In production it could be zero or it could be most of the knowledge base, and the two cases
deserve different levels of attention on deployment day. This is precondition **P3** in §6.

---

## 4. Verification performed

### 4.1 Build, types, lint, tests

Run at `15f296e`, nothing in the working tree modified.

| Gate | Result |
|---|---|
| `apps/worker` tests (isolated DB) | **645 passed**, 57 files, 0 failed |
| `packages/engine` tests | **74 passed**, 7 files |
| `packages/shared` tests | **121 passed**, 7 files |
| `packages/ai-client` tests | **31 passed**, 2 files |
| **Total** | **871 passed, 0 failed** |
| `pnpm typecheck` | **clean** — all 8 packages |
| `pnpm lint` | **0 errors**, 5 warnings — unchanged from the pre-existing baseline (4 unused-symbol/directive warnings that predate this branch) |
| `pnpm build` | **clean** — `apps/web` (Next production build) and `apps/worker` (tsc) both Done |

`apps/web` and `packages/db` have no test suite by design; `apps/web` is covered by lint and
typecheck only.

### 4.2 Existing-data migration rehearsal — the headline evidence

Migrating an empty database proves the SQL parses. It proves nothing about a database that already
holds five weeks of customer conversations. So the twelve pending migrations were rehearsed against
a database deliberately built to look like production.

**Method.** A separate throwaway database was brought up, the twelve pending migrations were *held
back*, and the remaining 57 were applied — reproducing production's schema as it stands today. That
database was then populated with representative data, every content checksum was recorded, the
twelve migrations were applied, and the checksums were taken again.

**Fixture shape:** 2 WhatsApp accounts (one CONNECTED, one long-disconnected), 120 groups, **1,004,000
messages** with Bengali bodies, 394 knowledge entries (303 with no provenance, 91 distilled from a
group, plus deliberate edge cases: a null question, Bengali text, an ARCHIVED entry at version 3,
and a row with irregular whitespace), 304 knowledge versions, 200 AI fallback decisions, 500 system
logs, three worker commands in three different states, and an AI provider whose API key was written
in the **legacy pre-rotation encryption envelope**.

**Results:**

| Check | Result |
|---|---|
| Migrations applied | **69 of 69**, 0 rolled back |
| Wall time for the 12 pending migrations | **3.8 s** (at 4,000 messages) |
| Row counts, every table, before vs after | **identical** |
| `AiKnowledgeItem` content checksum | **identical** (`e31dcc9b…`) |
| `AiFallbackDecision` content checksum | **identical** (`c278ffba…`) |
| `SystemLog` content checksum | **identical** (`9a4a0301…`) |
| `Message` content checksum | **identical** (`ddea292b…`) |
| Scope backfill correctness | 303 `GLOBAL` / 91 `GROUP`, **0 rows** where scope disagrees with provenance |
| `verifiedAt` / `verifiedById` backfilled? | **No — 0 of 394**, confirmed explicitly against rows whose `updatedAt` was set to distinctive past dates. No audit fact was invented. |
| `contentHash` backfilled? | **No — 0 of 394.** Deliberate: canonicalisation lives in application code and duplicating it in SQL would create a second definition of what a hash is. Filled on each row's next write. |
| New columns on historical rows | All null (`latencyMs`, `finishReason`, `promptVersion`, `retrievalVersion`, `evidenceFingerprint`, `correlationId`, `actorUserId`, `targetType`, `targetId`) |
| New tables created and empty | `AiEvidenceSnapshot`, `AiEvidenceItem`, `MessageDropCounter`, `WorkerHealthSnapshot` |
| Enum changes | `COLLECTION_BROKEN` added; `AiKnowledgeScope` created; `OUTBOUND_PAUSED`/`RATE_LIMITED` removed cleanly |
| `humanVerified` default | Now `false` for new rows; **existing rows untouched** (325 verified / 69 unverified, unchanged) |
| Re-running `migrate deploy` | **Clean no-op.** Safe to re-run if a deploy is interrupted. |
| **Schema drift after migrating** | **`No difference detected`** — the migrated database matches `schema.prisma` exactly. |

### 4.3 Encryption backward compatibility

A secret written in the **legacy three-part envelope** — the format every credential in production
is currently stored in — was placed in the fixture database before migrating, then read by the
post-release code.

| Check | Result |
|---|---|
| Legacy secret still decrypts after migration | **Yes** |
| Legacy ciphertext modified by the migration | **No** — byte-identical, still 3 parts |
| Key id reported for a legacy secret | `v1` |
| Rotation onto the active key, then read back | **Yes**, and the ciphertext genuinely changed |
| A newly written secret uses the versioned envelope | **Yes** (5 parts) |

No plaintext secret was printed at any point; the check reports only whether the value round-tripped.

### 4.4 The application, running against migrated legacy data

Eight integration suites covering everything this release touches were run **against the migrated
fixture database** — not a clean one. This is a stronger test than the clean-DB run, because it
exercises the new code against rows written by the old schema.

**121 of 121 passed**, including the knowledge-isolation boundary, evidence provenance, the rewritten
queries, the collection watchdog, recovery robustness, the AI reply hardening and the full AI
fallback pipeline.

### 4.5 Index build cost at production scale

`20260918110000_reliability_query_indexes` adds one index to `Message`. `CREATE INDEX` without
`CONCURRENTLY` holds an `ACCESS EXCLUSIVE` lock, so its duration is the write-freeze on the busiest
table in the system. Measured rather than estimated:

| Messages | Index build | Table size |
|---|---|---|
| 1,004,000 | **5.45 s** | 888 MB |

Roughly linear, so ~11 s at 2M and ~27 s at 5M. The worker is stopped during deployment anyway, so
this is comfortably inside the window. It is stated here so nobody has to guess on the night.

### 4.6 Merge mechanics

| Check | Result |
|---|---|
| Working tree | clean |
| `rudra` ahead of `main` | 9 commits |
| `main` ahead of `rudra` | **0 commits** — the merge is a fast-forward |
| Conflict probe (`git merge-tree`, read-only) | **CLEAN** — no conflicts |
| `main` vs `origin/main` | in sync at `d5b9248` |
| CI/CD that would fire on a push to `main` | **none** — no `.github/workflows` |

---

## 5. Corrections to the release brief

Two premises in the brief did not survive checking. Neither is a problem; both change what should be
done.

**1. The brief says 11 pending migrations. The number is 12, and only 6 of them are new.**
`main` carries 63 migrations; `rudra` carries 69. So this release *adds* 6. The other 6
(`ai_sandbox` through `whatsapp_pairing_method`) were already merged to `main` and were never
deployed — they are pending *deployment*, not pending *merge*. Everything after
`20260913100000_release_notes` is pending, and that is 12 directories.

This matters because the rehearsal had to cover all 12, not 6 — a deployment applies whatever
production is missing, regardless of which branch it arrived on.

**2. "Pending" is inferred, not confirmed.** I derived the 12 by comparing branches. The
authoritative answer lives in production's own `_prisma_migrations` table, which I cannot read. If
production is further behind than `20260913100000_release_notes`, more will apply than were
rehearsed. This is precondition **P1** in §6.

---

## 6. Preconditions for deployment

Three facts, three commands, all read-only. Each is a question I could not answer without production
access.

### P1 — What has production actually applied?

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 20;"
```

**Expected:** the newest row is `20260913100000_release_notes`, and no row has a non-null
`rolled_back_at`. If the newest is older than that, the deployment applies more than was rehearsed —
tell me and I will extend the rehearsal. If anything shows `rolled_back_at`, **stop**: a failed
migration in the history has to be understood before another one runs on top of it.

### P2 — A verified backup, taken before anything runs

```bash
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > ~/backup-pre-release-$(date +%Y%m%d-%H%M).dump
```

Then confirm it is real, not a zero-byte file from a failed command:

```bash
ls -lh ~/backup-pre-release-*.dump && pg_restore --list ~/backup-pre-release-*.dump | tail -5
```

This must happen **before** `docker compose up`, because the `migrate` service runs
`prisma migrate deploy` automatically as part of bringing the stack up — there is no window between
"deployed" and "migrated" in which to take it.

### P3 — How many knowledge entries does the scope change affect?

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FILTER (WHERE \"sourceGroupId\" IS NOT NULL) AS becomes_group_scoped, count(*) AS total FROM \"AiKnowledgeItem\";"
```

This is the blast radius of §3. A small number means the change is barely visible; a large number
means the AI's handover rate will move noticeably on day one and somebody should be watching the AI
Activity log. Either is fine — being surprised by it is not.

---

## 7. What I could not verify, and why

Production is at `161.248.246.134` over SSH as user `rudra`. Key-based authentication was rejected
(`Permission denied (publickey,password)`), and the password is deliberately not stored in my memory
— it is requested per session by design. So every production-side gate is unexecuted:

| Gate | Status |
|---|---|
| Production migration state (Gate 6/9) | **Not executed** — P1 above |
| Production backup (Gate 10) | **Not executed** — P2 above |
| Scope-change impact count (Gate 12) | **Not executed** — P3 above |
| Deployment-image verification (Gate 11) | **Not executed** |
| Production migration (Gate 13) | **Not executed** |
| Post-migration DB verification (Gates 14–17) | **Not executed** |
| Controlled live AI test (Gates 18–19) | **Not executed** |
| Post-deploy monitoring (Gate 22) | **Not executed** |

If you want these run rather than documented, give me the SSH password and I will execute the
read-only ones (P1, P3, and the post-deploy verification queries) and report. I will still not
perform the merge, and I will not run the deployment or the migration without you saying so
explicitly at that point.

---

## 8. The merge plan — for Rudra to run

The merge is a fast-forward with no conflicts. Verified read-only; not performed.

```bash
git checkout main
git pull origin main
git merge --ff-only rudra
```

`--ff-only` is deliberate: it will refuse rather than create a merge commit if anything has landed on
`main` since this report was written. If it refuses, that is new information — re-check before
forcing anything.

Then push to both remotes (this repository has two):

```bash
git push origin main
git push github main
```

Return to the working branch:

```bash
git checkout rudra
```

---

## 9. The deployment plan — for Rudra to run, after P1–P3

On the VPS, in `~/project2/app`:

```bash
cd ~/project2/app && git pull origin main
```

Take the backup (P2) **now**, before the next command, then:

```bash
docker compose up -d --build
```

This builds the images, runs `prisma migrate deploy && tsx prisma/seed.ts` via the `migrate` service,
and only then starts `app` and `worker` (`app` depends on `migrate` completing successfully, so a
failed migration stops the deployment rather than running the new code against an old schema).

Watch the migration:

```bash
docker compose logs migrate --tail 50
```

Then confirm health:

```bash
docker compose ps
```

All of `postgres`, `app`, `worker` healthy. Then, on the app:

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) AS applied, count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back FROM _prisma_migrations;"
```

Expect **69 applied, 0 rolled back**.

### First hour: what to watch

1. **WhatsApp reconnects.** The worker owns the only Chromium session; a restart re-pairs from stored
   credentials. The Accounts page should return to CONNECTED without anybody scanning anything. If a
   QR appears, that is a session that did not survive — link it from the phone.
2. **Messages are arriving.** `/health` and `/metrics` now report `received` per process. Flat while
   the groups are busy is the exact signature of the outage this release exists to prevent — and the
   new watchdog should now say so itself rather than leaving it to be noticed.
3. **AI handover rate.** The AI Activity log. A rise is expected and is §3 working; a rise to *every*
   message means the scope change bit harder than intended, and §3's one-line revert is the answer.
4. **No `COLLECTION_BROKEN` alerts.** This is new vocabulary shipping in this release. One arriving
   on day one is most likely real.

---

## 10. Rollback

**The migration.** Prisma has no down-migrations here. The scope change reverts in one statement
(§3). Everything else is additive DDL — new nullable columns, new empty tables, new indexes, two
enum values — none of which the old code reads, so **the previous application version runs
unmodified against the migrated schema.** That is the important property: a code rollback needs no
database rollback.

**The code.** `git checkout <previous main sha>` on the VPS and `docker compose up -d --build`.
Record `d5b9248` as that sha before you start.

**Full restore**, only if something genuinely corrupts data:

```bash
docker compose down
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < ~/backup-pre-release-<stamp>.dump
```

---

## 11. Open questions carried forward

**1. `GROUP_SYNC_TIMEOUT` is recurring in production, and it may mean the outage's recovery sweep
recovered nothing.** The System Logs screenshot from earlier in this work showed it on 7, 11 and 18
September: `getAllGroups()` is exceeding the 150 s ceiling on this deployment's ~1,848 groups.
`catchUpMissedMessages()` enumerates the same way. If enumeration was timing out during the
post-outage catch-up, the messages that were missed between 07:06 and 10:22 on 18 September may
never have been recovered at all. **Unconfirmed, and worth confirming** — it is a question about
customers who asked something and were never answered.

**2. The two day-boundary charts in `dashboardMetrics.ts`** (around lines 258 and 353) still use the
single-argument `AT TIME ZONE` form and are wrong by a day for any morning activity. Left alone
deliberately — fixing them changes numbers already on screen, which is a decision rather than a
refactor. Unchanged by this release; noted so it stays visible.

---

## 12. Findings from this verification (follow-ups, not blockers)

**`aiFallback.integration.test.ts` and `aiReplyHardening.integration.test.ts` are not hermetic with
respect to the knowledge base.** Both assume it is empty. Against the fixture database's 303 verified
entries, 12 tests failed — and every one of them failed by observing *correct* behaviour: the AI
answered because verified knowledge existed, and the query-expansion call ran because there was
something to expand against. `SlowMockAiClient` supplies a fixed list of two responses, so the extra
expansion call exhausted it and returned an empty completion.

Proven by control experiment: deleting **only** the seeded knowledge and leaving all 1,004,000
messages and every other migrated row in place turned all 62 tests green again, and the full
eight-suite run then passed 121/121.

This is a latent false-alarm generator — anybody running these suites against a database with
knowledge in it will see a dozen failures that mean nothing. Worth making the suites clear or scope
their own knowledge fixture. **Not a release blocker: no production defect is implied, and the
behaviour observed is the designed behaviour.**

A smaller instance of the same thing: `recoverStuckCommands({ atBoot: true })` counts every stranded
command globally, so a pre-existing `PROCESSING` row makes `recoveryRobustness.integration.test.ts`
count one more than its own fixture. That is correct behaviour for boot recovery and a fixture
assumption in the test.

---

## 13. One-line summary

Everything that can be verified without touching production has been verified, thoroughly, including
a full migration rehearsal against a million rows of representative data — the merge is clean and
safe to perform; the deployment needs three read-only production commands answered first.
