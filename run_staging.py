#!/usr/bin/env python
"""
Build and run Archon Staging with PostgreSQL backend.
Isolated from production on different ports.

Usage:
    python run_staging.py

Ports:
    - Streamlit UI:    8502 (production: 8501)
    - Graph Service:   8101 (production: 8100)

Database:
    - PostgreSQL via mg_postgres container (production: Supabase)
"""

import os
import subprocess
import time
from pathlib import Path

# Staging configuration
STAGING_PORTS = {
    "streamlit": 8502,
    "graph_service": 8101,
}
CONTAINER_NAME = "archon-staging"
IMAGE_NAME = "archon-staging:latest"


def run_command(command, cwd=None):
    """Execute command with real-time output."""
    print(f">>> {' '.join(command)}")
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=False,
        cwd=cwd
    )
    for line in process.stdout:
        try:
            print(line.decode('utf-8', errors='replace').strip())
        except Exception as e:
            print(f"Error: {e}")
    process.wait()
    return process.returncode


def check_prerequisites():
    """Verify all prerequisites are met."""
    print("\n=== Checking Prerequisites ===")
    all_ok = True

    # Check Docker
    result = subprocess.run(["docker", "--version"], capture_output=True)
    if result.returncode != 0:
        print("[FAIL] Docker not available")
        all_ok = False
    else:
        print("[OK] Docker available")

    # Check PostgreSQL container
    result = subprocess.run(
        ["docker", "ps", "--filter", "name=mg_postgres", "--format", "{{.Status}}"],
        capture_output=True, text=True
    )
    if "Up" not in result.stdout:
        print("[FAIL] PostgreSQL container 'mg_postgres' not running")
        print("       Start it with: docker start mg_postgres")
        all_ok = False
    else:
        print("[OK] PostgreSQL container running")

    # Check .env.staging
    if not Path(".env.staging").exists():
        print("[FAIL] .env.staging not found")
        print("       Create it from the template in docs/CONTEXT_STAGING_SETUP.md")
        all_ok = False
    else:
        print("[OK] .env.staging exists")

    # Check Dockerfile.staging
    if not Path("Dockerfile.staging").exists():
        print("[FAIL] Dockerfile.staging not found")
        all_ok = False
    else:
        print("[OK] Dockerfile.staging exists")

    # Check code modifications
    with open("graph_service.py", "r") as f:
        content = f.read()
        if "GRAPH_SERVICE_PORT" not in content:
            print("[WARN] graph_service.py not modified for port override")
            print("       Staging may use wrong port")

    with open("archon/container.py", "r") as f:
        content = f.read()
        if "REPOSITORY_TYPE" not in content:
            print("[WARN] archon/container.py not modified for REPOSITORY_TYPE")
            print("       Staging may use Supabase instead of PostgreSQL")

    return all_ok


def main():
    base_dir = Path(__file__).parent.absolute()
    os.chdir(base_dir)

    print("=" * 60)
    print("  ARCHON STAGING LAUNCHER")
    print("  PostgreSQL Backend | Ports 8502/8101")
    print("=" * 60)

    if not check_prerequisites():
        print("\n[ERROR] Prerequisites not met. Please fix issues above.")
        return 1

    # Build staging image
    print("\n=== Building Staging Image ===")
    if run_command([
        "docker", "build",
        "-t", IMAGE_NAME,
        "-f", "Dockerfile.staging",
        "."
    ]) != 0:
        print("[ERROR] Build failed")
        return 1

    # Remove existing container
    print("\n=== Removing Existing Container ===")
    subprocess.run(["docker", "rm", "-f", CONTAINER_NAME], capture_output=True)
    print(f"[OK] Cleared {CONTAINER_NAME}")

    # Start staging container
    print("\n=== Starting Staging Container ===")
    cmd = [
        "docker", "run", "-d",
        "--name", CONTAINER_NAME,
        "-p", f"{STAGING_PORTS['streamlit']}:8502",
        "-p", f"{STAGING_PORTS['graph_service']}:8101",
        "--add-host", "host.docker.internal:host-gateway",
        "--env-file", ".env.staging",
        "-e", f"GRAPH_SERVICE_PORT={STAGING_PORTS['graph_service']}",
        IMAGE_NAME
    ]

    if run_command(cmd) != 0:
        print("[ERROR] Failed to start container")
        return 1

    # Wait for startup
    print("\nWaiting for services to start...")
    time.sleep(5)

    # Check container status
    result = subprocess.run(
        ["docker", "ps", "--filter", f"name={CONTAINER_NAME}", "--format", "{{.Status}}"],
        capture_output=True, text=True
    )

    if "Up" not in result.stdout:
        print("[ERROR] Container not running. Check logs:")
        print(f"        docker logs {CONTAINER_NAME}")
        return 1

    # Success message
    print("\n" + "=" * 60)
    print("  ARCHON STAGING IS RUNNING!")
    print("=" * 60)
    print(f"  Streamlit UI:    http://localhost:{STAGING_PORTS['streamlit']}")
    print(f"  Graph Service:   http://localhost:{STAGING_PORTS['graph_service']}")
    print(f"  Health Check:    http://localhost:{STAGING_PORTS['graph_service']}/health")
    print("=" * 60)
    print(f"  Backend:         PostgreSQL (mg_postgres:5432/mydb)")
    print(f"  Container:       {CONTAINER_NAME}")
    print("=" * 60)
    print("\nUseful commands:")
    print(f"  View logs:       docker logs {CONTAINER_NAME} -f")
    print(f"  Stop staging:    docker stop {CONTAINER_NAME}")
    print(f"  Remove staging:  docker rm {CONTAINER_NAME}")
    print(f"  Shell access:    docker exec -it {CONTAINER_NAME} bash")
    print("=" * 60)
    print("\nProduction remains available at:")
    print("  http://localhost:8501 (Streamlit)")
    print("  http://localhost:8100 (Graph Service)")
    print("=" * 60)

    return 0


if __name__ == "__main__":
    exit(main())
