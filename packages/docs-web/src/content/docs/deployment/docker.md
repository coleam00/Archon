---
title: Docker 가이드
description: 자동 HTTPS, PostgreSQL, Web UI를 포함해 Docker로 Archon을 배포합니다.
category: deployment
area: infra
audience: [operator]
status: current
sidebar:
  order: 2
---

Docker로 server에 HarneesLab을 배포합니다. 자동 HTTPS, PostgreSQL, Web UI 구성이 포함됩니다. HarneesLab은 Archon fork이므로 같은 Docker 배포 방식을 그대로 사용할 수 있습니다.

> **Claude Code는 image에 미리 설치되어 있습니다.** 공식 `ghcr.io/newturn2017/harneeslab` image에는 npm으로 설치된 Claude Code와 미리 설정된 `CLAUDE_BIN_PATH`가 포함되어 있어 추가 설정이 필요 없습니다. npm install을 생략한 custom image를 build하는 경우에는 mounted `cli.js`를 가리키도록 `CLAUDE_BIN_PATH`를 직접 설정하세요([AI Assistants → Binary path configuration](/getting-started/ai-assistants/#binary-path-configuration-compiled-binaries-only) 참고).

---

## Cloud-Init(가장 빠른 설정)

가장 빠른 배포 방법입니다. server를 만들 때 VPS provider의 **User Data** field에 cloud-init config를 붙여 넣으면 필요한 항목이 자동으로 설치됩니다.

**File:** `deploy/cloud-init.yml`

### 사용 방법

1. DigitalOcean, AWS, Linode, Hetzner 등에서 **VPS를 생성**합니다(Ubuntu 22.04+ 권장).
2. `deploy/cloud-init.yml` 내용을 "User Data" / "Cloud-Init" field에 **붙여 넣습니다**.
3. provider UI에서 **SSH key를 추가**합니다.
4. **server를 생성**하고 setup이 끝날 때까지 약 5-8분 기다립니다.

### 설치되는 항목

- Docker + Docker Compose
- UFW firewall(port 22, 80, 443)
- repo를 `/opt/harneeslab`에 clone
- `.env.example` -> `.env`, `Caddyfile.example` -> `Caddyfile` 복사
- PostgreSQL 및 Caddy image pre-pull
- HarneesLab Docker image build

### Boot 이후

server에 SSH로 접속해 설정을 마무리합니다.

```bash
# Check setup completed
cat /opt/harneeslab/SETUP_COMPLETE

# Edit credentials and domain
nano /opt/harneeslab/.env

# Set at minimum:
#   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
#   DOMAIN=archon.example.com
#   DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent

# (Optional) Set up basic auth to protect Web UI:
# docker run caddy caddy hash-password --plaintext 'YOUR_PASSWORD'
# Add to .env: CADDY_BASIC_AUTH=basicauth @protected { admin $$2a$$14$$<hash> }

# Start
cd /opt/harneeslab
docker compose --profile with-db --profile cloud up -d
```

> **DNS를 잊지 마세요.** 시작하기 전에 domain의 A record가 server IP를 가리키도록 설정해야 합니다.

### Provider별 참고 사항

| Provider | cloud-init 붙여넣는 위치 |
|----------|--------------------------|
| **DigitalOcean** | Create Droplet -> Advanced Options -> User Data |
| **AWS EC2** | Launch Instance -> Advanced Details -> User Data |
| **Linode** | Create Linode -> Add Tags -> Metadata (User Data) |
| **Hetzner** | Create Server -> Cloud config -> User Data |
| **Vultr** | Deploy -> Additional Features -> Cloud-Init User-Data |

---

## Local Docker Desktop(Windows / macOS)

Docker Desktop으로 HarneesLab을 로컬에서 실행합니다. domain이나 VPS가 필요 없으며, SQLite와 Web UI만 사용합니다.

### 빠른 시작

```bash
git clone https://github.com/NewTurn2017/HarneesLab.git
cd HarneesLab
cp .env.example .env
# Edit .env: set CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_API_KEY
docker compose up -d
```

Web UI는 **http://localhost:3000**에서 열 수 있습니다.

### Windows 참고 사항

**PowerShell이 아니라 WSL에서 build하세요.** Windows의 Docker Desktop은 build context transfer 중 Bun workspace symlink를 따라가지 못합니다. `The file cannot be accessed by the system`이 보이면 WSL terminal을 열고 실행하세요.

```bash
cd /mnt/c/Users/YourName/path/to/HarneesLab
docker compose up -d
```

**Line endings:** 이 repo는 shell script에 LF ending을 강제하도록 `.gitattributes`를 사용합니다. 이 설정이 추가되기 전에 clone했고 `exec docker-entrypoint.sh: no such file or directory`가 보이면 다시 clone하거나 다음을 실행하세요.

```bash
git rm --cached -r .
git reset --hard
```

### 실행 후 제공되는 것

| Feature | Status |
|---------|--------|
| Web UI | http://localhost:3000 |
| Database | SQLite(자동, zero setup) |
| HTTPS / Caddy | 로컬에서는 필요 없음 |
| Auth | 없음(single-user, localhost only) |
| Platform adapters | 선택 사항(Telegram, Slack 등) |

### 로컬에서 PostgreSQL 사용(선택)

```bash
docker compose --profile with-db up -d
```

그다음 `.env`에 추가합니다.

```env
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

---

## Manual server 설정

cloud-init을 사용하지 않거나 더 세밀하게 제어하고 싶을 때 쓰는 단계별 대안입니다.

### 1. Docker 설치

```bash
# On Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Log out and back in for group change to take effect
exit
# ssh back in

# Verify
docker --version
docker compose version
```

### 2. Repo clone

```bash
git clone https://github.com/NewTurn2017/HarneesLab.git
cd HarneesLab
```

### 3. Environment 설정

```bash
cp .env.example .env
cp Caddyfile.example Caddyfile
nano .env
```

`.env`에 다음 값을 설정합니다.

```ini
# AI Assistant — at least one is required
# Option A: Claude OAuth token (run `claude setup-token` on your local machine to get one)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx
# Option B: Claude API key (from console.anthropic.com/settings/keys)
# CLAUDE_API_KEY=sk-ant-xxxxx

# Domain — your domain or subdomain pointing to this server
DOMAIN=archon.example.com

# Database — connect to the Docker PostgreSQL container
# Without this, the app uses SQLite (fine for getting started, but PostgreSQL recommended)
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent

# Basic Auth (optional) — protects Web UI when exposed to the internet
# Skip if using IP-based firewall rules instead.
# Generate hash: docker run caddy caddy hash-password --plaintext 'YOUR_PASSWORD'
# CADDY_BASIC_AUTH=basicauth @protected { admin $$2a$$14$$... }

# Platform tokens (set the ones you use)
# TELEGRAM_BOT_TOKEN=123456789:ABCdef...
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_APP_TOKEN=xapp-...
# GH_TOKEN=ghp_...
# GITHUB_TOKEN=ghp_...
```

> **Docker는 `CLAUDE_USE_GLOBAL_AUTH=true`를 지원하지 않습니다.** container 안에는 local `claude` CLI가 없습니다. `CLAUDE_CODE_OAUTH_TOKEN` 또는 `CLAUDE_API_KEY`를 명시적으로 제공해야 합니다.
>
> **`DATABASE_URL` 없이 `--profile with-db`를 사용하면**, app은 SQLite로 fallback하고 warning을 log에 남깁니다. PostgreSQL container는 실행되지만 사용되지 않습니다.

### 4. Domain을 server에 연결

domain registrar에서 DNS **A record**를 생성합니다.

| Type | Name | Value |
|------|------|-------|
| A | `archon`(root domain이면 `@`) | server의 public IP |

DNS propagation을 기다립니다(보통 5-60분). `dig archon.example.com`으로 확인합니다.

### 5. Firewall port 열기

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443
sudo ufw --force enable
```

### 6. 시작

```bash
docker compose --profile with-db --profile cloud up -d
```

세 개의 container가 시작됩니다.

- **app** — HarneesLab server + Web UI
- **postgres** — PostgreSQL 17 database(자동 초기화)
- **caddy** — 자동 HTTPS를 제공하는 reverse proxy(Let's Encrypt)

### 7. 확인

```bash
# Check all containers are running
docker compose --profile with-db --profile cloud ps

# Watch logs
docker compose logs -f app
docker compose logs -f caddy

# Test HTTPS (from your local machine)
curl https://archon.example.com/api/health
```

browser에서 **https://harneeslab.example.com**을 열면 HarneesLab Web UI가 보여야 합니다.

---

## Profile

Archon은 Docker Compose profile로 PostgreSQL 또는 HTTPS를 선택적으로 추가합니다. 필요에 따라 조합해서 사용합니다.

| Command | What runs |
|---------|-----------|
| `docker compose up -d` | SQLite를 사용하는 App |
| `docker compose --profile with-db up -d` | App + PostgreSQL |
| `docker compose --profile cloud up -d` | App + Caddy(HTTPS) |
| `docker compose --profile with-db --profile cloud up -d` | App + PostgreSQL + Caddy |

:::note
`external-db` profile은 없습니다. 외부 PostgreSQL database(Supabase, Neon 등)를 사용할 때는 `.env`에 `DATABASE_URL`만 설정하고 profile 없이 `docker compose up -d`를 실행하세요. 기본 `app` service는 항상 시작됩니다.
:::

### No profile(SQLite)

zero-config 기본값입니다. database container가 필요 없으며, SQLite file은 compatibility volume인 `archon_data`에 저장됩니다.

### `--profile with-db`(PostgreSQL)

PostgreSQL 17 container를 시작합니다. `.env`에 connection URL을 설정합니다.

```ini
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

schema는 첫 startup 때 자동으로 초기화됩니다. PostgreSQL은 외부 tool에서 접근할 수 있도록 `${POSTGRES_PORT:-5432}`에 노출됩니다.

### `--profile cloud`(Caddy HTTPS)

Let's Encrypt에서 TLS certificate을 자동으로 발급하는 [Caddy](https://caddyserver.com/) reverse proxy를 추가합니다.

**시작 전 필요 항목:**

1. `Caddyfile` 생성: `cp Caddyfile.example Caddyfile`
2. `.env`에 `DOMAIN` 설정
3. server IP를 가리키는 DNS A record
4. port 80 및 443 open

Caddy는 HTTPS certificate, HTTP->HTTPS redirect, HTTP/3, SSE streaming을 처리합니다.

### Authentication(Optional Basic Auth)

Caddy는 webhook(`/webhooks/*`)과 health check(`/api/health`)를 제외한 모든 route에 HTTP Basic Auth를 적용할 수 있습니다. 선택 사항이므로 IP 기반 firewall rule 또는 다른 network-level access control을 사용한다면 생략해도 됩니다.

**활성화 방법:**

1. bcrypt password hash를 생성합니다.

   ```bash
   docker run caddy caddy hash-password --plaintext 'YOUR_PASSWORD'
   ```

2. `.env`에 `CADDY_BASIC_AUTH`를 설정합니다(bcrypt hash의 `$`는 `$$`로 escape).

   ```ini
   CADDY_BASIC_AUTH=basicauth @protected { admin $$2a$$14$$abc123... }
   ```

3. restart합니다: `docker compose --profile cloud restart caddy`

HarneesLab URL에 접근하면 browser가 username/password를 요청합니다. Webhook endpoint는 HMAC signature verification을 사용하므로 auth를 우회합니다.

비활성화하려면 `CADDY_BASIC_AUTH`를 비우거나 설정하지 않습니다. Caddyfile은 이를 빈 값으로 확장합니다.

> **중요:** hash 생성에는 항상 `docker run caddy caddy hash-password` command를 사용하세요. `.env`에 plaintext password를 넣지 마세요.

### Form-Based Authentication(HTML Login Page)

browser의 credential popup 대신 styled HTML login form을 제공하는 basic auth의 대안입니다. lightweight `auth-service` sidecar와 Caddy의 `forward_auth` directive를 사용합니다.

**form auth와 basic auth 중 선택 기준:**

- **Form auth**: styled dark-mode login page, 24h session cookie, logout support가 필요할 때. 추가 container가 필요합니다.
- **Basic auth**: 추가 container 없이 더 단순한 설정. browser가 native credential dialog를 표시합니다.

**설정:**

1. bcrypt password hash를 생성합니다.

   ```bash
   docker compose --profile auth run --rm auth-service \
     node -e "require('bcryptjs').hash('YOUR_PASSWORD', 12).then(h => console.log(h))"
   ```

   > 첫 실행에서는 auth-service image를 build합니다. 출력된 hash(`$2b$12$...`로 시작)를 저장해 둡니다.

2. random cookie signing secret을 생성합니다.

   ```bash
   docker run --rm node:22-alpine \
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. `.env`에 다음을 설정합니다.

   ```ini
   AUTH_USERNAME=admin
   AUTH_PASSWORD_HASH=$2b$12$REPLACE_WITH_YOUR_HASH
   COOKIE_SECRET=REPLACE_WITH_64_HEX_CHARS
   ```

4. `Caddyfile`을 update합니다(아직 복사하지 않았다면 `Caddyfile.example`에서 복사).

   - "Option A" form auth block(`handle /login`, `handle /logout`, `handle { forward_auth ... }` block)을 **uncomment**합니다.
   - "No auth" default `handle` block(site block 하단 근처의 마지막 `handle { ... }` block)을 **comment out**합니다.

5. `cloud`와 `auth` profile을 함께 사용해 시작합니다.

   ```bash
   docker compose --profile with-db --profile cloud --profile auth up -d
   ```

6. domain에 방문하면 `/login`으로 redirect되어야 합니다.

**Logout:** `/logout`으로 이동하면 session cookie가 지워지고 login form으로 돌아갑니다.

**Session duration:** 기본값은 24시간(`COOKIE_MAX_AGE=86400`)입니다. `.env`에서 override할 수 있습니다.

```ini
COOKIE_MAX_AGE=3600  # 1 hour
```

> **참고:** form auth와 basic auth를 동시에 사용하지 마세요. 둘 중 하나만 선택하고 다른 방식은 disabled 상태로 두세요(`CADDY_BASIC_AUTH`를 비우거나 Caddyfile에서 basic auth `@protected` block 제거).

---

## 설정

### Port Defaults

:::caution
Docker 기본 port는 **3000**입니다(`docker-compose.yml`의 `${PORT:-3000}`). 반면 local development 기본 port는 **3090**입니다. Docker port를 바꾸려면 `.env`에 `PORT`를 설정하세요.
:::

Docker healthcheck는 `/health`가 아니라 `/api/health`를 사용합니다.

```bash
# Inside Docker
curl http://localhost:3000/api/health

# Local development (both work)
curl http://localhost:3090/health
curl http://localhost:3090/api/health
```

### AI Credentials(필수)

Docker container는 `CLAUDE_USE_GLOBAL_AUTH=true`를 사용할 수 없습니다. container 안에는 local `claude` CLI가 없습니다. `.env`에 credential을 명시적으로 설정해야 합니다.

**Claude(하나 선택):**

```ini
# OAuth token — run `claude setup-token` on your local machine, copy the token
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx

# Or API key — from console.anthropic.com/settings/keys
CLAUDE_API_KEY=sk-ant-xxxxx
```

**Codex(대안):**

```ini
CODEX_ID_TOKEN=eyJhbGc...
CODEX_ACCESS_TOKEN=eyJhbGc...
CODEX_REFRESH_TOKEN=rt_...
CODEX_ACCOUNT_ID=6a6a7ba6-...
```

### Platform Tokens(선택)

```ini
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
DISCORD_BOT_TOKEN=...
GH_TOKEN=ghp_...
GITHUB_TOKEN=ghp_...
WEBHOOK_SECRET=...
```

### Server Settings(선택)

```ini
PORT=3000                          # Default: 3000
DOMAIN=archon.example.com          # Required for --profile cloud
LOG_LEVEL=info                     # fatal|error|warn|info|debug|trace
MAX_CONCURRENT_CONVERSATIONS=10
```

전체 목록과 설명은 `.env.example`을 참고하세요.

### Data Directory

container는 새 compose 기준으로 모든 data를 `/.harneeslab/`에 저장합니다(workspaces, worktrees, artifacts, logs, SQLite DB). 기존 `ARCHON_DOCKER`/`/.archon` compose 구성도 compatibility path로 계속 동작합니다.

기본값은 Docker-managed volume입니다. host의 특정 위치에 data를 저장하려면 `.env`에 `HARNEESLAB_DATA`를 설정합니다. 기존 `ARCHON_DATA`도 fallback으로 계속 인식됩니다.

```ini
# Store HarneesLab data at a specific host path
HARNEESLAB_DATA=/opt/harneeslab-data
```

directory는 자동으로 생성됩니다. container user인 UID 1001이 쓸 수 있는지 확인하세요.

```bash
mkdir -p /opt/harneeslab-data
sudo chown -R 1001:1001 /opt/harneeslab-data
```

`HARNEESLAB_DATA`와 `ARCHON_DATA`가 모두 설정되어 있지 않으면 Docker가 기존 사용자 보호를 위해 compatibility volume(`archon_data`)을 자동으로 관리합니다. 새 이름의 named volume을 사용하려면 `HARNEESLAB_DATA=harneeslab_data`를 설정하거나, 원하는 host path로 migration한 뒤 `HARNEESLAB_DATA`를 지정하세요.

HarneesLab compose file은 service/network label을 새 이름으로 정리했기 때문에 upgrade 시 Docker가 network와 container를 다시 만들 수 있습니다. 이 동작은 stateless network/container에 한정되며, data는 위의 volume 설정에 따라 유지됩니다. 기존 data를 보존해야 하면 `docker compose down -v`는 실행하지 마세요.

### GitHub CLI Authentication

`.env`의 `GH_TOKEN`은 자동으로 사용됩니다. 또는 다음을 실행할 수 있습니다.

```bash
docker compose exec app gh auth login
```

---

## GitHub Webhook

server가 HTTPS로 접근 가능해진 뒤 설정합니다.

1. `https://github.com/<owner>/<repo>/settings/hooks`로 이동합니다.
2. webhook을 추가합니다.
   - **Payload URL**: `https://archon.example.com/webhooks/github`
   - **Content type**: `application/json`
   - **Secret**: `.env`의 `WEBHOOK_SECRET`
   - **Events**: Issues, Issue comments, Pull requests

---

## Pre-built image

source에서 build할 필요가 없는 사용자를 위한 방식입니다.

```bash
mkdir archon && cd archon
curl -O https://raw.githubusercontent.com/NewTurn2017/HarneesLab/dev/deploy/docker-compose.yml
curl -O https://raw.githubusercontent.com/NewTurn2017/HarneesLab/dev/.env.example

cp .env.example .env
# Edit .env — set AI credentials, DOMAIN, etc.

docker compose up -d
```

`ghcr.io/newturn2017/harneeslab:latest`를 사용합니다. PostgreSQL을 추가하려면 compose file에서 `postgres` service를 uncomment하고 `.env`에 `DATABASE_URL`을 설정하세요.

pre-built image 위에 custom tool을 추가하려면 [Customizing the Image](#customizing-the-image)를 참고하세요.

---

## Image build

Dockerfile은 세 단계로 구성됩니다.

1. **deps** — 모든 dependency 설치(web build용 devDependencies 포함)
2. **web-build** — Vite로 React web UI build
3. **production** — production dependency와 pre-built web asset만 포함한 production image

```bash
docker build -t harneeslab .
docker run --env-file .env -p 3000:3000 harneeslab
```

**image에 포함되는 것:**

- **Runtime**: Bun 1.2(TypeScript를 직접 실행, compile step 없음)
- **System deps**: git, curl, gh(GitHub CLI), postgresql-client, Chromium
- **Browser tooling**: [agent-browser](https://github.com/vercel-labs/agent-browser)(Vercel Labs) — CDP를 통한 E2E testing workflow를 활성화합니다. system Chromium(`AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`)을 사용합니다.
- **App**: 모든 10개 workspace package(source), pre-built web UI
- **User**: non-root `appuser`(UID 1001) — Claude Code SDK에 필요
- **HarneesLab dirs**: `/.harneeslab/workspaces`, `/.harneeslab/worktrees`

multi-stage build는 image를 가볍게 유지합니다. devDependencies, test file, docs, `.git/`은 포함하지 않습니다.

<a id="customizing-the-image"></a>

### Image 커스터마이징

tracked Dockerfile을 수정하지 않고 추가 tool을 넣으려면:

1. 예시 file을 복사합니다.
   - **Local/dev**: `cp Dockerfile.user.example Dockerfile.user`
   - **Server/deploy**: `cp deploy/Dockerfile.user.example Dockerfile.user`
2. `Dockerfile.user`를 편집합니다. 필요한 예시를 uncomment하고 확장합니다.
3. override file을 복사합니다.
   - **Local/dev**: `cp docker-compose.override.example.yml docker-compose.override.yml`
   - **Server/deploy**: `cp deploy/docker-compose.override.example.yml docker-compose.override.yml`
4. `docker compose up -d`를 실행합니다. Compose가 override를 자동으로 merge합니다.

`Dockerfile.user`와 `docker-compose.override.yml`은 gitignored 상태이므로 custom 설정은 로컬에만 남습니다.

---

## 유지보수

### Log 보기

```bash
docker compose logs -f              # All services
docker compose logs -f app          # App only
docker compose logs --tail=100 app  # Last 100 lines
```

### 업데이트

```bash
git pull
docker compose --profile with-db --profile cloud up -d --build
```

### Restart

```bash
docker compose restart         # All
docker compose restart app     # App only
```

### 중지

```bash
docker compose down            # Stop containers (data preserved)
docker compose down -v         # Stop + delete volumes (destructive!)
```

### Database Migrations(PostgreSQL)

첫 startup에서는 `000_combined.sql`을 통해 migration이 자동으로 실행됩니다. database table을 추가하는 새 version으로 upgrade할 때는 incremental migration을 수동으로 적용해야 합니다.

```bash
# Example: apply the env vars migration (required when upgrading to v0.3.x)
docker compose exec postgres psql -U postgres -d remote_coding_agent -f /migrations/020_codebase_env_vars.sql
```

`migrations/` directory는 postgres container에 read-only로 mounted됩니다. update를 pull한 뒤 새 migration file이 있는지 확인하세요.

### Docker Resource 정리

```bash
docker system prune -a         # Remove unused images/containers
docker volume prune            # Remove unused volumes (caution!)
docker system df               # Check disk usage
```

---

## 문제 해결

### App이 시작되지 않음: "no_ai_credentials"

AI assistant가 설정되지 않았습니다. Docker는 `CLAUDE_USE_GLOBAL_AUTH=true`를 지원하지 않습니다. `.env`에 다음 중 하나를 설정하세요.

- `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...`(로컬에서 `claude setup-token` 실행)
- `CLAUDE_API_KEY=sk-ant-...`(console.anthropic.com에서 발급)
- 또는 Codex credential(`CODEX_ID_TOKEN`, `CODEX_ACCESS_TOKEN` 등)

### Caddy 시작 실패: "not a directory"

```
error mounting "Caddyfile": not a directory
```

`Caddyfile`이 없습니다. Docker가 그 자리에 directory를 만들었습니다. 다음처럼 수정합니다.

```bash
rm -rf Caddyfile
cp Caddyfile.example Caddyfile
docker compose --profile cloud up -d
```

### Caddy가 SSL certificate을 받지 못함

```bash
# Check DNS propagation
dig archon.example.com
# Should return your server IP

# Check Caddy logs
docker compose logs caddy

# Check firewall
sudo ufw status
# Ports 80 and 443 must be open
```

흔한 원인: DNS propagation 미완료(5-60분 대기), firewall이 80/443 차단, `.env`의 domain typo.

### Health check 실패

Docker healthcheck는 `/health`가 아니라 `/api/health`를 사용합니다.

```bash
curl http://localhost:3000/api/health
```

### PostgreSQL connection refused

`--profile with-db`를 사용할 때 다음을 확인합니다.

1. `DATABASE_URL`의 hostname은 `localhost`가 아니라 Docker service name인 `postgres`여야 합니다.
   ```ini
   DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
   ```
2. postgres container가 healthy 상태인지 확인합니다: `docker compose ps postgres`
3. migration이 실행되었는지 확인합니다: init script output은 `docker compose logs postgres`에서 볼 수 있습니다.

### `/.harneeslab/` permission error

container는 `appuser`(UID 1001)로 실행됩니다. Docker volume 대신 bind mount를 사용하는 경우:

```bash
sudo chown -R 1001:1001 /path/to/harneeslab-data
```

### Port conflicts

Docker 기본 port는 3000입니다(local dev는 3090). `.env`에서 변경합니다.

```ini
PORT=3001
```

### Container가 계속 restart됨

```bash
docker compose ps
docker compose logs --tail=50 app
```

흔한 원인: `.env` file 누락, invalid credential, database 접근 불가.
