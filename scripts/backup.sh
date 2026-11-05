#!/usr/bin/env bash
# Backup — run on the server from the checkout (docs/get-assist-ultimate/19-backup-and-restore.md).
#
# What it writes: one Postgres dump (pg_dump custom format, compressed) and one tar.gz of the media volume
# per run, plus the WhatsApp session volume only when BACKUP_WHATSAPP_SESSIONS=1, into BACKUP_DIR, with a
# SHA-256 manifest. Each file is written under a temporary name and renamed only once it is complete and
# verified, so a partial file never looks like a backup. Every part that was expected and could not be made
# fails the run (non-zero exit, a FAILED line): a run that exits 0 made everything it was asked for.
#
# What it does NOT do: stop, restart, build or recreate a container; touch a WhatsApp session; write to the
# database (pg_dump reads one consistent snapshot); copy .env or any secret; send anything off this host.
# A backup on the same disk does not survive losing that disk: copy BACKUP_DIR elsewhere (§3 of the doc).
#
# Usage:  bash scripts/backup.sh            # from the checkout that holds docker-compose.yml
# Env:    BACKUP_DIR (default ~/backups/get-assist)   BACKUP_RETENTION_DAYS (default 14)
#         BACKUP_KEEP_MIN (default 3)                  BACKUP_WHATSAPP_SESSIONS (default 0)
# Tests:  scripts/tests/backup-scripts.test.sh (fake docker, no containers)
set -euo pipefail
umask 077   # backups hold every customer's data: readable by this user only, from the moment they exist

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/get-assist}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
KEEP_MIN="${BACKUP_KEEP_MIN:-3}"
WITH_SESSIONS="${BACKUP_WHATSAPP_SESSIONS:-0}"
MEDIA_VOLUME="support_automation_media"
SESSION_VOLUME="support_automation_whatsapp_session"
# The postgres image is already on the host; using it for tar avoids pulling another image during a backup.
HELPER_IMAGE="postgres:16-alpine"

for n in "$RETENTION_DAYS" "$KEEP_MIN"; do
  case "$n" in ''|*[!0-9]*) echo "BACKUP_RETENTION_DAYS and BACKUP_KEEP_MIN must be whole numbers" >&2; exit 2;; esac
done
if [ "$KEEP_MIN" -lt 1 ]; then echo "BACKUP_KEEP_MIN must be at least 1" >&2; exit 2; fi
if [ ! -f docker-compose.yml ]; then echo "Run this from the checkout that holds docker-compose.yml." >&2; exit 2; fi
# A missing tool must fail loudly: read as "busy", it would skip every backup and still exit 0.
for tool in docker flock sha256sum tar find df awk; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FAILED: $tool is not installed. No backup written." >&2; exit 1; }
done

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
fail() { log "FAILED: $*"; exit 1; }

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/media" "$BACKUP_DIR/sessions"
chmod 700 "$BACKUP_DIR"

# One backup at a time: a second cron run while the first is still dumping would double the I/O for nothing.
exec 9>"$BACKUP_DIR/.lock"
if ! flock -n 9; then log "another backup is still running; nothing done"; exit 0; fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
DB_FILE="$BACKUP_DIR/db/db-$STAMP-$COMMIT.dump"
MEDIA_FILE="$BACKUP_DIR/media/media-$STAMP.tar.gz"
SESSION_FILE="$BACKUP_DIR/sessions/sessions-$STAMP.tar.gz"
TOC_FILE="$BACKUP_DIR/.toc-$STAMP"
cleanup() { rm -f "$DB_FILE.part" "$MEDIA_FILE.part" "$SESSION_FILE.part" "$TOC_FILE"; }
trap cleanup EXIT

# Refuse rather than fill the disk Postgres writes to. Need room for roughly one more of the largest
# existing backups plus 1 GB; the first run only needs the 1 GB.
largest_kb="$(find "$BACKUP_DIR" -type f \( -name '*.dump' -o -name '*.tar.gz' \) -printf '%k\n' 2>/dev/null | sort -n | tail -1)"
need_kb=$(( ${largest_kb:-0} * 2 + 1048576 ))
free_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
case "$free_kb" in ''|*[!0-9]*) fail "could not read the free disk space of $BACKUP_DIR. No backup written.";; esac
if [ "$free_kb" -lt "$need_kb" ]; then
  fail "only $((free_kb / 1024)) MB free in $BACKUP_DIR, need about $((need_kb / 1024)) MB. No backup written."
fi

# 1. Database. -Fc is compressed and lets pg_restore list and restore selectively. Ownership and grants
#    are dropped at restore time (pg_restore --no-owner --no-acl); pg_dump ignores those flags for -Fc.
log "database: dumping"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$DB_FILE.part" \
  || fail "pg_dump stopped with an error. No database backup written."
# Verify the archive is complete and readable: pg_restore must read its whole table of contents, and it must
# contain the migrations table, which every real dump of this database has. The listing goes to a file first:
# piped straight into `grep -q`, grep would stop at the first match, pg_restore would get SIGPIPE, and
# pipefail would report a good dump as unreadable.
docker compose exec -T postgres pg_restore -l < "$DB_FILE.part" > "$TOC_FILE" \
  || fail "the database dump could not be read back (pg_restore -l). No database backup written."
grep -q '_prisma_migrations' "$TOC_FILE" \
  || fail "the database dump has no _prisma_migrations table; it is not a dump of this database. No database backup written."
mv "$DB_FILE.part" "$DB_FILE"
log "database: $(du -h "$DB_FILE" | cut -f1), $(wc -l < "$TOC_FILE") archive entries -> $DB_FILE"

# 2. Media volume, read-only mount. Required: compose names it explicitly, so a missing volume means the
#    wrong host, a renamed volume or lost media, and a backup without it is not a backup of this system.
#    A file being written during the copy may be caught half-way; the next run catches it whole, and
#    MessageMedia rows only point at files after they are complete.
archive_volume() {
  local volume="$1" target="$2"
  docker volume inspect "$volume" >/dev/null 2>&1 \
    || fail "Docker volume $volume not found. Nothing was archived from it (the database dump above is kept)."
  docker run --rm --network none -v "$volume":/src:ro "$HELPER_IMAGE" tar -C /src -czf - . > "$target.part" \
    || fail "archiving $volume stopped with an error."
  tar -tzf "$target.part" >/dev/null || fail "the $volume archive could not be read back."   # truncated -> fails
  mv "$target.part" "$target"
  log "$volume: $(du -h "$target" | cut -f1) -> $target"
}
archive_volume "$MEDIA_VOLUME" "$MEDIA_FILE"

# 3. WhatsApp sessions, only when asked — then required like media. They are login credentials for every
#    linked number, and copying a live browser profile can catch it mid-write; without them a restore means
#    scanning QR codes again.
if [ "$WITH_SESSIONS" = "1" ]; then
  archive_volume "$SESSION_VOLUME" "$SESSION_FILE"
fi

# 4. Manifest: what this run wrote, with checksums, so a copy elsewhere can be checked before use.
(
  cd "$BACKUP_DIR"
  for f in "db/$(basename "$DB_FILE")" "media/$(basename "$MEDIA_FILE")" "sessions/$(basename "$SESSION_FILE")"; do
    if [ -f "$f" ]; then sha256sum "$f"; fi   # not `[ … ] && …`: a skipped file would end the run under set -e
  done
) > "$BACKUP_DIR/manifest-$STAMP.sha256"

# 5. Retention: delete files older than RETENTION_DAYS, but never leave fewer than KEEP_MIN of a kind.
#    Names start with a UTC timestamp, so a name sort is a time sort.
prune() {
  local dir="$1" pattern="$2" total i=0
  total="$(find "$dir" -maxdepth 1 -type f -name "$pattern" | wc -l)"
  find "$dir" -maxdepth 1 -type f -name "$pattern" -mtime +"$RETENTION_DAYS" -print | sort | while read -r old; do
    if [ $(( total - i )) -le "$KEEP_MIN" ]; then break; fi
    rm -f "$old"; i=$(( i + 1 )); log "retention: removed $old"
  done
}
prune "$BACKUP_DIR/db" 'db-*.dump'
prune "$BACKUP_DIR/media" 'media-*.tar.gz'
prune "$BACKUP_DIR/sessions" 'sessions-*.tar.gz'
# A manifest goes only when every file it lists is gone, so a kept backup always keeps its checksums.
for m in "$BACKUP_DIR"/manifest-*.sha256; do
  [ -f "$m" ] || continue
  if ! awk '{ sub(/^\*/, "", $2); print $2 }' "$m" | (cd "$BACKUP_DIR" && while read -r f; do [ -f "$f" ] && exit 0; done; exit 1); then
    rm -f "$m"; log "retention: removed $m"
  fi
done

log "done: manifest-$STAMP.sha256"
