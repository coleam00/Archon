---
title: 로컬 개발
description: 개발과 개인 사용을 위해 SQLite 또는 PostgreSQL로 HarnessLab을 로컬 실행합니다.
category: deployment
area: infra
audience: [operator]
status: current
sidebar:
  order: 1
---

이 가이드는 HarnessLab server를 로컬, Docker, 프로덕션에서 실행하는 방법을 다룹니다. 자동 HTTPS를 포함한 VPS 배포는 [Cloud 배포 가이드](/deployment/cloud/)를 참고하세요.

**빠른 링크:** [로컬 개발](#local-development) | [Remote DB를 사용하는 Docker](#docker-with-remote-postgresql) | [Local PostgreSQL을 사용하는 Docker](#docker-with-local-postgresql) | [프로덕션](#production-deployment)

---

## 로컬 개발

SQLite를 사용하는 로컬 개발이 권장 기본값입니다. database 설정이 필요 없습니다.

### 사전 준비

- [Bun](https://bun.sh) 1.0+
- 설치 및 설정이 완료된 AI assistant 최소 1개(Claude Code 또는 Codex. HarnessLab은 이를 orchestrate하지만 bundle하지 않습니다)
- repository cloning용 GitHub token(`GH_TOKEN` / `GITHUB_TOKEN`)

> source install(`bun run`)은 `node_modules`를 통해 Claude Code의 `cli.js`를 자동으로 resolve합니다. compiled HarnessLab binary에는 `CLAUDE_BIN_PATH` 또는 `assistants.claude.claudeBinaryPath`가 필요합니다. [AI Assistants → Binary path configuration](/getting-started/ai-assistants/#binary-path-configuration-compiled-binaries-only)을 참고하세요.

### 설정

```bash
# 1. Clone and install
git clone https://github.com/NewTurn2017/HarnessLab
cd HarnessLab
bun install

# 2. Configure environment
cp .env.example .env
nano .env  # Add your AI assistant tokens (Claude or Codex)

# 3. Start server + Web UI (SQLite auto-detected, no database setup needed)
bun run dev

# 4. Open Web UI
# http://localhost:5173
```

개발 모드에서는 두 server가 동시에 실행됩니다.

| Service    | URL                    | 용도                             |
|------------|------------------------|----------------------------------|
| Web UI     | http://localhost:5173  | React frontend(Vite dev server) |
| API Server | http://localhost:3090  | Backend API + SSE streaming      |

### 선택: SQLite 대신 PostgreSQL 사용

로컬 개발에서 PostgreSQL을 선호한다면 다음을 실행합니다.

```bash
docker compose --profile with-db up -d postgres
# Set DATABASE_URL=postgresql://postgres:postgres@localhost:5432/remote_coding_agent in .env
```

> **참고:** database schema는 첫 container startup 때 mounted migration file을 통해 자동으로 생성됩니다. fresh install에서는 수동 `psql` 단계가 필요 없습니다.

### 프로덕션 build(로컬)

```bash
bun run build    # Build the frontend
bun run start    # Server serves both API and Web UI on port 3090
```

### 동작 확인

```bash
curl http://localhost:3090/health
# Expected: {"status":"ok"}
```

---

## Remote PostgreSQL을 사용하는 Docker

database가 외부에서 hosted되는 경우(Supabase, Neon, AWS RDS 등) 이 옵션을 사용합니다. app container만 시작합니다.

### 사전 준비

- Docker 및 Docker Compose
- `.env`에 `DATABASE_URL`이 설정된 remote PostgreSQL database
- `.env`에 설정된 AI assistant token

### 설정

external database를 사용할 때 app container는 profile 없이 실행됩니다. `external-db` profile은 없습니다. 기본 `app` service가 항상 시작됩니다.

```bash
# 1. Get the deployment files
mkdir archon && cd archon
curl -fsSL https://raw.githubusercontent.com/NewTurn2017/HarnessLab/dev/deploy/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/NewTurn2017/HarnessLab/dev/deploy/.env.example -o .env

# 2. Configure (edit .env with your tokens and DATABASE_URL)
nano .env

# 3. Start app container (no profile needed for external DB)
docker compose up -d

# 4. View logs
docker compose logs -f app

# 5. Verify
curl http://localhost:3000/api/health
```

:::note
Docker의 기본 port는 **3000**입니다(`.env`의 `PORT`로 설정). 로컬 개발의 기본 port는 **3090**입니다. Docker의 health endpoint는 `/api/health`이고, local dev mode에서는 `/health`도 동작합니다.
:::

### Database migration(최초 1회)

fresh install에서는 combined migration을 실행합니다.

```bash
psql $DATABASE_URL < migrations/000_combined.sql
```

### 중지

```bash
docker compose down
```

---

## Local PostgreSQL을 사용하는 Docker

app과 PostgreSQL을 모두 Docker container에서 실행하려면 이 옵션을 사용합니다. database schema는 첫 startup 때 자동으로 생성됩니다.

### 설정

```bash
# 1. Configure .env
# Set: DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent

# 2. Start both containers
docker compose --profile with-db up -d --build

# 3. Wait for startup (watch logs)
docker compose logs -f app

# 4. Verify
curl http://localhost:3000/api/health
```

> **참고:** database table은 첫 startup 때 init script로 자동 생성됩니다. 수동 migration 단계는 필요하지 않습니다.

### 기존 설치 업데이트

새 migration이 추가되면 수동으로 적용합니다.

```bash
# Connect to the running postgres container
docker compose exec postgres psql -U postgres -d remote_coding_agent

# For a fresh install, run the combined migration (idempotent, creates all 7 tables):
\i /migrations/000_combined.sql

# Or apply individual migrations you haven't applied yet.
# Check the migrations/ directory for the full list (currently 001 through 019).
\q
```

### 중지

```bash
docker compose --profile with-db down
```

---

## 프로덕션 배포

Caddy를 통한 자동 HTTPS와 함께 VPS(DigitalOcean, Linode, AWS EC2 등)에 배포하려면 [Cloud 배포 가이드](/deployment/cloud/)를 참고하세요.

---

## Database 옵션 요약

| 옵션 | 설정 | 적합한 용도 |
|--------|-------|----------|
| **SQLite**(기본값) | 설정 없음, `DATABASE_URL`만 생략 | single-user, CLI 사용, 로컬 개발 |
| **Remote PostgreSQL** | hosted DB로 `DATABASE_URL` 설정 | cloud 배포, shared access |
| **Local PostgreSQL** | Docker `--profile with-db` | self-hosted, Docker 기반 setup |

SQLite는 데이터를 `~/.archon/archon.db`(Docker에서는 `/.archon/archon.db`)에 저장합니다. 첫 실행 시 자동으로 초기화됩니다.

---

## Port 설정

| Context | 기본 port | 참고 |
|---------|-------------|-------|
| Local dev(`bun run dev`) | 3090 | 기본 server port |
| Docker | 3000 | `.env`의 `PORT`로 설정 |
| Worktrees | 3190-4089 | path hash 기반 자동 할당 |
| Override | Any | `PORT=4000 bun dev` 설정 |

:::tip
local dev(3090)와 Docker(3000)의 port 차이는 의도된 것입니다. 어느 context에서든 `PORT` 환경 변수로 override할 수 있습니다.
:::

---

## Health endpoint

| Context | Endpoint | 참고 |
|---------|----------|-------|
| Docker / production | `/api/health` | Docker healthcheck에서 사용 |
| Local dev | `/health` | 편의 alias(`/api/health`도 지원) |

```bash
# Docker
curl http://localhost:3000/api/health

# Local dev
curl http://localhost:3090/health

# Additional checks (both contexts)
curl http://localhost:3090/health/db           # Database connectivity
curl http://localhost:3090/health/concurrency  # Concurrency status
```

---

## 문제 해결

### Container가 시작되지 않음

```bash
# Check logs
docker compose logs app          # default (SQLite or external DB)
docker compose logs app          # --profile with-db

# Verify environment
docker compose config

# Rebuild without cache
docker compose build --no-cache
docker compose up -d
```

### Port 충돌

```bash
# Check if port is in use
lsof -i :3090        # macOS/Linux
netstat -ano | findstr :3090  # Windows
```
