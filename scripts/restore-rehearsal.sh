#!/usr/bin/env bash
# Restore rehearsal — proves a backup can actually be restored (docs/get-assist-ultimate/19-backup-and-restore.md).
#
# It restores a dump made by scripts/backup.sh, and the media archive when given, into a THROWAWAY Postgres
# container that has no network at all (--network none: no port, nothing can connect), limited to 1 CPU and
# 2 GB, and removed with its storage when the script ends. It fails closed: a file not in a manifest, a
# checksum mismatch, too little disk, a restore error, a media file missing after extraction — each ends the
# run with FAILED and a non-zero exit. It prints counts only; never message text, names, numbers or keys.
#
# Disk: the restored database and the extracted media are written to Docker's own disk. Before starting it
# estimates what that needs and refuses without it plus RESTORE_MIN_FREE_GB (default 10) to spare; while
# running it checks every 5 s and stops the rehearsal if free space falls below the reserve. On the production
# server prefer a separate machine or disk (§4 of the doc).
#
# What it does NOT do: touch the running stack (docker-compose.yml) or the test stack (docker-compose.test.yml,
# whose port 5433 is published with a known password, so production data must never be restored there);
# restore anything into a database anyone uses. A real restore is a manual procedure: see §5 of the doc.
#
# Usage:  bash scripts/restore-rehearsal.sh <db-….dump> [media-….tar.gz]
# Env:    RESTORE_MIN_FREE_GB (default 10)   RESTORE_DUMP_EXPANSION (default 10: restored size ≈ dump × this,
#         used only when the live database size cannot be read)
# Tests:  scripts/tests/backup-scripts.test.sh (fake docker, no containers)
set -euo pipefail

DUMP="${1:-}"
MEDIA="${2:-}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then echo "Usage: bash scripts/restore-rehearsal.sh <db-….dump> [media-….tar.gz]" >&2; exit 2; fi
if [ -n "$MEDIA" ] && [ ! -f "$MEDIA" ]; then echo "Media archive not found: $MEDIA" >&2; exit 2; fi
MIN_FREE_GB="${RESTORE_MIN_FREE_GB:-10}"
EXPANSION="${RESTORE_DUMP_EXPANSION:-10}"
for n in "$MIN_FREE_GB" "$EXPANSION"; do
  case "$n" in ''|*[!0-9]*) echo "RESTORE_MIN_FREE_GB and RESTORE_DUMP_EXPANSION must be whole numbers" >&2; exit 2;; esac
done

IMAGE="postgres:16-alpine"
NAME="get-assist-restore-check-$$"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
fail() { log "FAILED: $*"; exit 1; }

# 1. Checksums first, and required: a file that is in no manifest, or that changed since, is refused before
#    anything starts. An unverifiable backup is not a backup this rehearsal can vouch for.
verify_checksum() {
  local file="$1" dir base line
  dir="$(cd "$(dirname "$file")/.." && pwd)"; base="$(basename "$(dirname "$file")")/$(basename "$file")"
  # sha256sum writes "<hash>  <path>" (text mode) or "<hash> *<path>" (binary mode); accept both.
  line="$(grep -h "[ *]$base\$" "$dir"/manifest-*.sha256 2>/dev/null | head -1 || true)"
  [ -n "$line" ] || fail "$base is in no manifest-*.sha256 next to it, so it cannot be verified. Copy the manifest with the backup."
  (cd "$dir" && echo "$line" | sha256sum -c --quiet - >/dev/null 2>&1) || fail "checksum mismatch for $base: the file changed after the backup was made."
  log "checksum: $base OK"
}
verify_checksum "$DUMP"
if [ -n "$MEDIA" ]; then verify_checksum "$MEDIA"; fi

# 2. Disk guard. Need: the restored database (the live database's size when this host runs it, read-only;
#    otherwise the dump × RESTORE_DUMP_EXPANSION) + the media archive's unpacked size + the reserve.
docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
free_kb() { df -Pk "$docker_root" 2>/dev/null | awk 'NR==2 {print $4}'; }
[ -n "$docker_root" ] && [ -n "$(free_kb)" ] \
  || fail "cannot read the free space of Docker's disk ($docker_root). Run this where Docker's data directory is visible to df."
reserve_kb=$(( MIN_FREE_GB * 1024 * 1024 ))
dump_kb=$(( ($(wc -c < "$DUMP") + 1023) / 1024 ))
live_bytes=""
if [ -f docker-compose.yml ] && [ -n "$(docker compose ps -q postgres 2>/dev/null || true)" ]; then
  live_bytes="$(docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT pg_database_size(current_database())"' 2>/dev/null | tr -d '[:space:]' || true)"
fi
case "$live_bytes" in ''|*[!0-9]*) db_kb=$(( dump_kb * EXPANSION )); db_basis="dump × $EXPANSION";;
                     *) db_kb=$(( live_bytes / 1024 )); db_basis="live database size";; esac
media_kb=0
if [ -n "$MEDIA" ]; then
  media_kb="$(tar -tvzf "$MEDIA" | awk '$1 ~ /^-/ {s += $3} END {printf "%d", (s + 1023) / 1024}')" || fail "the media archive could not be read."
fi
need_kb=$(( db_kb + media_kb + reserve_kb ))
have_kb="$(free_kb)"
log "disk: need about $(( need_kb / 1024 )) MB (database $(( db_kb / 1024 )) MB by $db_basis, media $(( media_kb / 1024 )) MB, reserve $MIN_FREE_GB GB); free $(( have_kb / 1024 )) MB"
[ "$have_kb" -ge "$need_kb" ] || fail "not enough free disk for Docker. Nothing was started. Use a separate machine or disk, or free space."

WATCHDOG=""
cleanup() {
  if [ -n "$WATCHDOG" ]; then kill "$WATCHDOG" 2>/dev/null || true; fi
  docker rm -f -v "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 3. Throwaway Postgres.
log "starting throwaway Postgres ($NAME, no network, 1 CPU, 2 GB)"
docker run -d --name "$NAME" --network none --cpus 1 --memory 2g \
  -e POSTGRES_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')" "$IMAGE" >/dev/null \
  || fail "could not start the throwaway Postgres container."
# Stop the rehearsal, not the server: if free space drops below the reserve, remove the container at once.
STOP_FLAG="$(mktemp)"; rm -f "$STOP_FLAG"
(
  while sleep 5; do
    f="$(free_kb || true)"
    if [ -n "$f" ] && [ "$f" -lt "$reserve_kb" ]; then
      touch "$STOP_FLAG"; docker rm -f -v "$NAME" >/dev/null 2>&1 || true; exit 0
    fi
  done
) &
WATCHDOG=$!
stopped() { [ -f "$STOP_FLAG" ] && fail "free disk fell below the $MIN_FREE_GB GB reserve; the rehearsal was stopped and its container removed."; return 0; }

for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -q || fail "the throwaway Postgres did not start."
docker exec "$NAME" createdb -U postgres restore_check

# 4. Database.
started=$(date +%s)
log "restoring $(du -h "$DUMP" | cut -f1) dump"
if ! docker exec -i "$NAME" pg_restore -U postgres -d restore_check --no-owner --no-acl --exit-on-error < "$DUMP"; then
  stopped
  fail "pg_restore stopped on an error (above). This backup cannot be restored as it is."
fi
stopped
log "restore: $(( $(date +%s) - started ))s"

q() { docker exec "$NAME" psql -U postgres -d restore_check -tAc "$1"; }
applied="$(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")"
[ "${applied:-0}" -gt 0 ] || fail "the restored database has no applied migrations."
log "migrations applied: $applied"
log "newest migration:  $(q "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1")"
log "unfinished:        $(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")"
if [ -d packages/db/prisma/migrations ]; then
  log "this checkout has $(ls packages/db/prisma/migrations | grep -c '^2') migrations, newest $(ls packages/db/prisma/migrations | grep '^2' | sort | tail -1)"
fi
log "tables: $(q "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
log "same-project triggers: $(q "SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%same_project%'")"
for t in Project User WhatsAppAccount WhatsAppGroup Message OutboundMessage Client ClientPayment; do
  if [ "$(q "SELECT to_regclass('public.\"$t\"') IS NOT NULL")" = "t" ]; then
    log "rows $t: $(q "SELECT count(*) FROM \"$t\"")"
  fi
done

# 5. Media: extract the archive inside the same throwaway container (its storage is removed with it), then
#    check that it unpacked completely and that every file the restored database says is stored exists.
#    Storage keys are paths relative to the media volume's root (packages/media-storage).
if [ -z "$MEDIA" ]; then
  log "PASSED (database only): the dump restored into an empty database. Media was NOT checked; pass the media archive to check it."
  exit 0
fi
log "media: extracting"
docker exec -i "$NAME" sh -c 'mkdir -p /restore-media && tar -xzf - -C /restore-media' < "$MEDIA" || { stopped; fail "the media archive did not extract."; }
stopped
listed="$(tar -tzf "$MEDIA" | grep -vc '/$' || true)"
extracted="$(docker exec "$NAME" sh -c 'find /restore-media -type f | wc -l' | tr -d '[:space:]')"
[ "$listed" = "$extracted" ] || fail "the media archive lists $listed files but $extracted were extracted."
extracted_kb="$(docker exec "$NAME" sh -c 'find /restore-media -type f -exec stat -c %s {} + | awk "{s += \$1} END {printf \"%d\", (s + 1023) / 1024}"' | tr -d '[:space:]')"
[ "$extracted_kb" = "$media_kb" ] || fail "the media archive holds $media_kb KB but $extracted_kb KB were extracted."
log "media: $extracted files, $(( extracted_kb / 1024 )) MB extracted, matching the archive"
if [ "$(q "SELECT to_regclass('public.\"MessageMedia\"') IS NOT NULL")" = "t" ]; then
  stored="$(q "SELECT count(*) FROM \"MessageMedia\" WHERE status = 'STORED' AND \"storageKey\" IS NOT NULL")"
  missing="$(docker exec "$NAME" sh -c 'psql -U postgres -d restore_check -tAc "SELECT \"storageKey\" FROM \"MessageMedia\" WHERE status = '"'"'STORED'"'"' AND \"storageKey\" IS NOT NULL" | while read -r k; do [ -f "/restore-media/$k" ] || echo x; done | wc -l' | tr -d '[:space:]')"
  log "media: $stored files the database records as stored; missing from the archive: $missing"
  # A media cleanup that ran between the dump and the archive deletes the file before marking its row, so
  # it can cause a small mismatch. That is still a mismatch: re-run with a fresh backup pair to confirm.
  [ "$missing" = "0" ] || fail "$missing stored media files are missing from the archive. Re-run with a fresh backup; if it repeats, media is being lost."
fi

log "PASSED: the dump restored into an empty database and the media archive restored completely. The throwaway container is removed now."
