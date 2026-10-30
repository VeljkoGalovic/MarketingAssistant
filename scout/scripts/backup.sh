#!/usr/bin/env bash
# Nightly SQLite backup for the scout (PLAN §11). Cron on the box:
#   15 3 * * * /opt/lodgetrack-scout/scout/scripts/backup.sh >>/opt/lodgetrack-scout/backup.log 2>&1
set -euo pipefail
DATA_DIR="${SCOUT_DATA_DIR:-/opt/lodgetrack-scout/data}"
BACKUP_DIR="${DATA_DIR}/backups"
KEEP=14

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d)
sqlite3 "$DATA_DIR/scout.db" ".backup '$BACKUP_DIR/scout-$STAMP.db'"
# Prune old backups
ls -1t "$BACKUP_DIR"/scout-*.db | tail -n +$((KEEP + 1)) | xargs -r rm -- 
echo "$(date -Is) backup saved: $BACKUP_DIR/scout-$STAMP.db"
