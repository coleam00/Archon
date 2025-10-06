#!/usr/bin/env python3
"""run_migrations.py

Improved migration runner for Archon.

Features:
- Accepts CLI args for host/port/user/password/database
- Returns proper exit codes so CI can fail on migration errors
- Tries to prefer dockerized psql (exec into supabase-db) if available
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from typing import List


def find_psql_candidates() -> List[str]:
    """Return a list of candidate psql commands/paths to try."""
    return [
        "psql",
        r"C:\Program Files\PostgreSQL\bin\psql.exe",
        r"C:\Program Files\PostgreSQL\17\bin\psql.exe",
        r"C:\Program Files\PostgreSQL\16\bin\psql.exe",
        r"C:\Program Files\PostgreSQL\15\bin\psql.exe",
    ]


def locate_psql() -> str | None:
    """Try to locate a usable psql executable on PATH or known locations."""
    for path in find_psql_candidates():
        try:
            result = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=3)
            out = (result.stdout or "") + (result.stderr or "")
            if result.returncode == 0 and "psql" in out.lower():
                return path
        except Exception:
            continue
    return None


def run_psql_file(psql_cmd: str, host: str, port: str, user: str, database: str, password: str, sql_file: str, timeout: int = 300) -> int:
    """Execute a SQL file via psql. Returns the subprocess exit code."""
    env = os.environ.copy()
    if password:
        env["PGPASSWORD"] = password

    cmd = [psql_cmd, "-h", host, "-p", str(port), "-U", user, "-d", database, "-f", sql_file]
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout)
    print(proc.stdout)
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
    return proc.returncode


def parse_args():
    p = argparse.ArgumentParser(description="Run SQL migrations for Archon")
    p.add_argument("--host", default=os.getenv("DB_HOST", "localhost"))
    p.add_argument("--port", default=os.getenv("DB_PORT", "54325"))
    p.add_argument("--user", default=os.getenv("DB_USER", "postgres"))
    p.add_argument("--password", default=os.getenv("DB_PASSWORD", "postgres"))
    p.add_argument("--database", default=os.getenv("DB_NAME", "postgres"))
    p.add_argument("--migrations", nargs="*", default=None, help="List of migration files to run (in order)")
    p.add_argument("--timeout", type=int, default=300, help="Per-migration timeout seconds")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    # Default migrations (keep repository ordering)
    migrations = args.migrations or [
        "migration/complete_setup.sql",
        "migration/add_embedding_provider_setting.sql",
    ]

    print("Connecting to database for migrations...")

    # Prefer local psql if available
    psql_cmd = locate_psql()

    if not psql_cmd:
        print("psql not found on PATH or known locations. Falling back to docker exec if container exists.")
        # Try docker exec into common supabase container name
        # If docker is not available, we'll error later
        # We'll set psql_cmd to a docker exec wrapper invocation
        docker_name = os.getenv("SUPABASE_CONTAINER", "supabase-db")
        # verify the container exists
        try:
            result = subprocess.run(["docker", "ps", "--filter", f"name={docker_name}", "--format", "{{.Names}}"], capture_output=True, text=True, timeout=5)
            if result.returncode == 0 and docker_name in result.stdout:
                # use docker exec to run psql inside container
                psql_cmd = f"docker exec -i {docker_name} psql"
                print(f"Using psql inside container: {docker_name}")
            else:
                print("No docker supabase container found and psql not available. Please install psql or start the supabase container.")
                return 2
        except Exception:
            print("Docker check failed and psql not available. Please install psql or ensure Docker is running.")
            return 2

    all_success = True

    for migration_file in migrations:
        if os.path.exists(migration_file):
            print(f"Running migration: {migration_file}")
            try:
                if psql_cmd.startswith("docker exec"):
                    # When using docker exec wrapper, build a shell command string
                    docker_cmd = f"docker exec -i {os.getenv('SUPABASE_CONTAINER', 'supabase-db')} psql -U {args.user} -d {args.database} -f -"
                    # cat the file and pipe into docker exec psql -f -
                    with open(migration_file, "rb") as fh:
                        proc = subprocess.run(docker_cmd, input=fh.read(), shell=True)
                        rc = proc.returncode
                else:
                    rc = run_psql_file(psql_cmd, args.host, args.port, args.user, args.database, args.password, migration_file, timeout=args.timeout)

                if rc == 0:
                    print("✓ Migration executed successfully")
                else:
                    print(f"✗ Migration failed with return code {rc}")
                    all_success = False
            except subprocess.TimeoutExpired:
                print(f"✗ Migration timed out: {migration_file}")
                all_success = False
            except Exception as e:
                print(f"✗ Migration error: {e}")
                all_success = False
        else:
            print(f"✗ Migration file not found: {migration_file}")
            all_success = False

    print("Migration script completed")
    return 0 if all_success else 3


if __name__ == "__main__":
    try:
        rc = main()
    except Exception as e:
        print(f"Unhandled error running migrations: {e}", file=sys.stderr)
        rc = 99
    sys.exit(rc)
