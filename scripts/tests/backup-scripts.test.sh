#!/usr/bin/env bash
# Tests for scripts/backup.sh and scripts/restore-rehearsal.sh. No container is started: a fake `docker` (and
# fake psql / flock / df where a case needs one) answers each call, and every call is logged so a case can
# assert that nothing was started. Run from the repository root:  bash scripts/tests/backup-scripts.test.sh
# Exit 0 only when every case passed. CI runs it (.github/workflows/ci.yml).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAKE="$WORK/fake"; mkdir -p "$FAKE"
PASS=0; FAILS=0

# ---------------------------------------------------------------------------------------------------------
# Fakes. State lives in $WORK/state; each test resets it.
cat > "$FAKE/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$STATE/calls.log"
mapdir() { local s="$1"; printf '%s' "${s//\/restore-media/$STATE/media}"; }
case "$*" in
  "compose exec -T postgres sh -c"*pg_dump*)
    [ -n "${FAKE_DUMP_FAIL:-}" ] && exit 1
    printf 'PGDMP fake archive\n' ;;
  "compose exec -T postgres pg_restore -l")
    head -c 5 | grep -q PGDMP || { echo "pg_restore: error: input file is not a valid archive" >&2; exit 1; }
    echo "215; 1259 16385 TABLE public _prisma_migrations postgres"
    for i in $(seq 1 "${FAKE_TOC_LINES:-0}"); do echo "$i; 1259 1 TABLE public filler_table_with_a_long_name_$i postgres"; done ;;
  "compose ps -q postgres") [ -n "${FAKE_LIVE_DB_BYTES:-}" ] && echo abc123 ;;
  "compose exec -T postgres sh -c"*pg_database_size*) echo "${FAKE_LIVE_DB_BYTES:-}" ;;
  "volume inspect "*) case " ${FAKE_VOLUMES:-} " in *" ${3} "*) exit 0;; *) exit 1;; esac ;;
  "run --rm --network none -v "*) tar -C "$STATE/src" -czf - . ;;
  "info --format"*) echo "$STATE/dockerroot" ;;
  "run -d --name "*) mkdir -p "$STATE/media"; echo started >> "$STATE/container" ;;
  "rm -f -v "*) rm -f "$STATE/container" ;;
  "exec "*" pg_isready "*|"exec "*" createdb "*) exit 0 ;;
  "exec -i "*" pg_restore "*) cat > /dev/null; [ -n "${FAKE_RESTORE_FAIL:-}" ] && exit 1; exit 0 ;;
  # `exec [-i] NAME sh -c CMD` runs CMD here, with the container's /restore-media mapped into $STATE. These
  # come before the psql case: the media check's CMD itself contains " psql ".
  "exec -i "*" sh -c "*) sh -c "$(mapdir "$6")" ;;
  "exec "*" sh -c "*) sh -c "$(mapdir "$5")" ;;
  "exec "*" psql "*) shift 3; psql "$@" ;;
  # The run record (BackupRun): keep the SQL and the arguments so a case can inspect what would be stored.
  "compose exec -T -e BR_STATUS="*) cat > "$STATE/record.sql"; printf "%s
" "$@" > "$STATE/record.args"; [ -n "${FAKE_RECORD_FAIL:-}" ] && exit 1; exit 0 ;;
  *) echo "fake docker: unexpected call: $*" >&2; exit 97 ;;
esac
EOF
cat > "$FAKE/psql" <<'EOF'
#!/usr/bin/env bash
sql="${!#}"
case "$sql" in
  *'SELECT "storageKey"'*) cat "$STATE/stored-keys" 2>/dev/null ;;
  *'FROM "MessageMedia"'*) if [ -f "$STATE/stored-keys" ]; then wc -l < "$STATE/stored-keys" | tr -d ' '; else echo 0; fi ;;
  *to_regclass*) echo t ;;
  *migration_name*) echo 20261101000000_fake ;;
  *"FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"*) echo "${FAKE_APPLIED:-150}" ;;
  *) echo 5 ;;
esac
EOF
printf '#!/usr/bin/env bash\nexit "${FAKE_FLOCK_RC:-0}"\n' > "$FAKE/flock"
mkdir -p "$WORK/lowdisk"
printf '#!/usr/bin/env bash\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "fake 1000000 999000 1000 99%% /"\n' > "$WORK/lowdisk/df"
chmod +x "$FAKE"/* "$WORK/lowdisk/df"

# A PATH holding every tool the scripts use EXCEPT flock, to prove a missing tool fails loudly.
NOFLOCK="$WORK/noflock"; mkdir -p "$NOFLOCK"
for t in bash docker psql sha256sum tar gzip find df awk date mkdir chmod git basename dirname du cut wc sort mv rm grep \
         cat head tail ls touch sleep mktemp tr base64 seq xargs stat sh env cp; do
  p="$( [ -x "$FAKE/$t" ] && echo "$FAKE/$t" || command -v "$t" || true)"
  [ -n "$p" ] && ln -sf "$p" "$NOFLOCK/$t"
done

reset_state() {
  export STATE="$WORK/state"; rm -rf "$STATE" "$WORK/backups"; mkdir -p "$STATE/src/whatsapp/p1" "$STATE/dockerroot"
  echo "image bytes" > "$STATE/src/whatsapp/p1/a.jpg"; echo "voice bytes" > "$STATE/src/whatsapp/p1/b.ogg"
  : > "$STATE/calls.log"
  export FAKE_VOLUMES="support_automation_media support_automation_whatsapp_session"
  unset FAKE_DUMP_FAIL FAKE_TOC_LINES FAKE_RESTORE_FAIL FAKE_FLOCK_RC FAKE_LIVE_DB_BYTES FAKE_APPLIED FAKE_RECORD_FAIL
  export BACKUP_DIR="$WORK/backups" RESTORE_MIN_FREE_GB=0
}
run_backup() { (cd "$REPO" && PATH="$FAKE:$PATH" bash scripts/backup.sh) > "$WORK/out" 2>&1; echo $?; }
run_rehearsal() { (cd "$REPO" && PATH="$FAKE:$PATH" bash scripts/restore-rehearsal.sh "$@") > "$WORK/out" 2>&1; echo $?; }
latest() { ls "$BACKUP_DIR/$1" 2>/dev/null | sort | tail -1; }
check() { # name, condition (evaluated)
  if eval "$2"; then PASS=$((PASS + 1)); echo "ok   - $1"; else FAILS=$((FAILS + 1)); echo "FAIL - $1"; sed 's/^/       | /' "$WORK/out"; fi
}

# ---------------------------------------------------------------------------------------------------------
echo "# backup.sh"
reset_state; rc=$(run_backup)
check "happy path exits 0 with a dump, a media archive and both in the manifest" \
  '[ "$rc" = 0 ] && [ -n "$(latest db)" ] && [ -n "$(latest media)" ] && [ "$(cat "$BACKUP_DIR"/manifest-*.sha256 | wc -l)" = 2 ]'

reset_state; export FAKE_TOC_LINES=20000; rc=$(run_backup)
check "BKP-05: a table of contents far larger than a pipe buffer is not a false failure" '[ "$rc" = 0 ] && [ -n "$(latest db)" ]'

reset_state; export FAKE_VOLUMES="support_automation_whatsapp_session"; rc=$(run_backup)
check "BKP-02: missing media volume fails the run, and no manifest is written" \
  '[ "$rc" = 1 ] && grep -q "FAILED: Docker volume support_automation_media not found" "$WORK/out" && ! ls "$BACKUP_DIR"/manifest-* >/dev/null 2>&1'

reset_state; export FAKE_VOLUMES="support_automation_media"; rc=$( BACKUP_WHATSAPP_SESSIONS=1 run_backup )
check "BKP-02: sessions requested but their volume is missing fails the run" '[ "$rc" = 1 ] && grep -q "support_automation_whatsapp_session not found" "$WORK/out"'

reset_state; rc=$( BACKUP_WHATSAPP_SESSIONS=1 run_backup )
check "sessions requested and present: archived and in the manifest" '[ "$rc" = 0 ] && [ -n "$(latest sessions)" ] && [ "$(cat "$BACKUP_DIR"/manifest-*.sha256 | wc -l)" = 3 ]'

reset_state; export FAKE_DUMP_FAIL=1; rc=$(run_backup)
check "pg_dump error fails the run and leaves no dump" '[ "$rc" = 1 ] && [ -z "$(latest db)" ]'

reset_state; mkdir -p "$WORK/badbin"; sed 's/printf .PGDMP fake archive.n./printf "garbage"/' "$FAKE/docker" > "$WORK/badbin/docker"; chmod +x "$WORK/badbin/docker"
rc=$( (cd "$REPO" && PATH="$WORK/badbin:$FAKE:$PATH" bash scripts/backup.sh) > "$WORK/out" 2>&1; echo $?)
check "corrupt dump (unreadable archive) fails the run and leaves no dump" '[ "$rc" = 1 ] && [ -z "$(latest db)" ] && grep -q "could not be read back" "$WORK/out"'

reset_state; rc=$( (cd "$REPO" && PATH="$NOFLOCK" "$(command -v bash)" scripts/backup.sh) > "$WORK/out" 2>&1; echo $?)
check "missing flock fails loudly (exit 1), never reads as busy" '[ "$rc" = 1 ] && grep -q "flock is not installed" "$WORK/out"'

reset_state; rc=$( (cd "$REPO" && PATH="$WORK/lowdisk:$FAKE:$PATH" bash scripts/backup.sh) > "$WORK/out" 2>&1; echo $?)
check "insufficient disk fails before anything is written" '[ "$rc" = 1 ] && [ -z "$(latest db)" ] && ! grep -q pg_dump "$STATE/calls.log"'

reset_state; export FAKE_FLOCK_RC=1; rc=$(run_backup)
check "a run while another holds the lock does nothing and exits 0" '[ "$rc" = 0 ] && [ -z "$(latest db)" ]'

reset_state; mkdir -p "$BACKUP_DIR/db"
for d in 01 02 03 04 05; do f="db/db-202610${d}-030000-abc.dump"; echo old > "$BACKUP_DIR/$f"; touch -d "20 days ago" "$BACKUP_DIR/$f"
  (cd "$BACKUP_DIR" && sha256sum "$f") > "$BACKUP_DIR/manifest-202610${d}-030000.sha256"; done
rc=$(run_backup)
check "retention removes old dumps but keeps 3, and only manifests whose files are all gone" \
  '[ "$rc" = 0 ] && [ "$(ls "$BACKUP_DIR/db" | wc -l)" = 3 ] && [ "$(ls "$BACKUP_DIR"/manifest-* | wc -l)" = 3 ]'


# The run record (docs/get-assist-ultimate/19 §7): what Platform Monitoring and the backup alert read.
reset_state; rc=$(run_backup)
check "a successful run is recorded SUCCEEDED with its sizes, every value as a psql variable"   '[ "$rc" = 0 ] && grep -qx "BR_STATUS=SUCCEEDED" "$STATE/record.args" && grep -q "^BR_DB=[0-9][0-9]*$" "$STATE/record.args" && grep -q "^BR_MEDIA=[0-9][0-9]*$" "$STATE/record.args" && grep -q ":.status.::" "$STATE/record.sql" && ! grep -q SUCCEEDED "$STATE/record.sql"'

reset_state; rc=$( (cd "$REPO" && PATH="$WORK/lowdisk:$FAKE:$PATH" bash scripts/backup.sh) > "$WORK/out" 2>&1; echo $?)
check "a failed run is recorded FAILED, and its reason names no path"   '[ "$rc" = 1 ] && grep -qx "BR_STATUS=FAILED" "$STATE/record.args" && grep -q "^BR_REASON=.*[path]" "$STATE/record.args" && ! grep -q "$WORK" "$STATE/record.args"'

reset_state; export FAKE_RECORD_FAIL=1; rc=$(run_backup)
check "a run that cannot be recorded still exits as the backup did, and says so"   '[ "$rc" = 0 ] && [ -n "$(latest db)" ] && grep -q "could not be recorded" "$WORK/out"'

reset_state; export FAKE_FLOCK_RC=1; rc=$(run_backup)
check "a run that found another holding the lock records nothing" '[ "$rc" = 0 ] && [ ! -f "$STATE/record.args" ]'

# ---------------------------------------------------------------------------------------------------------
echo "# restore-rehearsal.sh"
make_backup() { reset_state; [ "$(run_backup)" = 0 ] || { echo "setup backup failed"; cat "$WORK/out"; exit 1; }
  DUMP="$BACKUP_DIR/db/$(latest db)"; MEDIA="$BACKUP_DIR/media/$(latest media)"
  printf 'whatsapp/p1/a.jpg\nwhatsapp/p1/b.ogg\n' > "$STATE/stored-keys"; : > "$STATE/calls.log"; }

make_backup; rc=$(run_rehearsal "$DUMP" "$MEDIA")
check "happy path: database and media restore, every stored file present, container removed" \
  '[ "$rc" = 0 ] && grep -q "PASSED: the dump restored" "$WORK/out" && grep -q "missing from the archive: 0" "$WORK/out" && [ ! -f "$STATE/container" ]'

make_backup; rc=$(run_rehearsal "$DUMP")
check "dump only: passes, and says media was NOT checked" '[ "$rc" = 0 ] && grep -q "Media was NOT checked" "$WORK/out"'

make_backup; rm -f "$BACKUP_DIR"/manifest-*; rc=$(run_rehearsal "$DUMP" "$MEDIA")
check "BKP-01: no manifest entry fails before any container starts" '[ "$rc" = 1 ] && grep -q "in no manifest" "$WORK/out" && ! grep -q "run -d" "$STATE/calls.log"'

make_backup; echo tampered >> "$DUMP"; rc=$(run_rehearsal "$DUMP" "$MEDIA")
check "BKP-01: checksum mismatch fails before any container starts" '[ "$rc" = 1 ] && grep -q "checksum mismatch" "$WORK/out" && ! grep -q "run -d" "$STATE/calls.log"'

make_backup; head -c 40 "$MEDIA" > "$MEDIA.cut" && mv "$MEDIA.cut" "$MEDIA"
(cd "$BACKUP_DIR" && sha256sum "media/$(basename "$MEDIA")" > manifest-zz-media.sha256)   # checksum now matches the corrupt file
rc=$(run_rehearsal "$DUMP" "$MEDIA")
check "BKP-03: a truncated media archive fails even when its checksum matches" '[ "$rc" = 1 ] && grep -q FAILED "$WORK/out"'

make_backup; printf 'whatsapp/p1/a.jpg\nwhatsapp/p1/b.ogg\nwhatsapp/p1/gone.png\n' > "$STATE/stored-keys"; rc=$(run_rehearsal "$DUMP" "$MEDIA")
check "BKP-03: a file the database records as stored but missing from the archive fails the run" \
  '[ "$rc" = 1 ] && grep -q "1 stored media files are missing" "$WORK/out" && [ ! -f "$STATE/container" ]'

make_backup; rc=$( (cd "$REPO" && PATH="$WORK/lowdisk:$FAKE:$PATH" RESTORE_MIN_FREE_GB=1 bash scripts/restore-rehearsal.sh "$DUMP" "$MEDIA") > "$WORK/out" 2>&1; echo $?)
check "BKP-04: insufficient disk fails before any container starts" '[ "$rc" = 1 ] && grep -q "not enough free disk" "$WORK/out" && ! grep -q "run -d" "$STATE/calls.log"'

make_backup; export FAKE_LIVE_DB_BYTES=$((5 * 1024 * 1024 * 1024 * 1024)); rc=$(run_rehearsal "$DUMP" "$MEDIA")
check "BKP-04: the live database size is used when readable (5 TB here: refused)" '[ "$rc" = 1 ] && grep -q "by live database size" "$WORK/out" && ! grep -q "run -d" "$STATE/calls.log"'

make_backup; export FAKE_RESTORE_FAIL=1; rc=$(run_rehearsal "$DUMP" "$MEDIA")
check "pg_restore error fails the run and the container is still removed" '[ "$rc" = 1 ] && grep -q "pg_restore stopped" "$WORK/out" && [ ! -f "$STATE/container" ]'

make_backup; export FAKE_APPLIED=0; rc=$(run_rehearsal "$DUMP" "$MEDIA")
check "a restored database with no applied migrations fails" '[ "$rc" = 1 ] && grep -q "no applied migrations" "$WORK/out"'

echo "# $PASS passed, $FAILS failed"
[ "$FAILS" = 0 ]
