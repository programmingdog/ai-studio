#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
readonly root=/opt/aivs
readonly releases="$root/releases"
fail() { echo "$*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
valid_release() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$ ]]; }
valid_image() { [[ "$1" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]]; }
compose() { docker compose --project-name aivs --env-file "$1/release.env" -f "$1/compose.yml" "${@:2}"; }
point_to() {
  local name=$1 target=$2
  [[ ! -e "$root/$name" || -L "$root/$name" ]] || fail "$name must be a symlink"
  ln -s "$target" "$root/.$name-$$"
  mv -Tf "$root/.$name-$$" "$root/$name"
}

[[ $(uname -s) == Linux ]] || fail 'This deployment is for Linux Docker Engine only.'
[[ $# -ge 2 ]] || fail 'Usage: deploy.sh RELEASE API_DIGEST ADMIN_DIGEST | --rollback RELEASE --schema-compatible'
mkdir -p "$releases"
exec 9>"$root/deploy.lock"
flock -n 9 || fail 'Another deployment is running.'
[[ -s "$root/shared/api.env" ]] || fail 'Missing /opt/aivs/shared/api.env'
docker compose version >/dev/null
previous=''
if [[ -L "$root/current" ]]; then
  previous=$(readlink -f "$root/current")
  [[ "$previous" == "$releases/"* && -s "$previous/release.env" ]] || fail 'Invalid current release'
elif [[ -e "$root/current" ]]; then
  fail 'current must be a release symlink'
fi

if [[ "$1" == --rollback ]]; then
  [[ $# == 3 && "$3" == --schema-compatible ]] || fail 'Explicit --schema-compatible confirmation is required.'
  valid_release "$2" || fail 'Invalid release id'
  target="$releases/$2"
  [[ -f "$target/healthy" && -s "$target/release.env" ]] || fail 'Target was never healthy'
  # Never re-run migrations or restore an old DB here: this is code-only rollback.
  compose "$target" config --quiet
  compose "$target" pull api admin
  if ! compose "$target" up -d --wait --wait-timeout 180 api admin; then
    compose "$target" stop api admin || true
    fail 'Rollback health check failed; services stopped. Operator action required.'
  fi
  [[ -z "$previous" ]] || point_to previous "$previous"
  point_to current "$target"
  echo "Code rollback completed: $2. Database and secrets were NOT rolled back."
  exit 0
fi

[[ $# == 3 ]] || fail 'Expected release id, API digest and admin digest'
valid_release "$1" || fail 'Invalid release id'
if ! valid_image "$2" || ! valid_image "$3"; then
  fail 'Use ghcr.io image references pinned by sha256 digest'
fi
release="$releases/$1"
[[ ! -e "$release" ]] || fail 'Release already exists; use a new run id (or explicit rollback)'
[[ -x "$root/shared/backup.sh" ]] || fail 'Install and test /opt/aivs/shared/backup.sh first'
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir "$release"
cp "$source_dir/compose.yml" "$source_dir/deploy.sh" "$release/"
printf 'API_IMAGE=%s\nADMIN_IMAGE=%s\n' "$2" "$3" > "$release/release.env"
# Validate and pull BEFORE stopping the running version.
compose "$release" config --quiet
log "Pulling immutable API and admin images; the running release is still untouched."
compose "$release" pull api admin
log "Images downloaded and verified."
phase=prepared
recover() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    echo "Deployment failed during $phase. Release: $release" >&2
    if [[ "$phase" == stopped && -n "$previous" ]]; then
      # Backup/stop failed before ANY migration: restarting old code is safe.
      compose "$previous" up -d --wait --wait-timeout 180 api admin || echo 'Old release failed to restart; operator action required.' >&2
    elif [[ "$phase" == starting || "$phase" == migrating ]]; then
      compose "$release" stop api admin || true
      echo 'Services left stopped. MySQL DDL may be partially committed. Inspect migration.log; repair schema or explicitly confirm a code-only rollback.' >&2
    fi
  fi
  exit "$status"
}
trap recover EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
phase=stopped
log "Stopping the current application for the maintenance window."
if [[ -n "$previous" ]]; then
  compose "$previous" stop api admin
else
  # Also stop any containers left by a failed first deployment, if they exist.
  compose "$release" stop api admin
fi
"$root/shared/backup.sh"
log "Pre-deployment database backup completed."
phase=migrating
log "Applying idempotent schema migrations to the existing database."
compose "$release" run --rm --no-deps -T api node dist/database/migrate.js 2>&1 | tee "$release/migration.log"
log "Schema migration command completed; backfilling only missing invite codes."
compose "$release" run --rm --no-deps -T api node dist/scripts/backfill-invite-codes.js
phase=starting
log "Starting the new release and waiting up to 180 seconds for health checks."
compose "$release" up -d --wait --wait-timeout 180 api admin
touch "$release/healthy"
[[ -z "$previous" ]] || point_to previous "$previous"
point_to current "$release"
phase=complete
trap - HUP INT TERM
echo "Deployment healthy: $1. Verify HTTPS and business flows before announcing release."
