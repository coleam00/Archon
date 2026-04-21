---
title: Cloud 배포
description: Caddy의 자동 HTTPS와 지속적인 uptime으로 Archon을 cloud VPS에 배포합니다.
category: deployment
area: infra
audience: [operator]
status: current
sidebar:
  order: 3
---

> **함께 보기:** profile, build, configuration, troubleshooting을 포함한 전체 Docker reference는 [Docker Guide](/deployment/docker/)를 참고하세요.

HarneesLab을 24/7 운영하기 위해 cloud VPS에 배포합니다. Caddy를 사용해 HTTPS certificate을 자동으로 발급하고 갱신하며, 서비스가 계속 실행되도록 구성합니다. HarneesLab은 Archon fork이므로 같은 배포 절차를 그대로 사용할 수 있습니다.

**목차:** [사전 준비](#prerequisites) | [Server 설정](#1-server-provisioning--initial-setup) | [DNS 설정](#2-dns-configuration) | [Repository 설정](#3-clone-repository) | [Environment 설정](#4-environment-configuration) | [Database migration](#5-database-migration) | [Caddy 설정](#6-caddy-configuration) | [Service 시작](#7-start-services) | [확인](#8-verify-deployment)

---

<a id="prerequisites"></a>

## 사전 준비

**필수:**

- Cloud VPS 계정(DigitalOcean, Linode, AWS EC2, Vultr 등)
- domain name 또는 subdomain(예: `archon.yourdomain.com`)
- 로컬 머신에 설치된 SSH client
- 기본적인 command-line 사용 경험

**권장 사양:**

- **CPU:** 1-2 vCPUs
- **RAM:** 최소 2GB(4GB 권장)
- **Storage:** 20GB SSD
- **OS:** Ubuntu 22.04 LTS

### SSH Key 생성(필수)

**VPS를 만들기 전에**, 로컬 머신에서 SSH key pair를 생성합니다.

```bash
# Generate SSH key (ed25519 recommended)
ssh-keygen -t ed25519 -C "archon"

# When prompted:
# - File location: Press Enter (uses default ~/.ssh/id_ed25519)
# - Passphrase: Optional but recommended

# View your public key (you'll need this for VPS setup)
cat ~/.ssh/id_ed25519.pub
# Windows: type %USERPROFILE%\.ssh\id_ed25519.pub
```

**출력된 public key를 복사해 둡니다.** VPS 생성 과정에서 이 값을 추가합니다.

---

<a id="1-server-provisioning--initial-setup"></a>

## 1. Server 프로비저닝 및 초기 설정

### VPS Instance 생성 예시

<details>
<summary><b>DigitalOcean Droplet</b></summary>

1. [DigitalOcean](https://www.digitalocean.com/)에 로그인합니다.
2. "Create" -> "Droplets"를 클릭합니다.
3. 다음을 선택합니다.
   - **Image:** Ubuntu 22.04 LTS
   - **Plan:** Basic($12/month - 2GB RAM 권장)
   - **Datacenter:** 사용자와 가장 가까운 위치
   - **Authentication:** SSH keys -> "New SSH Key" -> 사전 준비 단계에서 복사한 public key 붙여넣기
4. "Create Droplet"을 클릭합니다.
5. public IP address를 기록해 둡니다.

</details>

<details>
<summary><b>AWS EC2 Instance</b></summary>

1. [AWS Console](https://console.aws.amazon.com/)에 로그인합니다.
2. EC2 -> Launch Instance로 이동합니다.
3. 다음을 선택합니다.
   - **AMI:** Ubuntu Server 22.04 LTS
   - **Instance Type:** t3.small(2GB RAM)
   - **Key Pair:** "Create new key pair" 또는 사전 준비 단계에서 만든 public key import
   - **Security Group:** SSH(22), HTTP(80), HTTPS(443) 허용
4. instance를 launch합니다.
5. public IP address를 기록해 둡니다.

</details>

<details>
<summary><b>Linode Instance</b></summary>

1. [Linode](https://www.linode.com/)에 로그인합니다.
2. "Create" -> "Linode"를 클릭합니다.
3. 다음을 선택합니다.
   - **Image:** Ubuntu 22.04 LTS
   - **Region:** 사용자와 가장 가까운 위치
   - **Plan:** Nanode 2GB($12/month)
   - **SSH Keys:** 사전 준비 단계에서 복사한 public key 추가
   - **Root Password:** 강한 password 설정(backup access용)
4. "Create Linode"를 클릭합니다.
5. public IP address를 기록해 둡니다.

</details>

### 초기 Server 설정

**server에 접속합니다.**

```bash
# Replace with your server IP (uses SSH key from Prerequisites)
ssh -i ~/.ssh/id_ed25519 root@your-server-ip
```

**deployment user를 생성합니다.**

```bash
# Create user with sudo privileges
adduser deploy
usermod -aG sudo deploy

# Copy root's SSH authorized keys to deploy user
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

# Test connection in a new terminal before proceeding:
# ssh -i ~/.ssh/id_ed25519 deploy@your-server-ip
```

**보안을 위해 password authentication을 비활성화합니다.**

```bash
# Edit SSH config
nano /etc/ssh/sshd_config
```

다음 항목을 찾아 변경합니다.

```
PasswordAuthentication no
```

> 변경 후 Nano에서 나오려면 `Ctrl + X` -> `Y` -> `Enter`를 누릅니다.

SSH를 restart합니다.

```bash
systemctl restart ssh

# Switch to deploy user for remaining steps
su - deploy
```

**firewall을 설정합니다.**

```bash
# Allow SSH, HTTP, HTTPS (including HTTP/3)
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443

# Enable firewall
sudo ufw --force enable

# Check status
sudo ufw status
```

### Dependency 설치

**Docker를 설치합니다.**

```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add deploy user to docker group
sudo usermod -aG docker deploy

# Log out and back in for group changes to take effect
exit
ssh -i ~/.ssh/id_ed25519 deploy@your-server-ip
```

**Docker Compose, Git, PostgreSQL Client를 설치합니다.**

```bash
# Update package list
sudo apt update

# Install required packages
sudo apt install -y docker-compose-plugin git postgresql-client

# Verify installations
docker --version
docker compose version
git --version
psql --version
```

---

<a id="2-dns-configuration"></a>

## 2. DNS 설정

domain을 server의 IP address로 연결합니다.

**A Record 설정:**

1. domain registrar 또는 DNS provider(Cloudflare, Namecheap 등)로 이동합니다.
2. **A Record**를 만듭니다.
   - **Name:** `archon`(`archon.yourdomain.com`용) 또는 `@`(`yourdomain.com`용)
   - **Value:** server의 public IP address
   - **TTL:** 300(5분) 또는 기본값

**예시(Cloudflare):**

```
Type: A
Name: archon
Content: 123.45.67.89
Proxy: Off (DNS Only)
TTL: Auto
```

---

<a id="3-clone-repository"></a>

## 3. Repository clone

**server에서 실행합니다.**

```bash
# Create application directory
sudo mkdir -p /opt/harneeslab
sudo chown deploy:deploy /opt/harneeslab

# Clone repository into the directory
cd /opt/harneeslab
git clone https://github.com/NewTurn2017/HarneesLab .
```

---

<a id="4-environment-configuration"></a>

## 4. Environment 설정

### Environment file 생성

```bash
# Copy example file
cp .env.example .env

# Edit with nano
nano .env
```

### 4.1 Core 설정

필수 variable을 설정합니다.

```ini
# Database - Use remote managed PostgreSQL
DATABASE_URL=postgresql://user:password@host:5432/dbname

# GitHub tokens (same value for both)
GH_TOKEN=ghp_your_token_here
GITHUB_TOKEN=ghp_your_token_here

# Server settings
PORT=3090
ARCHON_HOME=/tmp/archon  # Override base directory (optional)
```

**GitHub Token 설정:**

1. [GitHub Settings > Tokens](https://github.com/settings/tokens)에 방문합니다.
2. "Generate new token (classic)"을 클릭합니다.
3. scope로 **`repo`**를 선택합니다.
4. token을 복사합니다(`ghp_...`로 시작).
5. `.env`에 `GH_TOKEN`과 `GITHUB_TOKEN`을 모두 설정합니다.

**Database 옵션:**

> **참고:** SQLite는 로컬 개발의 기본값이며 별도 설정이 필요 없습니다. Cloud 배포에서는 안정성과 network 접근성을 위해 PostgreSQL을 권장합니다.

<details>
<summary><b>Cloud 권장: Remote Managed PostgreSQL</b></summary>

backup과 scaling이 쉬운 managed database service를 사용합니다.

**Supabase(무료 tier 제공):**

1. [supabase.com](https://supabase.com)에서 project를 생성합니다.
2. Settings -> Database로 이동합니다.
3. connection string을 복사합니다(Transaction pooler 권장).
4. `DATABASE_URL`로 설정합니다.

**Neon:**

1. [neon.tech](https://neon.tech)에서 project를 생성합니다.
2. dashboard에서 connection string을 복사합니다.
3. `DATABASE_URL`로 설정합니다.

</details>

<details>
<summary><b>대안: Local PostgreSQL(with-db profile)</b></summary>

app과 함께 Docker에서 PostgreSQL을 실행하려면 다음 값을 사용합니다.

```ini
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

service를 시작할 때 `with-db` profile을 사용합니다(Section 7 참고).

</details>

### 4.2 AI Assistant 설정

**AI assistant를 최소 1개 설정합니다.**

<details>
<summary><b>Claude Code</b></summary>

**로컬 머신에서:**

```bash
# Install Claude Code CLI (if not already installed)
# Visit: https://docs.claude.com/claude-code/installation

# Generate OAuth token
claude setup-token

# Copy the token (starts with sk-ant-oat01-...)
```

**server에서:**

```bash
nano .env
```

다음을 추가합니다.

```ini
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx
```

**대안: API Key**

pay-per-use 방식을 선호한다면:

1. [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)에 방문합니다.
2. key를 생성합니다(`sk-ant-`로 시작).
3. `.env`에 설정합니다.

```ini
CLAUDE_API_KEY=sk-ant-xxxxx
```

**기본값으로 설정(선택):**

```ini
DEFAULT_AI_ASSISTANT=claude
```

</details>

<details>
<summary><b>Codex</b></summary>

**로컬 머신에서:**

```bash
# Install Codex CLI (if not already installed)
# Visit: https://docs.codex.com/installation

# Authenticate
codex login

# Extract credentials
cat ~/.codex/auth.json
# On Windows: type %USERPROFILE%\.codex\auth.json

# Copy all four values
```

**server에서:**

```bash
nano .env
```

네 가지 credential을 모두 추가합니다.

```ini
CODEX_ID_TOKEN=eyJhbGc...
CODEX_ACCESS_TOKEN=eyJhbGc...
CODEX_REFRESH_TOKEN=rt_...
CODEX_ACCOUNT_ID=6a6a7ba6-...
```

**기본값으로 설정(선택):**

```ini
DEFAULT_AI_ASSISTANT=codex
```

</details>

### 4.3 Platform Adapter 설정

**platform을 최소 1개 설정합니다.**

<details>
<summary><b>Telegram</b></summary>

**bot 생성:**

1. Telegram에서 [@BotFather](https://t.me/BotFather)에게 message를 보냅니다.
2. `/newbot`을 보내고 안내를 따릅니다.
3. bot token을 복사합니다(format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`).

**server에서:**

```bash
nano .env
```

다음을 추가합니다.

```ini
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
TELEGRAM_STREAMING_MODE=stream  # stream (default) | batch
```

</details>

<details>
<summary><b>GitHub Webhooks</b></summary>

**이 설정은 deployment 이후에 진행합니다.** 먼저 public URL이 필요합니다.

지금은 webhook secret만 생성합니다.

```bash
# Generate secret
openssl rand -hex 32

# Copy the output
```

`.env`에 추가합니다.

```ini
WEBHOOK_SECRET=your_generated_secret_here
```

**GitHub webhook 설정은 service가 실행된 뒤 Section 9에서 진행합니다.**

</details>

**Nano 저장 및 종료:** `Ctrl+X`, `Y`, `Enter`

---

<a id="5-database-migration"></a>

## 5. Database migration

**중요: application을 시작하기 전에 실행합니다.**

필수 table을 포함한 database schema를 초기화합니다.

```bash
# For remote database (Supabase, Neon, etc.)
psql $DATABASE_URL < migrations/000_combined.sql

# Verify tables were created
psql $DATABASE_URL -c "\dt"
# Should show: codebases, conversations, sessions, isolation_environments,
#              workflow_runs, workflow_events, messages
```

**local PostgreSQL을 `with-db` profile로 사용하는 경우:**

Section 7에서 database를 시작한 뒤 migration을 실행합니다.

---

<a id="6-caddy-configuration"></a>

## 6. Caddy 설정

Caddy는 Let's Encrypt certificate을 사용해 HTTPS를 자동으로 제공합니다.

### Caddyfile 생성

```bash
# Copy the example — no manual editing needed
cp Caddyfile.example Caddyfile
```

Caddyfile은 `.env`에서 `{$DOMAIN}`과 `{$PORT}`를 자동으로 읽습니다. `DOMAIN`이 설정되어 있는지 확인합니다.

```ini
DOMAIN=archon.yourdomain.com
```

### Caddy 동작 방식

- Let's Encrypt에서 SSL certificate을 자동으로 발급합니다.
- HTTPS(443)와 HTTP(80) -> HTTPS redirect를 처리합니다.
- request를 port 3090의 app container로 proxy합니다.
- certificate을 자동으로 갱신합니다.

---

<a id="7-start-services"></a>

## 7. Service 시작

### Workspace permission 설정(Linux 전용)

```bash
# Create workspace directory and set permissions for container user (UID 1001)
mkdir -p workspace
sudo chown -R 1001:1001 workspace
```

### Option A: Remote PostgreSQL 사용(권장)

managed database를 사용하는 경우:

```bash
# Start app with Caddy reverse proxy
docker compose --profile cloud up -d --build

# View logs
docker compose --profile cloud logs -f app
```

### Option B: Local PostgreSQL 사용

`with-db` profile을 사용하는 경우:

```bash
# Start app, postgres, and Caddy
docker compose --profile with-db --profile cloud up -d --build

# View logs
docker compose --profile with-db --profile cloud logs -f app
docker compose --profile with-db --profile cloud logs -f postgres
```

### Startup 모니터링

```bash
# Watch logs for successful startup (use --profile with-db for local PostgreSQL)
docker compose --profile cloud logs -f app

# Look for:
# [App] Starting HarneesLab
# [Database] Connected successfully
# [App] HarneesLab is ready!
```

**log 화면을 종료하려면 `Ctrl+C`를 누릅니다(service는 계속 실행됩니다).**

---

<a id="8-verify-deployment"></a>

## 8. Deployment 확인

### Health endpoint 확인

**로컬 머신에서:**

```bash
# Basic health check
curl https://archon.yourdomain.com/api/health
# Expected: {"status":"ok"}

# Database connectivity
curl https://archon.yourdomain.com/api/health/db
# Expected: {"status":"ok","database":"connected"}

# Concurrency status
curl https://archon.yourdomain.com/api/health/concurrency
# Expected: {"status":"ok","active":0,"queued":0,"maxConcurrent":10}
```

### SSL Certificate 확인

browser에서 `https://archon.yourdomain.com/api/health`에 방문합니다.

- green padlock이 표시되어야 합니다.
- certificate issuer가 "Let's Encrypt"여야 합니다.
- HTTP에서 HTTPS로 자동 redirect되어야 합니다.

### Telegram 확인(설정한 경우)

Telegram에서 bot에게 message를 보냅니다.

```
/help
```

사용 가능한 command와 함께 bot response를 받아야 합니다.

---

## 9. GitHub Webhook 설정

app에 public URL이 생겼으므로 GitHub webhook을 설정합니다.

### Webhook Secret 생성(앞에서 하지 않은 경우)

```bash
# On server
openssl rand -hex 32

# Copy output to .env as WEBHOOK_SECRET if not already set
```

### Repository에 Webhook 추가

1. `https://github.com/owner/repo/settings/hooks`로 이동합니다.
2. "Add webhook"을 클릭합니다.

**Webhook 설정:**

| Field                | Value                                                                        |
| -------------------- | ---------------------------------------------------------------------------- |
| **Payload URL**      | `https://archon.yourdomain.com/webhooks/github`                              |
| **Content type**     | `application/json`                                                           |
| **Secret**           | `.env`의 `WEBHOOK_SECRET`                                                    |
| **SSL verification** | SSL verification 활성화                                                      |
| **Events**           | individual events 선택: Issues, Issue comments, Pull requests                |

3. "Add webhook"을 클릭합니다.
4. "Recent Deliveries" tab에서 성공한 delivery(green checkmark)를 확인합니다.

**Webhook 테스트:**

issue에 comment를 남깁니다.

```
@your-bot-name can you analyze this issue?
```

bot이 analysis로 응답해야 합니다.

---

## 10. Maintenance 및 운영

### Log 보기

```bash
# All services
docker compose --profile cloud logs -f

# Specific service
docker compose --profile cloud logs -f app
docker compose --profile cloud logs -f caddy

# Last 100 lines
docker compose --profile cloud logs --tail=100 app
```

### Application 업데이트

```bash
# Pull latest changes
cd /opt/harneeslab
git pull

# Rebuild and restart
docker compose --profile cloud up -d --build

# Check logs
docker compose --profile cloud logs -f app
```

### Service restart

```bash
# Restart all services
docker compose --profile cloud restart

# Restart specific service
docker compose --profile cloud restart app
docker compose --profile cloud restart caddy
```

### Service 중지

```bash
# Stop all services
docker compose --profile cloud down

# Stop and remove volumes (caution: deletes data)
docker compose --profile cloud down -v
```

---

## 문제 해결

### Caddy가 SSL Certificate을 받지 못함

**DNS 확인:**

```bash
dig archon.yourdomain.com
# Should return your server IP
```

**firewall 확인:**

```bash
sudo ufw status
# Should allow ports 80 and 443
```

**Caddy log 확인:**

```bash
docker compose --profile cloud logs caddy
# Look for certificate issuance attempts
```

**흔한 원인:**

- DNS가 아직 전파되지 않음(5-60분 대기)
- firewall이 80/443 port를 차단
- Caddyfile의 domain typo
- A record가 올바른 IP를 가리키지 않음

### App이 응답하지 않음

**실행 중인지 확인:**

```bash
docker compose --profile cloud ps
# Should show 'app' and 'caddy' with state 'Up'
```

**health endpoint 확인:**

```bash
curl http://localhost:3000/api/health
# Tests app directly (bypasses Caddy)
```

**log 확인:**

```bash
docker compose --profile cloud logs -f app
```

### Database connection error

**remote database의 경우:**

```bash
# Test connection from server
psql $DATABASE_URL -c "SELECT 1"
```

**environment variable 확인:**

```bash
cat .env | grep DATABASE_URL
```

**table이 없으면 migration 실행:**

```bash
psql $DATABASE_URL < migrations/000_combined.sql
```

### GitHub Webhook이 동작하지 않음

**webhook delivery 확인:**

1. GitHub의 webhook settings로 이동합니다.
2. "Recent Deliveries"를 클릭합니다.
3. error message를 확인합니다.

**webhook secret 확인:**

```bash
cat .env | grep WEBHOOK_SECRET
# Must match GitHub webhook configuration
```

**webhook endpoint 테스트:**

```bash
curl https://archon.yourdomain.com/webhooks/github
# Should return 400 (missing signature) - means endpoint is reachable
```

### Disk space 부족

**disk usage 확인:**

```bash
df -h
docker system df
```

**Docker 정리:**

```bash
# Remove unused images and containers
docker system prune -a

# Remove unused volumes (caution)
docker volume prune
```
