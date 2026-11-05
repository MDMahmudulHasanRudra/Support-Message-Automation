# 19 — Backup and restore (P1-4)

**Status (5 Nov 2026):** scripts written, the review findings BKP-01 to BKP-05 fixed, and 21 failure tests run in CI
(§8). **Not yet run on the server, and no real restore has been rehearsed.** Until the first rehearsal passes, treat
backups as unproven. Do not schedule it in production before this branch is merged.

| File | What it does |
|---|---|
| `scripts/backup.sh` | Postgres dump + media volume (+ WhatsApp sessions when asked), checksums, retention. Any expected part missing fails the run |
| `scripts/restore-rehearsal.sh` | Verifies checksums (required), checks disk, restores the dump and extracts the media into a throwaway networkless container, checks every stored media file is present |
| `scripts/tests/backup-scripts.test.sh` | 21 cases with a fake `docker`; run by CI |
| `docker-compose.yml` | Passes the three `*_PROCESSOR_DISABLED` switches into `app` (§5). Unset = unchanged |

## 1. What is backed up, and what is not

| Data | Backed up | Notes |
|---|---|---|
| Postgres (every customer, project, message, client, invoice) | **yes**, `pg_dump -Fc`, one consistent snapshot | Read-only for the database; no lock beyond what a normal read takes |
| Media volume `support_automation_media` | **yes**, tar.gz, read-only mount | Not in the database dump. `MEDIA_STORAGE.md` |
| WhatsApp sessions `support_automation_whatsapp_session` | **only with `BACKUP_WHATSAPP_SESSIONS=1`** | Login credentials for every linked number. Without them a restore means scanning QR codes again. A copy of a live browser profile can be inconsistent |
| `.env` (passwords, `AI_CREDENTIALS_ENCRYPTION_KEY`, Meta and Google secrets) | **no, on purpose** | Keep it in a password manager or other secret store, apart from the backups. **Without the encryption key, every encrypted credential in a dump is unreadable** (AI providers, channels, Google, email) |
| Code | no | It is in git. The dump file name records the commit it was taken at |
| Caddy configuration and certificates | no | Lives on the host, outside this repository |

## 2. Install (on the server, by Rudra)

```bash
cd ~/Support-Message-Automation
bash scripts/backup.sh          # first run by hand; read the output
ls -lh ~/backups/get-assist/db ~/backups/get-assist/media
```

Then schedule it once a day at a quiet hour (`crontab -e`):

```
17 3 * * * cd $HOME/Support-Message-Automation && bash scripts/backup.sh >> $HOME/backups/get-assist/backup.log 2>&1
```

Defaults: `~/backups/get-assist`, 14 days kept, never fewer than 3 of each kind. Override with `BACKUP_DIR`,
`BACKUP_RETENTION_DAYS`, `BACKUP_KEEP_MIN`. The script refuses to start without enough free disk (about twice the
largest previous backup plus 1 GB), because Postgres writes to the same disk.

A daily backup means up to 24 hours of database changes can be lost (RPO). Run it more often if that is too much.
Each run reads the whole database, so measure the run time first (§4).

## 3. Off-host copy — required, not automated

A backup on the server's own disk does not survive losing that disk, the VPS or the provider account. Copy
`~/backups/get-assist` to a second place (another provider's object storage, or a machine you control) after each
run. The destination and its credentials are your decision, so the script does not choose one. Check a copy with:

```bash
cd <copy>/get-assist && sha256sum -c manifest-<stamp>.sha256
```

The files hold every customer's data. Keep the copy encrypted at rest and access-restricted.

## 4. Rehearse a restore

Run it after installing, then monthly and after any large migration:

```bash
cd ~/Support-Message-Automation
bash scripts/restore-rehearsal.sh ~/backups/get-assist/db/db-<stamp>-<commit>.dump ~/backups/get-assist/media/media-<stamp>.tar.gz
```

What it does, failing closed at each step (`FAILED`, non-zero exit):
1. **Checksums are required.** A file in no `manifest-*.sha256`, or one that changed since, is refused before
   anything starts. Copy the manifests together with the backups.
2. **Disk guard.** It estimates what Docker's disk needs, then refuses without that plus `RESTORE_MIN_FREE_GB`
   (default 10) to spare. The estimate is the restored database plus the media archive's unpacked size. The
   database figure is the live database's size when this host runs it (one read-only query). Otherwise it is
   the dump × `RESTORE_DUMP_EXPANSION` (default 10). While running, it checks every 5 s and removes the
   container if free space falls below the reserve.
3. It restores into a new `postgres:16-alpine` container with **no network**, 1 CPU and 2 GB. The restored
   database must have applied migrations.
4. **Media is restored, not just listed.** The archive is extracted inside the same container. The number of
   files and bytes must match the archive. **Every file the restored database records as STORED
   (`MessageMedia.storageKey`) must be present.** Without a media archive the result says "database only".
5. The container and its storage are removed, also after a failure. Only counts are printed.

**Where to run it.** Prefer a separate machine or disk: a full restore writes about as much as the live database.
On the production server, run it only at a quiet hour, after reading the `disk:` line it prints first.

It never uses `docker-compose.test.yml`: that stack publishes port 5433 with a known password. Record the result
and the restore time (`restore: Ns`, the RTO's main part) in `18-progress-and-decisions.md`.

## 5. Real restore (disaster only, by hand)

Restore only when the data itself is lost or wrong. To undo a migration, roll forward instead (`DEPLOY.md`).
Everything written after the backup is gone from the database.

1. **Stop everything that writes or sends:** `docker compose stop app worker`.
2. **Keep the damaged database** rather than dropping it:
   ```bash
   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "ALTER DATABASE \"$POSTGRES_DB\" RENAME TO before_restore_$(date +%Y%m%d)"'
   docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
   ```
3. **Restore:**
   ```bash
   docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --exit-on-error' < ~/backups/get-assist/db/db-<stamp>-<commit>.dump
   ```
4. **Bring the schema up to the running code:** `docker compose run --rm migrate`.
5. **Media**, if lost (extracts over the volume):
   ```bash
   docker run --rm --network none -v support_automation_media:/dst -v ~/backups/get-assist/media:/b:ro postgres:16-alpine tar -C /dst -xzf /b/media-<stamp>.tar.gz
   ```
6. **Check the restored send queues before anything can send.** Rows that were waiting at backup time may have
   been sent afterwards. Started as they are, they would message customers a second time. Read-only:
   ```sql
   SELECT 'outbound' q, status::text, count(*), min("createdAt") FROM "OutboundMessage" WHERE status IN ('PENDING','PROCESSING','RATE_LIMITED') GROUP BY 2
   UNION ALL SELECT 'notification', status::text, count(*), min("createdAt") FROM "Notification" WHERE status IN ('PENDING','RETRYING') GROUP BY 2
   UNION ALL SELECT 'command', status::text, count(*), min("createdAt") FROM "WorkerCommand" WHERE status IN ('PENDING','PROCESSING') GROUP BY 2
   UNION ALL SELECT 'channel', "deliveryStatus"::text, count(*), min("createdAt") FROM "ChannelMessage" WHERE "deliveryStatus" IN ('QUEUED','SENDING') GROUP BY 2
   UNION ALL SELECT 'email', status::text, count(*), min("createdAt") FROM "EmailOutbox" WHERE status IN ('QUEUED','SENDING') GROUP BY 2
   UNION ALL SELECT 'social', status, count(*), min("createdAt") FROM "SocialPostTarget" WHERE status IN ('DUE','PUBLISHING') GROUP BY 2;
   ```
   Decide per queue whether to cancel. For WhatsApp replies that is
   `UPDATE "OutboundMessage" SET status = 'CANCELLED' WHERE status IN ('PENDING','PROCESSING','RATE_LIMITED');`.
   Write the decision in `18`.
7. **Start the app with its background senders off**, by setting these in `.env`:
   ```
   SMART_IMPORT_PROCESSOR_DISABLED=true
   INTEGRATIONS_PROCESSOR_DISABLED=true
   SOCIAL_PROCESSOR_DISABLED=true
   ```
   Then run `docker compose up -d --no-deps --force-recreate app`, and check sign-in and a few pages.
8. **Start the worker:** `docker compose up -d --no-deps worker`. On connect, the catch-up sweep reads back WhatsApp
   messages since each account's restored checkpoint. It looks back at most `CATCHUP_MAX_LOOKBACK_HOURS` (12), and
   anything older than 15 minutes is stored without rules or replies (`CLAUDE.md`, "Collecting every message").
   Messages older than 12 hours are not recovered. This behaviour was not tested against a restore.
9. **Turn the app's processors back on** (remove the three lines and recreate `app`) after step 6's queues are settled.
10. Drop `before_restore_<date>` only after a few days of normal running.

## 6. Rollback of this package

Remove the cron line. Both scripts change nothing unless run. The compose change only passes three variables,
which are empty unless set, so the app behaves as before.

## 7. Not covered yet

- The first real backup on the server, its run time and its size.
- The first real rehearsal (RTO).
- Off-host copy (§3).
- ~~A backup alert~~ — built (`feat/backup-alerts`). `backup.sh` records every run that passed the lock in
  `BackupRun`: status, times, sizes, and a reason with no paths. Recording is best effort and never changes the
  run's exit code. The worker's `backup-watch` (every 15 min) emails active platform operators once when the
  latest run failed and once when no backup succeeded for `BACKUP_ALERT_STALE_HOURS` (26 by default; 0 turns
  that off). Both are deduplicated by a `BackupAlert` key until the next success. It stays silent until a first
  run is recorded. Platform → Overview shows a Backups section. Needs platform email (Platform → Settings or
  `PLATFORM_SMTP_*`); without it, the alert is recorded as not delivered.
- Point-in-time recovery (WAL archiving). Only if a 24-hour RPO is not acceptable.

## 8. What was tested, and how

No container was started. `scripts/tests/backup-scripts.test.sh` runs both scripts against a fake `docker` (plus a
fake `psql`, `flock` or `df` where a case needs one). The fake logs every call, so a case can prove nothing was
started. CI runs it in the "Typecheck, lint, unit tests" job.

Each case was confirmed to fail against the scripts as first committed (`3525548`) before being kept. 10 of 21
failed there, exactly the review findings. The other 11 pin behaviour that was already correct.

| Finding (review of 5 Nov) | Fix | Test that fails on `3525548` |
|---|---|---|
| BKP-01 checksum fail-open | A missing manifest or entry is `FAILED` | "no manifest entry fails before any container starts" |
| BKP-02 media volume silently skipped | A missing media volume (or sessions volume, when asked) fails the run; no manifest | two "BKP-02" cases |
| BKP-03 media only listed | Extracted in the container; file count and bytes match; every STORED key present | "a file the database records as stored but missing…" |
| BKP-04 no disk guard on restore | Estimate + reserve before start; 5 s watchdog during | two "BKP-04" cases |
| BKP-05 `pg_restore -l \| grep -q` under pipefail | Listing to a file, then `grep` | "a table of contents far larger than a pipe buffer…" (reproduced: SIGPIPE → false failure) |

Not tested: real `pg_dump` / `pg_restore`, busybox `tar` / `find` / `stat` inside `postgres:16-alpine`, the
networkless container, the watchdog firing mid-restore, a real restore, and file permissions on Linux. The
first rehearsal on a real machine is what proves those.

## 9. P1-4 is complete when

| Requirement | Status |
|---|---|
| Scripts committed and pushed | done |
| CI passed | done (run `41981224056`; re-run after the fixes) |
| Failure tests, fail-closed verification | done (§8) |
| Real database backup on the server | pending — Rudra |
| Real restore rehearsal, on a separate machine or a checked disk | pending — Rudra |
| Media restoration verified by the rehearsal | pending — same run |
| Off-server encrypted copy | pending — Rudra chooses the destination |
| Scheduled backup with a failure alert | alert built; cron (§2) and a tested alert email — pending, Rudra |
