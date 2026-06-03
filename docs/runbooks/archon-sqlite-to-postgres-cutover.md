# Archon SQLite → Postgres Cutover Runbook

Step-by-step procedure to migrate the Archon primary store from single-file
SQLite (`~/.archon/archon.db`) to PostgreSQL, while preserving all 9 application
tables, all data, and the live `IDatabase` adapter abstraction.

> **Time estimate:** 10–15 minutes for the cutover itself (excluding
> pre-cutover checks and 24-hour monitoring).
>
> **Prerequisites:**
> - Repo checked out at the post-cutover commit on the production host.
> - Docker installed and the operator in the `docker` group.
> - `archon` CLI on PATH (built or `bun --cwd packages/cli src/cli.ts`).
> - `~/.archon/.env` writable.
> - `~/.config/systemd/user/` writable (for the backup timer).

## 0. Pre-flight prerequisites (BEFORE the cutover window)

1. **Apply the `Restart=` fix to `archon-server.service` first.** The 2026-06-02
   incident documented that the service failed to restart on crash for 6+ hours.
   Without this, the cutover puts the server back into the "silently down"
   state. Edit `~/.config/systemd/user/archon-server.service` and ensure:
   ```ini
   [Service]
   Restart=on-failure
   RestartSec=5s
   ```
   Then `systemctl --user daemon-reload`. **This is a prerequisite for Task 16.**

2. **Confirm staging has been on Postgres for 1+ week without regressions.**
   See `WadeVault/Memory/dev/runbooks/` for the staging check procedure.

3. **Pre-stage the systemd timer unit files** at `docs/systemd/archon-pg-backup.{service,timer}`
   on the operator's workstation. The cutover copies them into
   `~/.config/systemd/user/` (Step 8 below).

## 1. Pre-cutover checks (5 min)

```bash
# 1a. Archon setup is healthy
archon doctor
# All checks should pass: Claude binary, gh auth, DB, workspace, bundled, etc.

# 1b. No in-flight workflows
sqlite3 ~/.archon/archon.db \
  "SELECT count(*) FROM remote_agent_workflow_runs WHERE status = 'running';"
# Expected: 0 (or note the run IDs you'll accept as data loss)

# 1c. SQLite integrity
sqlite3 ~/.archon/archon.db "PRAGMA integrity_check;"
# Expected: ok
```

## 2. Stop archon-server (1 min)

```bash
systemctl --user stop archon-server.service archon-web.service
systemctl --user status archon-server.service
# Expected: inactive (dead)
```

## 3. Backup the live SQLite DB (1 min)

```bash
mkdir -p ~/.archon/backups
cp ~/.archon/archon.db ~/.archon/backups/archon.db.pre-pg-migration
cp ~/.archon/archon.db-wal   ~/.archon/backups/archon.db-wal.pre-pg-migration 2>/dev/null || true
cp ~/.archon/archon.db-shm   ~/.archon/backups/archon.db-shm.pre-pg-migration 2>/dev/null || true
ls -lah ~/.archon/backups/
```

## 4. Start Postgres (2 min)

```bash
cd ~/archon
docker compose --profile with-db up -d
# Wait for healthy
docker ps --filter "name=postgres" --format "{{.Names}}: {{.Status}}"
# Expected: archon-postgres-1: Up X minutes (healthy)
```

## 5. Verify schema (1 min)

```bash
docker exec archon-postgres-1 \
  psql -U postgres -d remote_coding_agent -c '\dt'
# Expected: 9 application tables (remote_agent_*)
```

## 6. Run the migration (2–5 min for 188 MiB)

```bash
archon migrate:sqlite-to-postgres \
  --from ~/.archon/archon.db \
  --to "$DATABASE_URL" \
  --verify
# Expected (row counts will match the live SQLite):
#   Migrated: 0 users, 0 user_identities, 4 codebases, 15 codebase_env_vars,
#             966 conversations, 58 sessions, 615 isolation_environments,
#             663 workflow_runs, 131272 workflow_events, 17151 messages
#   Verify: PASS (10/10 tables match)
# Exit code 0 on success.
```

The migration wraps all INSERTs in a single transaction; any error triggers
`ROLLBACK` and exits 2 with a clear message.

## 7. Set DATABASE_URL (1 min)

Edit `~/.archon/.env` and add (or uncomment):

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/remote_coding_agent
```

(The exact URL depends on the docker-compose profile or your external
Postgres deployment. Match the URL you used in Step 6.)

## 8. Deploy the backup timer (2 min)

```bash
# Copy the unit files (shipped in the repo at docs/systemd/) into
# the user's systemd directory.
cp docs/systemd/archon-pg-backup.service ~/.config/systemd/user/
cp docs/systemd/archon-pg-backup.timer   ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now archon-pg-backup.timer

# Verify
systemctl --user list-timers | grep archon-pg-backup
# Expected: archon-pg-backup.timer listed with next run at 03:30
```

## 9. Restart archon-server (1 min)

```bash
systemctl --user start archon-server.service archon-web.service
systemctl --user status archon-server.service
# Expected: active (running)
```

## 10. Verify (5 min)

```bash
# 10a. Health endpoint
curl -fsS http://localhost:3090/api/health
# Expected: {"status":"ok","database":"connected"}

# 10b. Doctor now reports postgres
archon doctor
# Expected: Database check reports "reachable (postgresql)"

# 10c. Spot-check a known run
# Use a run ID that survived the 2026-06-02 incident:
curl -fsS http://localhost:3090/api/workflows/runs/377c3268b8c6607a852fe63de8854d91 \
  | jq '.events | length'
# Expected: 1146

# 10d. Row counts in Postgres match the pre-cutover numbers
docker exec archon-postgres-1 \
  psql -U postgres -d remote_coding_agent -c \
  "SELECT count(*) FROM remote_agent_workflow_events;"
# Expected: 131272
```

## 11. 24-hour monitoring

```bash
# Watch journald for any errors, panics, connection drops
journalctl --user -u archon-server.service -f

# Confirm the 03:30 backup ran and produced a .dump file
ls -lah ~/.archon/backups/archon-pg-*.dump
```

After 24 hours with no errors, declare the cutover complete. Schedule
the post-cutover check-in via Todoist/calendar (per `MEMORY.md` "watch-for"
discipline) so it actually happens.

## 12. Cleanup (after 1 week of stable operation)

Disk space can be tight on small VPSes. Remove old SQLite snapshots
**only if** Postgres has been stable for 7+ days AND a `.dump` exists:

```bash
# Safe to remove: pre-merge and recovery snapshots
rm ~/.archon/archon.db.pre-merge-2026-05-19
rm ~/.archon/archon.db.recovered-2026-06-02T10-15Z

# KEEP (per the no-delete rule):
#   ~/.archon/archon.db.corrupt-2026-06-02
#   ~/.archon/archon.db.pre-pg-migration
#   ~/.archon/archon.db-wal.pre-pg-migration
#   ~/.archon/archon.db-shm.pre-pg-migration
```

## Rollback (if 11 surfaces any errors)

1. Stop the server:
   ```bash
   systemctl --user stop archon-server.service archon-web.service
   ```
2. Edit `~/.archon/.env` and **clear** `DATABASE_URL` (or comment it out).
3. Restart the server:
   ```bash
   systemctl --user start archon-server.service archon-web.service
   ```
4. Verify the SQLite path works again:
   ```bash
   curl -fsS http://localhost:3090/api/health
   archon doctor
   ```

The original SQLite DB is untouched by the migration script (read-only access);
rolling back is a configuration change, not a data restore. If Postgres data
needs to be reverted, restore from the nightly `.dump` file (see
`docs/runbooks/archon-postgres-backup-restore.md`).
