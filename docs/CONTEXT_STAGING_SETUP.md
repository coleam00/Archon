# Context: Staging Environment Setup for PostgreSQL Backend

## Overview

This document provides complete context for setting up a staging instance of Archon
that uses the PostgreSQL backend instead of Supabase, running on different ports
to avoid conflict with production.

## Architecture

```
PRODUCTION (Current)                 STAGING (New)
==================                   ==============
Streamlit UI: 8501                   Streamlit UI: 8502
Graph Service: 8100                  Graph Service: 8101
Database: Supabase (cloud)           Database: PostgreSQL (local)
Container: archon-container          Container: archon-staging
```

## Prerequisites

### Verified Components
- [x] PostgreSQL backend implemented (`archon/infrastructure/postgres/`)
- [x] All tests passing (16/16)
- [x] Container `mg_postgres` running on localhost:5432
- [x] Database `mydb` with pgvector extension
- [x] Table `site_pages` with correct schema

### Required Before Starting
- [ ] OpenAI API key for embeddings and LLM
- [ ] Docker running
- [ ] Production not currently being modified

## Files to Create

### 1. `.env.staging`

```bash
# ===========================================
# ARCHON STAGING ENVIRONMENT
# ===========================================
# This file configures staging to use PostgreSQL
# instead of Supabase, on different ports.
# ===========================================

# Backend Selection (CRITICAL)
REPOSITORY_TYPE=postgres

# PostgreSQL Configuration
# Using host.docker.internal to access host's Docker network
POSTGRES_HOST=host.docker.internal
POSTGRES_PORT=5432
POSTGRES_DB=mydb
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres

# Service Ports (different from production)
GRAPH_SERVICE_PORT=8101
GRAPH_SERVICE_HOST=0.0.0.0
GRAPH_SERVICE_URL=http://localhost:8101

# ===========================================
# LLM CONFIGURATION
# ===========================================
LLM_PROVIDER=OpenAI
BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-your-key-here
PRIMARY_MODEL=gpt-4o-mini
REASONER_MODEL=o3-mini

# ===========================================
# EMBEDDING CONFIGURATION
# ===========================================
EMBEDDING_PROVIDER=OpenAI
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_API_KEY=sk-your-key-here
EMBEDDING_MODEL=text-embedding-3-small
```

### 2. `Dockerfile.staging`

```dockerfile
FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

# STAGING PORTS (different from production 8501/8100)
EXPOSE 8502
EXPOSE 8101

# Streamlit on staging port
CMD ["streamlit", "run", "streamlit_ui.py", "--server.port=8502", "--server.address=0.0.0.0"]
```

### 3. `run_staging.py`

```python
#!/usr/bin/env python
"""
Build and run Archon Staging with PostgreSQL backend.
Isolated from production on different ports.
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

    # Check Docker
    result = subprocess.run(["docker", "--version"], capture_output=True)
    if result.returncode != 0:
        print("ERROR: Docker not available")
        return False
    print("[OK] Docker available")

    # Check PostgreSQL container
    result = subprocess.run(
        ["docker", "ps", "--filter", "name=mg_postgres", "--format", "{{.Status}}"],
        capture_output=True, text=True
    )
    if "Up" not in result.stdout:
        print("ERROR: PostgreSQL container 'mg_postgres' not running")
        print("Start it with: docker start mg_postgres")
        return False
    print("[OK] PostgreSQL container running")

    # Check .env.staging
    if not Path(".env.staging").exists():
        print("ERROR: .env.staging not found")
        return False
    print("[OK] .env.staging exists")

    # Check Dockerfile.staging
    if not Path("Dockerfile.staging").exists():
        print("ERROR: Dockerfile.staging not found")
        return False
    print("[OK] Dockerfile.staging exists")

    return True


def main():
    base_dir = Path(__file__).parent.absolute()
    os.chdir(base_dir)

    if not check_prerequisites():
        return 1

    # Build staging image
    print("\n=== Building Staging Image ===")
    if run_command([
        "docker", "build",
        "-t", IMAGE_NAME,
        "-f", "Dockerfile.staging",
        "."
    ]) != 0:
        print("ERROR: Build failed")
        return 1

    # Remove existing container
    print("\n=== Removing Existing Container ===")
    subprocess.run(["docker", "rm", "-f", CONTAINER_NAME], capture_output=True)

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
        print("ERROR: Failed to start container")
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
        print("ERROR: Container not running. Check logs:")
        print(f"  docker logs {CONTAINER_NAME}")
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
    print("=" * 60)

    return 0


if __name__ == "__main__":
    exit(main())
```

## Code Modifications Required

### 1. `graph_service.py` (lines 68-70)

**Before:**
```python
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8100)
```

**After:**
```python
if __name__ == "__main__":
    import uvicorn
    import os
    port = int(os.environ.get("GRAPH_SERVICE_PORT", "8100"))
    host = os.environ.get("GRAPH_SERVICE_HOST", "0.0.0.0")
    uvicorn.run(app, host=host, port=port)
```

### 2. `archon/container.py` (lines 23-27)

**Before:**
```python
# Configuration globale
_config = {
    "repository_type": "supabase",  # "supabase" | "postgres" | "memory"
    "embedding_type": "openai",      # "openai" | "mock"
}
```

**After:**
```python
import os

# Configuration globale - permet override via variable d'environnement
_default_repo_type = os.environ.get("REPOSITORY_TYPE", "supabase")

_config = {
    "repository_type": _default_repo_type,  # "supabase" | "postgres" | "memory"
    "embedding_type": "openai",              # "openai" | "mock"
}
```

## Step-by-Step Execution

### Step 1: Create Configuration Files
```bash
# Create .env.staging (edit with your API keys!)
# Create Dockerfile.staging
# Create run_staging.py
```

### Step 2: Apply Code Modifications
```bash
# Modify graph_service.py for port override
# Modify archon/container.py for REPOSITORY_TYPE env var
```

### Step 3: Verify PostgreSQL
```bash
# Ensure PostgreSQL is running
docker ps | findstr mg_postgres

# Should show: mg_postgres ... Up ...
```

### Step 4: Launch Staging
```bash
python run_staging.py
```

### Step 5: Validate
```bash
# Check health endpoint
curl http://localhost:8101/health

# Open browser
start http://localhost:8502

# Check PostgreSQL for data after crawl
docker exec -it mg_postgres psql -U postgres -d mydb -c "SELECT COUNT(*) FROM site_pages;"
```

## Validation Checklist

After staging is running:

1. [ ] Streamlit UI accessible at http://localhost:8502
2. [ ] Graph Service responds at http://localhost:8101/health
3. [ ] Environment page shows configuration
4. [ ] Can crawl documentation (test with small site)
5. [ ] Data appears in PostgreSQL (not Supabase)
6. [ ] RAG search returns results
7. [ ] Production still works at http://localhost:8501

## Troubleshooting

### Container won't start
```bash
docker logs archon-staging
```

### PostgreSQL connection refused
- Verify `mg_postgres` is running
- Check `host.docker.internal` resolves (Windows/Mac Docker Desktop)
- On Linux, may need `--network host` instead

### Graph Service not responding
- Check port 8101 is exposed
- Verify GRAPH_SERVICE_PORT environment variable

### No data in PostgreSQL after crawl
- Check REPOSITORY_TYPE=postgres in .env.staging
- Verify container.py modification applied
- Check logs for repository initialization message

## Rollback

If anything goes wrong:
```bash
# Stop staging (production unaffected)
docker stop archon-staging
docker rm archon-staging

# Revert code changes if needed
git checkout graph_service.py
git checkout archon/container.py
```

Production continues running on ports 8501/8100 with Supabase.
