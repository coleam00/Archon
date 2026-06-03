# Archon Postgres Backup & Restore Runbook

Covers the nightly `pg_dump` backup, manual backups, and the procedure for
restoring a `.dump` file in three contexts: full database restore, schema-only
re-apply, and disaster recovery from a complete host rebuild.

## A. Backup

### A.1 Automated (nightly at 03:30)

The systemd user timer `archon-pg-backup.timer` runs
`~/archon/scripts/pg-backup.sh` at 03:30 every day. The script:

1. Sources `~/.archon/.env` to read `DATABASE_URL`.
2. Validates `pg_dump` is on PATH.
3. Runs `pg_dump -Fc -Z 9 "$DATABASE_URL"` → writes
   `~/.archon/backups/archon-pg-YYYY-MM-DDTHH-MM-SSZ.dump` (custom format, max
   compression, ~5–10× smaller than plain SQL).
4. Logs the file size and duration to stdout (captured by journald).
5. Prunes `.dump` files older than 14 days
   (`find ~/.archon/backups -name 'archon-pg-*.dump' -mtime +14 -delete`).

#### A.1.1 Verify the timer is running

```bash
systemctl --user list-timers | grep archon-pg-backup
# Expected: archon-pg-backup.timer listed with next run at 03:30

systemctl --user status archon-pg-backup.timer
# Expected: active (waiting)
```

#### A.1.2 Trigger a backup immediately (for verification)

```bash
systemctl --user start archon-pg-backup.service
# Or directly:
bash ~/archon/scripts/pg-backup.sh
```

### A.2 Manual (on-demand)

```bash
bash ~/archon/scripts/pg-backup.sh
ls -lah ~/.archon/backups/archon-pg-*.dump | tail -5
```

### A.3 Verify a backup is valid (without restoring)

```bash
# Lists the table of contents of a .dump file
pg_restore -l ~/.archon/backups/archon-pg-2026-06-03.dump | head -30
# Expected: comments, TOC entries for each remote_agent_* table, indexes,
#           constraints, ACL grants
```

### A.4 Storage layout

```
~/.archon/backups/
├── archon.db.pre-merge-2026-05-19         # pre-cutover SQLite snapshot
├── archon.db.pre-pg-migration             # snapshot taken at cutover time
├── archon-pg-2026-06-03T03-30-00Z.dump    # nightly pg_dump (custom format)
├── archon-pg-2026-06-04T03-30-00Z.dump
└── ...
```

The SQLite snapshots are kept for historical reference per the project's
no-delete rule; the `.dump` files are pruned at 14 days.

---

## B. Restore from a `.dump` file

> **Stop the server before any restore that mutates the existing DB.**
> Restoring over a live database is a recipe for silent corruption.

### B.1 Full database restore

```bash
# 1. Stop the server (Postgres keeps running, but archon-server is
#    the only writer — stopping it eliminates the race).
systemctl --user stop archon-server.service archon-web.service

# 2. Drop the existing DB
docker exec archon-postgres-1 \
  psql -U postgres -c "DROP DATABASE remote_coding_agent"

# 3. Recreate empty
docker exec archon-postgres-1 \
  psql -U postgres -c "CREATE DATABASE remote_coding_agent"

# 4. Restore from .dump
#    --clean --if-exists: drop existing tables before creating (defensive;
#                          the DB is empty after step 2-3, so this is a no-op
#                          but cheap insurance).
#    --no-owner:        skip the original role grants (we set our own
#                          after restore).
pg_restore \
  --clean --if-exists --no-owner \
  -d postgresql://postgres:postgres@localhost:5432/remote_coding_agent \
  ~/.archon/backups/archon-pg-2026-06-03.dump

# 5. Apply schema (in case the restore is partial or .dump pre-dates
#    a migration)
docker exec -i archon-postgres-1 \
  psql -U postgres -d remote_coding_agent -v ON_ERROR_STOP=1 \
  < ~/archon/migrations/000_combined.sql

# 6. Restart the server
systemctl --user start archon-server.service archon-web.service
```

### B.2 Schema-only re-apply (idempotent)

`migrations/000_combined.sql` uses `CREATE TABLE IF NOT EXISTS` and
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so re-applying it is safe.
Use this when a recent migration added columns/tables and you want to
ensure the schema is fully up to date without restoring data:

```bash
docker exec -i archon-postgres-1 \
  psql -U postgres -d remote_coding_agent -v ON_ERROR_STOP=1 \
  < ~/archon/migrations/000_combined.sql
```

### B.3 Restore a single table from a `.dump`

Useful for surgical recovery (e.g., recover a deleted run without
restoring everything):

```bash
# Extract just one table's data + structure
pg_restore -t remote_agent_workflow_runs \
  --no-owner --clean --if-exists \
  -d postgresql://postgres:postgres@localhost:5432/remote_coding_agent \
  ~/.archon/backups/archon-pg-2026-06-03.dump
```

---

## C. Disaster recovery (full system rebuild)

If the entire host is lost (hardware failure, ransomware, accidental
wipe), restore in this order:

1. **Restore `~/.archon/` from Tailscale backup.** The directory contains:
   - `archon.db.pre-pg-migration` (last SQLite snapshot)
   - `archon.db-wal`, `archon.db-shm` (companion files if pre-Postgres)
   - `backups/archon-pg-*.dump` (nightly Postgres dumps)
   - `workspaces/` (per-codebase git worktrees — not in scope of this plan)

2. **Reinstall Archon** (per the deployment guide). Pull the latest
   `dev` branch and run the install script.

3. **Apply the combined schema** (creates the empty Postgres schema):
   ```bash
   cd ~/archon
   docker compose --profile with-db up -d
   docker exec -i archon-postgres-1 \
     psql -U postgres -d remote_coding_agent -v ON_ERROR_STOP=1 \
     < migrations/000_combined.sql
   ```

4. **Restore the most recent `.dump`** (per Section B.1 above). Pick
   the latest file in `~/.archon/backups/archon-pg-*.dump`.

5. **Re-deploy the systemd backup timer** (per
   `docs/runbooks/archon-sqlite-to-postgres-cutover.md` Step 8).

6. **Restore workspaces from `~/.archon/workspaces/`** (out of scope
   for the SQLite → Postgres migration; documented for completeness).

7. **Verify** with `archon doctor` and the spot-check curl commands
   from the cutover runbook Step 10.

---

## D. Verification checklist

After any backup or restore, run:

```bash
# 1. Row counts match expectations
archon doctor
# Database check: reachable (postgresql)

# 2. Sample queries return expected results
docker exec archon-postgres-1 \
  psql -U postgres -d remote_coding_agent -c \
  "SELECT count(*) FROM remote_agent_workflow_events"
# Expected: matches the last known good count

# 3. /api/health returns 200 with database: "connected"
curl -fsS http://localhost:3090/api/health
# Expected: {"status":"ok","database":"connected"}
```

## E. Failure modes and recovery

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `pg_dump: error: connection to server ... failed` | Postgres not running or `DATABASE_URL` wrong | `docker ps`, check `~/.archon/.env` |
| `Error: pg_dump is not on PATH` | `postgresql-client` not installed | `apt install postgresql-client` (or `brew install libpq` on macOS) |
| Backup file is 0 bytes | `pg_dump` ran but had no permission to write | Check ownership: `ls -la ~/.archon/backups/` |
| Restore fails with "role does not exist" | `--no-owner` not set, original role missing | Re-run with `--no-owner` |
| `archon-server` can't connect after restore | `DATABASE_URL` not set in `~/.archon/.env` | Set it (see cutover runbook Step 7) |

## F. Operational notes

- **Backup window**: 03:30 local time. For a 188 MiB database, expect
  ~5–30 seconds. The nightly dump is typically 30–60 MiB compressed.
- **Retention**: 14 days. Tunable by editing the `find -mtime +14` in
  `scripts/pg-backup.sh`.
- **Verify the backup at least once a month** by restoring to a scratch
  database and running the verification checklist.
- **WAL archiving** is out of scope (per the plan). PITR is a future
  enhancement; current backups are snapshot-only.
