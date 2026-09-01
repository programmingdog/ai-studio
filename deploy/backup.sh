#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
# Install as /opt/aivs/shared/backup.sh; edit ONLY this host-side copy as needed.
# The deployment workflow never replaces this hook or your secrets.
readonly root=/opt/aivs
readonly database=ai_studio
readonly credentials="$root/shared/backup.cnf"
[[ -s "$credentials" ]] || { echo 'Missing backup.cnf' >&2; exit 1; }
mkdir -p "$root/backups"
output=$(mktemp "$root/backups/predeploy-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.sql.gz")
# A failed dump remains as .sql.gz without a .complete marker for investigation.
mysqldump --defaults-extra-file="$credentials" --single-transaction --quick \
  --no-tablespaces --set-gtid-purged=OFF --hex-blob "$database" | gzip > "$output"
gzip -t "$output"
touch "$output.complete"
echo "Database backup completed: $output"
