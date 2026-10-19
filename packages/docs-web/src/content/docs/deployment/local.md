---
title: Local Development
description: Run the Archon server and Web UI on your own machine, with SQLite or PostgreSQL.
category: deployment
area: infra
audience: [operator]
status: current
sidebar:
  order: 1
---

The CLI needs no server. Run the server when you want the Web UI, chat adapters or webhooks. For a VPS with HTTPS, see [Cloud Deployment](/deployment/cloud/); for containers, see [Docker](/deployment/docker/).

## Start the server

With an installed binary:

```bash
archon serve                 # API and Web UI on http://localhost:3090
archon serve --port 4000     # another port
```

A binary install downloads the server and Web UI on the first run. `archon serve --download-only` fetches them without starting.

From a source checkout, `bun run dev` starts the API on port 3090 and the Vite dev server for the Web UI on port 5173; see the [new developer guide](/contributing/new-developer-guide/). A run inside a worktree gets an automatic port from 3190 to 4089, based on the path. `PORT` overrides the port in any context.

Check it:

```bash
curl http://localhost:3090/health               # {"status":"ok"}
curl http://localhost:3090/health/db            # database connectivity
curl http://localhost:3090/health/concurrency   # concurrency status
```

## Choose a database

| Option | Setup | Best for |
|---|---|---|
| SQLite (default) | Nothing. Leave `DATABASE_URL` unset | One operator, CLI use, local work |
| PostgreSQL | Set `DATABASE_URL` | Shared or server installs |

SQLite stores data at `~/.archon/archon.db` and creates it on first run. For a local PostgreSQL container, run `docker compose --profile with-db up -d postgres` from a source checkout and set `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/remote_coding_agent`. The server creates and upgrades the schema on startup. See [Database](/reference/database/).

## Troubleshooting

If the port is taken, find the process with `lsof -i :3090` on macOS or Linux, or `netstat -ano | findstr :3090` on Windows, or start on another port with `--port`.
