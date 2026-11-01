#!/usr/bin/env bash
# ==============================================================================
# Bolo1800 - Daily Database & Audio Backup Script
# ==============================================================================
BACKUP_DIR="/var/backups/bolo1800"
DATA_DIR="${DATA_DIR:-$(cd "$(dirname "$0")" && pwd)/data}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

mkdir -p "$BACKUP_DIR"

if [ -f "$DATA_DIR/bolo1800.db" ]; then
    echo "Creating backup of bolo1800.db at $TIMESTAMP..."
    sqlite3 "$DATA_DIR/bolo1800.db" ".backup '$BACKUP_DIR/bolo1800_$TIMESTAMP.db'"
    gzip "$BACKUP_DIR/bolo1800_$TIMESTAMP.db"
    echo "Backup completed: $BACKUP_DIR/bolo1800_$TIMESTAMP.db.gz"
fi

# Keep only last 30 days of backups
find "$BACKUP_DIR" -type f -name "bolo1800_*.db.gz" -mtime +30 -delete
echo "Old backups cleaned up."
