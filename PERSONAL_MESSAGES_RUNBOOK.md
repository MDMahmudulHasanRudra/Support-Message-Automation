# Personal (1:1) messages — diagnosis, hotfix release and backfill runbook

For the operator on the VPS. Written for the 18 Oct 2026 incident: **group messages arrive, many
personal messages do not.** Every step below says whether it is read-only. Nothing here restarts a
container, touches a WhatsApp session or writes to the database unless the step says **WRITES**.

---

## 1. Diagnose (read-only, ~1 minute)

The script lives at `scripts/diagnose-personal-messages.sh` on `rudra` (and in the hotfix release).
If the server checkout does not have it yet, copy the file to `/tmp/diag.sh` by hand — do **not**
`git pull` on the server just for this.

```bash
bash /tmp/diag.sh ~/Support-Message-Automation 2h > /tmp/diag.txt 2>&1
less /tmp/diag.txt
```

What it guarantees:

- **No restarts, no builds, no migrations.** It only runs `docker compose exec` / `logs` / `images` /
  `ps` and `git log`.
- **No database writes.** Its SQL session runs `SET default_transaction_read_only = on` first.
- **No private data.** It prints counts, commit ids, timestamps, account labels and account ids.
  Log lines are counted by one streaming `awk` pass and never printed, so a large log is never held
  in memory.

What to send back: the whole `/tmp/diag.txt`. Check it first; it should contain no phone numbers or
message text.

### Reading the result

| Section | What it tells you | What to look for |
|---|---|---|
| 1. Server checkout | the code ON DISK | not necessarily what is running |
| 2. What is running | fingerprints inside the containers, image build time | `36ccf91 ... NO` = the hotfix is not running; `3ae4a51 ... NO` = no personal recovery at all |
| 3. Migrations | applied vs. what the running image and the checkout expect | any "not applied" line must be resolved before a deploy |
| 4. Worker counters | since the worker started | with the hotfix: `collectionByKind` → `PERSONAL.received / stored / dropped / undecrypted` |
| 5. Worker log | live events by kind, unreadable messages, reconcile recoveries, chat-list failures, P2022 | `live personal` near 0 while customers are writing = the browser is not delivering them |
| 6. Database | per account and kind: stored live vs. late, per-day personal volume, drops, reconcile recoveries, personal chats outside the first 300 of "All" | see below |

- **Most GROUP messages are "late"** → the live listener is not attached (the `98c0378` registry
  fix); everything arrives through the 10-minute reconcile sweep, where personal chats lost out
  before `36ccf91`.
- **PERSONAL total is low or zero for recent days** → not stored. Check EMPTY_BODY drops
  (encrypted-on-arrival messages, voice notes) and "chat-list failures".
- **`in_all_top_300` far below `conversations` for personal** → stored but not visible under
  **All** in WhatsApp Chat. Use the **Personal** filter now; the hotfix keeps them in All.

### Trace one message end to end (read-only)

1. From an authorised test phone, send the business number a **text**, a **voice note** and a
   **photo**.
2. Wait 2 minutes; run the script again.
3. In WhatsApp Chat → the right number → **Personal**, open the test chat.
4. Expected: three new messages, "live" (not "late") in section 6, `PERSONAL.received` +3 in
   section 4 (hotfix builds).

---

## 2. Hotfix release candidate

**Branch `hotfix/personal-messages`, built on `main` (`c533d26`).** It contains only:

1. The registry wires the message handlers before the first connect (from `98c0378`).
2. The personal-message fixes (`36ccf91`).
3. The personal backfill utility, inert until called.

It deliberately leaves out the other Accounts/Groups audit changes in `98c0378` (Primary, Delete,
group switches, forced Reconnect, boot provisioning, session-file reset).

**No database migration.** Valid only if section 2 of the diagnosis shows production running
`main`'s code and section 3 shows no pending migration. If production runs something else, the
release candidate must be rebuilt on top of exactly that revision. Never deploy it on assumption.

### Preflight (all read-only)

- [ ] Diagnosis run; production revision identified (section 2), migrations all applied (section 3).
- [ ] Group sync is healthy (section 6, accounts table) — note each account's state to compare after.
- [ ] Docker resource limits read: `docker compose config | grep -n mem_limit` (Rifat's limits may be
      live on the server; the release must not remove them — see §5).
- [ ] The current images are tagged for rollback:
      `docker tag $(docker compose images -q worker) support-automation-worker:rollback-$(date +%Y%m%d)`
      and the same for `app`.
- [ ] A quiet time is chosen: rebuilding the worker reconnects every WhatsApp session for a few minutes.

### Deploy (WRITES — only with the owner's authorisation)

```bash
cd ~/Support-Message-Automation
# 1. Database backup
docker compose exec -T postgres sh -c 'pg_dump -U $POSTGRES_USER -d $POSTGRES_DB' \
  | gzip > ~/backups/pre-hotfix-$(date -u +%Y%m%d-%H%M).sql.gz
# 2. Code
git fetch && git checkout <hotfix commit>
# 3. Migrations: confirm nothing is pending (expected: "Database schema is up to date!")
docker compose build migrate && docker compose run --rm --entrypoint "npx prisma migrate status" migrate
# 4. Build first, so the outage is only the restart
docker compose build worker app
# 5. Stop the worker, back up the session volume while nothing writes to it, start the new worker
docker compose stop worker
docker run --rm -v support_automation_whatsapp_session:/s -v ~/backups:/b alpine \
  tar czf /b/sessions-pre-hotfix-$(date -u +%Y%m%d-%H%M).tgz -C /s .
docker compose up -d --no-deps --force-recreate worker
docker compose up -d --no-deps --force-recreate app
```

(The session volume is `support_automation_whatsapp_session` in docker-compose.yml; confirm with
`docker volume ls | grep session` before running it. Media is a separate volume and is not touched.)

### Acceptance (after deploy)

- [ ] `docker compose ps`: worker and app healthy.
- [ ] Diagnosis again: section 2 shows `36ccf91 ... yes` for worker and app.
- [ ] Each account back to CONNECTED; group sync state as before.
- [ ] Test **text**, **voice note** and **photo** from the test phone: stored, live, visible under
      **Personal** and under **All**.
- [ ] Group messages keep arriving: section 6 shows group "live" counts rising.
- [ ] `collectionByKind` shows PERSONAL `received` and `stored` rising together, `dropped` flat.
- [ ] No unexpected replies: no new `AUTO_REPLY` OutboundMessage to the test chat unless a rule
      should have fired.
- [ ] Worker memory: `docker stats --no-stream` — compare with before.

Mock tests are not proof of WhatsApp behaviour: only the steps above, with real phones, verify it.

### Rollback (WRITES)

```bash
docker tag support-automation-worker:rollback-<date> <the worker image name from docker compose images>
docker compose up -d --no-deps --force-recreate worker
# same for app, or: git checkout <previous commit> && docker compose up -d --build --no-deps worker app
```

No schema change ships in this release, so rolling back never needs a database restore. Restore the
session volume only if sessions were damaged, which a normal restart does not do.

---

## 3. Historical backfill (dry run is read-only; a write run WRITES)

Recovers personal messages that never reached the database, from what WhatsApp Web still holds or
can still fetch from the phone. It is **store-only**: no rule runs, no AI replies, no notification is
sent, no wait or case is opened, and nothing already stored is changed. **Only available once the
hotfix is running.**

```bash
# Which accounts? (ids are in section 6 of the diagnosis)
# DRY RUN — the default: counts only, writes nothing (not even a progress file)
docker compose exec -T worker curl -s -X POST \
  "http://127.0.0.1:4100/backfill/personal?account=<ACCOUNT_ID>&from=2026-10-11T00:00:00Z&to=2026-10-18T23:59:59Z"
# progress / result
docker compose exec -T worker curl -s http://127.0.0.1:4100/backfill/personal
# stop after the chat in progress
docker compose exec -T worker curl -s -X POST http://127.0.0.1:4100/backfill/personal/cancel
```

Limits: one account per run, a range of at most 14 days, `maxChats` (default 500, max 2,000),
`earlierPages` (older-history pages per chat fetched from the phone; default 2, max 10), one chat at a
time with a 0.5 s pause, one run per worker.

The result, per run:

| Field | Meaning |
|---|---|
| `available` | messages WhatsApp still holds in the range (readable or not) |
| `alreadyStored` | already in the database |
| `recoverable` | readable, in range, not stored — what a write run would add |
| `unreadable` | still encrypted or empty — WhatsApp holds them but there is nothing to store |
| `deleted` | deleted for everyone — nothing to recover |
| `chatsPartial` | chats whose read did not reach the start of the range (older history not available) |
| `chatsFailed` | chats that could not be read (retried once); a later run retries them |
| `chatsSkippedByCap` | chats beyond `maxChats` |
| `elapsedMs` / `chatsDone` | for estimating a full run |

**A WRITE run needs separate authorisation from the owner.** It is the same call plus
`&mode=write&confirm=WRITE`. It checkpoints each finished chat in a file beside the account's session,
so an interrupted or cancelled run resumes, and a second run stores nothing twice. Recovery is never
promised to be complete: messages WhatsApp Web no longer holds cannot be recovered by any means here.

---

## 4. What the hotfix changes (for reviewers)

`CLAUDE.md` → "Personal (1:1) messages are recovered on their own terms" holds the rules. In short:

- Recovery reads personal chats whatever the group list does, each kind with its own limit.
- The catch-up never moves the account's checkpoint past an incomplete read.
- Messages that arrive still encrypted are re-read until readable.
- Media is recognised by type.
- WhatsApp Chat "All" keeps the 100 most recent personal chats.
- `/metrics` counts per account per kind.

## 5. Open items around this release

- **Rifat's `dev/rifat` commits** (container memory limits and the build-script fix) are not in
  `main` or `rudra`. If the server's compose file already carries `mem_limit`, the release must keep
  it; compare `docker compose config` on the server with the hotfix checkout before deploying.
- The other audit fixes on `rudra` (`98c0378`) ship in a later, normal release.
