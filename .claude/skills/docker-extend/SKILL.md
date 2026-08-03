---
name: docker-extend
description: |
  Use when: User wants to extend Docker with custom tools, personalize the Docker environment,
  or set up user-specific Docker customization.
  Triggers: 'extend docker', 'docker-extend', 'add tools to docker', 'customize docker',
            'add my tools to the container', 'personalize docker setup', 'docker user setup',
            'install tools in docker'.
  Does: Interactively sets up Dockerfile.user and docker-compose.override.yml so users can
  add personal tools to their Docker environment without affecting maintainer files or
  committing user-specific config to git.
argument-hint: '[optional: tools to install, e.g. "vim ripgrep jq"]'
---

# Docker Extend

Sets up personal Docker tool customization using the project's gitignored override pattern.
Your `Dockerfile.user` and `docker-compose.override.yml` are yours — never committed to git.

## Step 1: Detect Context

Determine if the user is in dev (source build) or deploy (GHCR) mode:

!`if [ -f docker-compose.yml ] && grep -q 'build: \.' docker-compose.yml 2>/dev/null; then echo "DEV_MODE: Building from source (root docker-compose.yml)"; elif [ -f deploy/docker-compose.yml ]; then echo "DEPLOY_MODE: Using GHCR image (deploy/docker-compose.yml)"; else echo "UNKNOWN_MODE: No docker-compose.yml found in root or deploy/"; fi`

**Decision:**
- `DEV_MODE` → work with `Dockerfile.user` + `docker-compose.override.yml` (repo root)
- `DEPLOY_MODE` → work with `deploy/Dockerfile.user` + `deploy/docker-compose.override.yml`
- `UNKNOWN_MODE` → ask the user which directory their `docker-compose.yml` lives in before proceeding

## Step 2: Check Current State

**DEV_MODE — check root files:**

!`echo "=== Dockerfile.user ===" && (cat Dockerfile.user 2>/dev/null || echo "(not found — will create from example)") && echo "" && echo "=== docker-compose.override.yml ===" && (cat docker-compose.override.yml 2>/dev/null || echo "(not found — will create from example)")`

**DEPLOY_MODE — check deploy/ files:**

!`echo "=== deploy/Dockerfile.user ===" && (cat deploy/Dockerfile.user 2>/dev/null || echo "(not found — will create from example)") && echo "" && echo "=== deploy/docker-compose.override.yml ===" && (cat deploy/docker-compose.override.yml 2>/dev/null || echo "(not found — will create from example)")`

**If both files already exist:** Skip to Step 4 (add tools).
**If files are missing:** Proceed to Step 3 (copy from examples).
**If example files are missing too:** Tell the user the project hasn't added the example files yet and to check with the maintainers or the docs.

## Step 3: Copy Example Files

Run only the copy commands for whichever files are missing. Do NOT overwrite existing files.

**DEV_MODE:**

```bash
# Only if Dockerfile.user does not exist:
cp Dockerfile.user.example Dockerfile.user

# Only if docker-compose.override.yml does not exist:
cp docker-compose.override.example.yml docker-compose.override.yml
```

**DEPLOY_MODE:**

```bash
# Only if deploy/Dockerfile.user does not exist:
cp deploy/Dockerfile.user.example deploy/Dockerfile.user

# Only if deploy/docker-compose.override.yml does not exist:
cp deploy/docker-compose.override.example.yml deploy/docker-compose.override.yml
```

After running the copy commands, confirm to the user which files were created.

## Step 4: Add Tools

Parse `$ARGUMENTS` for tool names (space-separated, e.g., `vim ripgrep jq`).

**If tools were specified:** Edit the appropriate `Dockerfile.user` to add (or uncomment) the `RUN apt-get install` block with the requested packages. Use the Edit tool — do not rewrite the entire file.

The block to add/modify:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    <tool1> \
    <tool2> \
 && rm -rf /var/lib/apt/lists/*
```

**If no tools were specified:** Show the user the file and ask which tools they want to add. Then edit the file accordingly.

## Step 5: Rebuild

Show the user the rebuild command for their context. Do NOT run it automatically.

**DEV_MODE:**
```bash
docker compose build && docker compose up -d
```

**DEPLOY_MODE:**
```bash
cd deploy && docker compose build && docker compose up -d
```

## Summary

Tell the user:
1. Which files were created (if any)
2. Which tools were added to `Dockerfile.user` (if any)
3. The rebuild command to run when ready
4. A reminder that `Dockerfile.user` and `docker-compose.override.yml` are gitignored — they're personal and won't be committed
