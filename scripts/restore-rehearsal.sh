#!/usr/bin/env bash
# Restore rehearsal — proves a backup can actually be restored (docs/get-assist-ultimate/19-backup-and-restore.md).
#
# It restores a dump made by scripts/backup.sh into a THROWAWAY Postgres container that has no network at all
# (--network none: no port, nothing can connect), limited to 1 CPU and 2 GB so the live services keep their
# share, and removed with its storage when the script ends. It then prints counts only: migrations, tables,
# and rows in a few key tables. Never message text, names, numbers or any other content.
#
# What it does NOT do: touch the running stack (docker-compose.yml) or the test stack (docker-compose.test.yml,
# whose port 5433 is published with a known password, so production data must never be restored there);
# restore anything into a database anyone uses. A real restore is a manual procedure: see §5 of the doc.
#
# Usage:  bash scripts/restore-rehearsal.sh <db-….dump> [media-….tar.gz]
set -euo pipefail

DUMP="${1:-}"
MEDIA="${2:-}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then echo "Usage: bash scripts/restore-rehearsal.sh <db-….dump> [media-….tar.gz]" >&2; exit 2; fi
if [ -n "$MEDIA" ] && [ ! -f "$MEDIA" ]; then echo "Media archive not found: $MEDIA" >&2; exit 2; fi

IMAGE="postgres:16-alpine"
NAME="get-assist-restore-check-$$"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# Checksums first: a copy that changed in transit must fail here, not half-way through a restore.
verify_checksum() {
  local file="$1" dir base manifest line
  dir="$(cd "$(dirname "$file")/.." && pwd)"; base="$(basename "$(dirname "$file")")/$(basename "$file")"
  # sha256sum writes "<hash>  <path>" (text mode) or "<hash> *<path>" (binary mode); accept both.
  line="$(grep -h "[ *]$base\$" "$dir"/manifest-*.sha256 2>/dev/null | head -1 || true)"
  if [ -z "$line" ]; then log "checksum: no manifest entry for $base (not verified)"; return 0; fi
  if (cd "$dir" && echo "$line" | sha256sum -c --quiet -); then log "checksum: $base OK"; else log "FAILED: checksum mismatch for $base"; exit 1; fi
}
verify_checksum "$DUMP"
if [ -n "$MEDIA" ]; then verify_checksum "$MEDIA"; fi

cleanup() { docker rm -f -v "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "starting throwaway Postgres ($NAME, no network, 1 CPU, 2 GB)"
docker run -d --name "$NAME" --network none --cpus 1 --memory 2g \
  -e POSTGRES_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -q || { log "FAILED: the throwaway Postgres did not start"; exit 1; }
docker exec "$NAME" createdb -U postgres restore_check

started=$(date +%s)
log "restoring $(du -h "$DUMP" | cut -f1) dump"
if ! docker exec -i "$NAME" pg_restore -U postgres -d restore_check --no-owner --no-acl --exit-on-error < "$DUMP"; then
  log "FAILED: pg_restore stopped on an error (above). This backup cannot be restored as it is."
  exit 1
fi
elapsed=$(( $(date +%s) - started ))
log "restore: ${elapsed}s"

q() { docker exec "$NAME" psql -U postgres -d restore_check -tAc "$1"; }
log "migrations applied: $(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")"
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

if [ -n "$MEDIA" ]; then
  # Listing reads the whole archive, so a truncated or corrupt file fails here.
  files="$(tar -tzf "$MEDIA" | grep -vc '/$' || true)"
  log "media archive: $files files, readable"
fi

log "PASSED: the dump restored into an empty database. The throwaway container is removed now."
