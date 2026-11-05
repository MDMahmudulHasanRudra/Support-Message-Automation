# 19 — Backup and restore (P1-4)

**Status (5 Nov 2026):** scripts written and dry-run tested with a fake `docker` (§8). **Not yet run on the
server, and no real restore has been rehearsed.** Until the first rehearsal passes, treat backups as unproven.

| File | What it does |
|---|---|
| `scripts/backup.sh` | Postgres dump + media volume (+ WhatsApp sessions when asked), checksums, retention |
| `scripts/restore-rehearsal.sh` | Restores a dump into a throwaway, networkless container and prints counts |
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

What it does:
- It checks the files against the manifest first.
- It restores into a new `postgres:16-alpine` container with **no network**, 1 CPU and 2 GB, then removes the
  container and its storage.
- It prints only counts: migrations, tables, same-project triggers, rows in eight key tables, and media files.

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
- A backup alert. A failed run exits non-zero and writes `FAILED` to `backup.log`, but nobody is told. Candidate:
  the Notification Center, once P1-6 metrics exist.
- Point-in-time recovery (WAL archiving). Only if a 24-hour RPO is not acceptable.

## 8. What was tested, and how

No container was started. Both scripts were run on Windows (Git Bash) with a fake `docker` and `flock` that log
each call and return canned output:

| Check | Result |
|---|---|
| `bash -n` on both scripts | pass (shellcheck not installed) |
| `backup.sh`: missing `flock` → loud failure, exit 1 | pass. The first version printed "already running" and exited 0, so it skipped every backup silently. Fixed |
| `backup.sh`: dump, verify, media archive, manifest, exit 0 | pass. The first version exited 1 after the manifest (`[ … ] && …` under `set -e`). Fixed |
| Retention: 5 dumps 20 days old + 1 new, keep 14 days / min 3 | removed the 3 oldest, kept 3; media (2) untouched |
| Manifest removed only when all its files are gone | pass |
| Second run while locked → exit 0, nothing written | pass |
| `BACKUP_WHATSAPP_SESSIONS=1` adds the session archive to the manifest | pass |
| Rehearsal: intact files pass the checksum; container removed after a failing step | pass |
| Rehearsal: corrupted dump refused before any `docker` call | pass |

Not tested: `pg_dump`/`pg_restore` themselves, the networkless container, the real restore, and file permissions
(Windows ignores them; on Linux `umask 077` applies).
