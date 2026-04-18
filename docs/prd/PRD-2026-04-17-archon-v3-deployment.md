# Product Requirements Document: Archon V3 Standup — Parallel Deployment on MS-S1

**Version:** 1.0
**Date:** 2026-04-17
**Author:** Robert + Claude
**Status:** Draft
**Archon Project:** Infra Mgmt (`216be995-1a40-4661-b930-99029b9f80f1`)

---

## Summary

Deploy Archon V3 (`RNWTenor/Archon@feat/archon-v3-deployment`, upstream v0.3.6 — a TypeScript/Bun **YAML workflow engine** for AI coding agents) on MS-S1 as a parallel stack at `/opt/stacks/archon2/`. V1 continues running at `/opt/stacks/archon/` exclusively for external-documentation crawling/RAG; its task-management role is superseded by GitHub. V3 becomes the orchestration layer for the end-to-end development lifecycle (plan → implement → validate → review → PR) driving GitHub as the single source of truth.

---

## Problem Statement

**Current state:**
- V1 Archon (`v1-task-management-rag` branch, `ecaece46`) hosts four overlapping concerns on MS-S1: RAG crawling, task management, document store, MCP tool surface. V1 is frozen — no upstream updates expected.
- Task and decision history lives in V1's Supabase. Acquirer-legible? No. GitHub-legible? No.
- AI coding sessions are ad-hoc: every conversation re-derives the plan/implement/validate/review loop. Nothing enforces the structure.
- The merger story (Vigilant + Cianras → Ima-Mirai, with xLege/Nao inclusion in progress) needs diligence-grade documentation that an acquirer can actually read. Supabase rows fail that test; GitHub issues/PRs/commits pass it.

**Why V3:**
- V3 is a **different product** — a YAML workflow engine, not a task manager. Its role in our architecture is workflow orchestration, not task storage.
- Standing up V3 parallel to V1 lets us move the dev-lifecycle workflow into a durable, GitHub-backed system while V1 keeps crawling documentation.
- Forward-only adoption: new PRDs (like this one), tasks, and decisions flow through GitHub; V3 orchestrates; V1 retains only its crawling role.

**End-state topology (simpler than today):**
```
Today:                                    End-state:
  V1 (tasks+docs+RAG+MCP on Supabase)      V1 (RAG crawling only, frozen)
+ GitHub (code+PRs)                      + GitHub (tasks+docs+code+PRs, authoritative)
+ Hindsight (agent memory)               + V3 (workflow orchestration over GitHub)
+ manual dev-lifecycle context switching + Hindsight (agent memory, unchanged)
```

---

## Design Principles

- **V1 stays untouched.** No V1 data migration. V1's RAG/crawling role is preserved. V1's MCP task tools may still be callable during transition; they get retired when GitHub-based workflows are stable.
- **Parallel, not layered.** Different compose project, different ports, different named volumes, different network, different MetaMCP registration name. Either stack can be torn down without touching the other.
- **Forward-only adoption.** V3 starts empty. No V1 → V3 data migration. This PRD itself is the first artifact to live in V3/GitHub.
- **GitHub is the source of truth.** V3 orchestrates against GitHub; it does not become a second task store. PRDs land in `docs/prd/`, tasks as GitHub Issues, discussions as PRs/comments.
- **Internal-only by default.** Exposed via existing edge Traefik at `archon2.internal.cianras.com`; no Cloudflare tunnel initially. TLS termination stays at edge; V3 serves plain HTTP inside.
- **Diligence-grade documentation.** Every significant change (like this one) produces a PRD with APTDL context, rollback, acceptance criteria.

---

## Scope

| Attribute | Details |
|-----------|---------|
| **Services affected** | NEW: `archon2-app`, `archon2-postgres` on MS-S1. UNCHANGED: V1 Archon stack, Hindsight, LiteLLM, MetaMCP, edge Traefik, dnsmasq. |
| **Hosts affected** | MS-S1 (10.0.10.15) — new stack. hunsn-infra-01 (10.0.10.231) + edge-traefik-01 (10.0.10.31) — edge Traefik route addition. |
| **Risk level** | **Low.** Parallel deployment, V1 untouched, new ports/network/volumes, trivial teardown. |
| **Estimated effort** | Medium (2–4 hours): clone fork onto MS-S1, configure .env, bring up stack, register edge route + DNS, add MetaMCP entry, smoke-test. |

### In Scope
- Clone `RNWTenor/Archon@feat/archon-v3-deployment` to `/opt/stacks/archon2/` on MS-S1 (Dockge manages the stack after).
- Configure `.env` from `.env.example` with minimum required vars (see APTDL → Data below).
- Bring up V3 with `docker compose --profile with-db up -d` (local Postgres, no Caddy, no in-stack auth).
- Add edge Traefik dynamic config entry for `archon2.internal.cianras.com` → `http://10.0.10.15:3000`.
- Add dnsmasq record on hunsn-infra-01 for `archon2.internal.cianras.com` → VIP `10.0.10.40`.
- Register V3 in MetaMCP as a distinct server (name: TBD — `Archon2` or `ArchonV3`).
- Validate: V3 UI reachable, workflow can run, GitHub integration works on one narrow repo (`lab_infrastructure`).
- Commit this PRD plus the deployment bundle to `feat/archon-v3-deployment` branch of the fork; PR when approved.

### Out of Scope
- Decommissioning V1 (stays running for RAG/crawling).
- Migrating V1 Archon tasks to GitHub (separate workstream; tracked elsewhere).
- OpenBao move to cianras-admin-vps (separate Archon task `8650bb8a-…`).
- Backup integration into daily `backup-infra.sh` (separate hygiene task `97c2a6fd-…`); V3 backup added after standup stable.
- GitHub App (vs PAT) — PAT first; GitHub App is a follow-up enhancement.
- Cloudflare Tunnel exposure — internal-only suffices for now.
- Full multi-repo GitHub authorization — start narrow, expand later.
- Claude Code integration testing beyond smoke test — depth of integration is Phase 2.

---

## Files

| File | Change | Deploy Path |
|------|--------|-------------|
| `docs/prd/PRD-2026-04-17-archon-v3-deployment.md` (this file) | NEW | n/a (repo only) |
| `.env.example` | UNCHANGED (use as basis for deployment `.env`) | Source of truth on branch |
| `docker-compose.yml` | UNCHANGED (upstream v0.3.6) | `/opt/stacks/archon2/docker-compose.yml` on MS-S1 |
| `/opt/stacks/archon2/.env` | NEW (on host only; NOT committed) | MS-S1 `/opt/stacks/archon2/.env` |
| `edge/traefik-shared/dynamic/services.yml` (lab_infrastructure repo) | MODIFY (+ `archon2-http`/`archon2-https` router + `archon2` service) | `/opt/stacks/traefik/dynamic/services.yml` on both edge hosts |
| `edge/hunsn/traefik/dnsmasq/cianras.conf` (lab_infrastructure repo) | MODIFY (+ `address=/archon2.internal.cianras.com/10.0.10.40`) | `/etc/dnsmasq.d/cianras.conf` on hunsn-infra-01 |
| MetaMCP server registry (runtime state, not a file) | MODIFY (+ `Archon2` entry) | `cianras-metamcp` container state |

---

## Requirements

### Functional
1. **FR-1:** V3 UI reachable via HTTPS at `https://archon2.internal.cianras.com/` from any host on lab network.
2. **FR-2:** V3 workflow execution succeeds against `RNWTenor/lab_infrastructure` on a trivial test workflow (e.g., planning node only).
3. **FR-3:** V3 Postgres persists data across `docker compose down && up -d` (volume `archon2_postgres_data` survives).
4. **FR-4:** V1 MCP tools in Claude Code remain functional and unchanged throughout and after V3 standup.

### Non-Functional
1. **NFR-1:** V3 standup must not affect V1 Archon container health or MetaMCP availability.
2. **NFR-2:** Port allocation on MS-S1 for V3 must not collide with any existing listener (port 3000 not currently in use; verify at deploy time).
3. **NFR-3:** Secrets (CLAUDE token, GitHub token) never committed to git; read from `/opt/stacks/archon2/.env` which is chmod 600, owned by `fedora`.
4. **NFR-4:** V3 container healthchecks must go green within 60 seconds of startup.
5. **NFR-5:** Rollback from fully-deployed V3 to V3-not-present must complete in under 5 minutes without touching V1.

---

## Implementation Approach

V3's upstream default is **zero-config SQLite** for solo use. For our deployment (merger-grade, multi-user eventually), we start with local Postgres via `--profile with-db`. We **skip** `--profile cloud` (Caddy) because our edge Traefik handles TLS for `*.internal.cianras.com`. We **skip** `--profile auth` because V3 is internal-only behind VLAN/VPN.

### APTDL Dimensional Context

#### Actor (WHO)
- `fedora` (UID 1000) on MS-S1 — owns stack dir, runs `docker compose`, manages .env.
- `docker` daemon on MS-S1 — orchestrates container lifecycle.
- Claude Code (synthetic actor) — primary consumer via MetaMCP registration (Phase 2) and direct workflow invocation.
- Robert (human actor) — workflow initiator via V3 UI and Claude Code sessions.
- V3 `app` container service account (root inside container) — performs git operations via worktrees, invokes `claude`/`codex` CLIs.
- GitHub (synthetic actor) — receives API calls from V3 (issues, PRs, commits, webhooks).

#### Process (HOW)
1. Sync fork: `git fetch upstream && git fetch origin` (done 2026-04-17; `origin/main` === `upstream/main` at `6be5c616` v0.3.6).
2. Create branch: `git checkout -b feat/archon-v3-deployment origin/main` (done 2026-04-17).
3. Commit this PRD to branch (pending approval).
4. On MS-S1 as `fedora`: `git clone -b feat/archon-v3-deployment git@github.com:RNWTenor/Archon.git /opt/stacks/archon2`.
5. `cp .env.example .env`; edit `.env` with secrets from OpenBao (`VAULT_ADDR=http://100.77.247.90:8200 vault kv get ...`). Chmod 600.
6. Set compose project name by creating `/opt/stacks/archon2/.env` entry `COMPOSE_PROJECT_NAME=archon2` (or use `-p archon2` on all commands).
7. `docker compose --profile with-db up -d` — app + postgres, no caddy.
8. Verify containers healthy: `docker compose ps`, `docker logs archon2-app`.
9. Smoke-test locally: `curl -sf http://10.0.10.15:3000/` returns UI.
10. Add edge Traefik route in `lab_infrastructure` repo (`edge/traefik-shared/dynamic/services.yml`) + deploy to both edge hosts.
11. Add dnsmasq record in `lab_infrastructure` repo (`edge/hunsn/traefik/dnsmasq/cianras.conf`) + deploy to hunsn-infra-01; restart dnsmasq.
12. Verify: `curl -sf https://archon2.internal.cianras.com/` returns UI from any lab host.
13. Register V3 in MetaMCP as `Archon2` (distinct from `Archon` V1 entry).
14. Smoke-test workflow: run minimal planning workflow against `lab_infrastructure` on a throwaway branch; verify git-worktree isolation works.
15. Document operational procedures in GitHub issues (update/backup/stop/start).
16. Open PR `feat/archon-v3-deployment` → `main` on the fork with PRD + any deployment-bundle additions (tailored compose overrides if needed post-smoke-test).

#### Technology (WHAT systems)
- **Upstream source**: `https://github.com/coleam00/Archon` at tag `v0.3.6` (`6be5c616`), a TypeScript/Bun YAML workflow engine for AI coding.
- **Fork**: `https://github.com/RNWTenor/Archon`; branches: `main` (in sync), `v1-task-management-rag` (V1 pinned for MS-S1 V1 stack), `myarchon` (WIP/experimental — untouched), `feat/archon-v3-deployment` (this work).
- **Docker compose profiles**: `with-db` (enables local Postgres 17-alpine). NOT using `cloud` (Caddy) or `auth`.
- **Runtime**: Docker + compose on MS-S1 (Fedora 43, AMD64 / Strix Halo Ryzen AI Max, SELinux enforcing).
- **Database**: Postgres 17-alpine, dedicated to V3, volume `archon2_postgres_data`.
- **Reverse proxy**: existing edge Traefik (hunsn-infra-01 + edge-traefik-01, VIP 10.0.10.40) — handles TLS via existing internal CA / Let's Encrypt wildcard.
- **Identity**: no in-stack auth; relies on internal-only exposure via VLAN/VPN.
- **AI CLIs inside container**: `claude` (Claude Code) + optional `codex` — verify at deploy time that the upstream `app` image ships with `claude`; if not, either bind-mount the host's or extend the image (deferred decision).
- **GitHub integration**: PAT (classic, `repo` scope) — GitHub App is a follow-up.

#### Data (WHAT information)
- **V3 app data**: workflow definitions (`.archon/workflows/*.yaml`), workflow run history, conversation history — all in Postgres + optional files under `archon_data` volume.
- **Starts empty** — forward-only adoption, no V1 import.
- **Secrets in `.env`** (not committed, chmod 600, fedora-owned):
  - `DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent`
  - `CLAUDE_USE_GLOBAL_AUTH=true` (verify host `claude` auth is accessible in container; otherwise use `CLAUDE_CODE_OAUTH_TOKEN` from OpenBao)
  - `GH_TOKEN` = GitHub PAT (read from OpenBao `kv-v2/cianras/github/archon-v3-pat` — create this path if missing)
  - `GITHUB_TOKEN` = same as `GH_TOKEN` (V3 adapter looks for both)
  - `WEBHOOK_SECRET` = random 32-char string (generate + store in OpenBao)
  - `DEFAULT_AI_ASSISTANT=claude`
- **NOT populated initially** (future): `SLACK_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`, `GITLAB_TOKEN`.
- **Retention**: Postgres volume persistent across container restarts; data persistence not otherwise managed until daily backup integration (task `97c2a6fd-…`).
- **Sensitivity**: GitHub PAT is medium-sensitivity (scoped to narrow repo set); Claude token is high-sensitivity.

#### Location (WHERE)
- **Source repo**: `https://github.com/RNWTenor/Archon` branch `feat/archon-v3-deployment` → PRD at `docs/prd/PRD-2026-04-17-archon-v3-deployment.md`.
- **Deploy host**: MS-S1 (10.0.10.15), Fedora 43 **AMD64** (Strix Halo / Ryzen AI Max), `/opt/stacks/archon2/`.
- **Compose project name**: `archon2` (isolates containers, network `archon2_archon-network`, volumes `archon2_*` from V1's `archon_*`).
- **Container host ports on MS-S1**: `3000` (V3 app, internal-only bind OK), `127.0.0.1:5432` (postgres — loopback only, no LAN exposure).
- **Network zones**: Infrastructure VLAN (10, 20, 25, 40, 100) accessible via edge Traefik; external access intentionally not configured.
- **DNS**:
  - `archon2.internal.cianras.com` → VIP `10.0.10.40` (via dnsmasq on hunsn-infra-01).
  - Edge Traefik proxies to `10.0.10.15:3000`.
- **Secret storage location**: OpenBao on TrueNAS `100.77.247.90:8200` under `kv-v2/cianras/github/` and `kv-v2/cianras/claude/`.
- **Log location**: MS-S1 `docker logs archon2-app`, `docker logs archon2-postgres`. No external log shipping initially.

### Implementation Order (summary)

1. [this PRD] Commit on `feat/archon-v3-deployment` → open PR → get approval.
2. Create OpenBao entries for GitHub PAT + Claude token + webhook secret.
3. Clone fork on MS-S1, create .env from secrets.
4. `docker compose --profile with-db up -d`.
5. Verify local smoke test (curl port 3000).
6. Add edge Traefik route + dnsmasq entry in `lab_infrastructure` repo, deploy.
7. Verify `https://archon2.internal.cianras.com/` from lab host.
8. Register in MetaMCP as `Archon2`.
9. Smoke-test workflow run against `lab_infrastructure` repo.
10. Post-launch: create GitHub issues for operational runbooks (update, backup, stop/start, troubleshooting).

### Dependencies

- **OpenBao** (on TrueNAS) must be reachable for secret retrieval during `.env` creation.
- **GitHub PAT** must exist with `repo` scope on `RNWTenor/lab_infrastructure` + `RNWTenor/Archon` + `RNWTenor/grc-platform-poc`.
- **Claude Code authentication** on MS-S1 or via explicit token in `.env`.
- **MetaMCP** must be running to accept new server registration.
- **Edge Traefik + dnsmasq** must be in their normal healthy state.

---

## Rollback Plan

V3 has no dependencies on V1 and no shared state. Rollback is complete and fast.

```bash
# On MS-S1 as fedora
cd /opt/stacks/archon2
docker compose --profile with-db down -v      # stops containers, deletes named volumes
cd /
sudo rm -rf /opt/stacks/archon2

# On lab_infrastructure repo — revert/comment edge Traefik + dnsmasq entries, redeploy

# MetaMCP — remove the Archon2 server registration via MetaMCP UI or API

# V1 Archon is unaffected throughout
```

Partial rollback (keep the code, drop the running stack):
```bash
cd /opt/stacks/archon2 && docker compose --profile with-db down
# Leaves stack on disk and the Traefik/dnsmasq entries in place for later restart
```

---

## Acceptance Criteria

1. `curl -sf https://archon2.internal.cianras.com/ | head -20` returns V3 UI HTML (not 404, not 502) from any lab host.
2. `docker inspect archon2-app --format '{{.State.Health.Status}}'` returns `healthy` (or equivalent absence-of-healthcheck check: `docker inspect archon2-app --format '{{.State.Status}}'` returns `running`).
3. `docker inspect archon2-postgres --format '{{.State.Health.Status}}'` returns `healthy`.
4. `docker compose -p archon2 ps` on MS-S1 lists `app` and `postgres` as `running`.
5. V1 Archon unaffected: `curl -sf http://10.0.10.15:8051/health` still returns 200 (MCP healthcheck).
6. MetaMCP has both `Archon` (V1) and `Archon2` (V3) server entries; both report connected.
7. A minimal V3 workflow runs end-to-end against `RNWTenor/lab_infrastructure` (planning node only) and produces a git worktree at `~/.archon/worktrees/` on the container host — no exceptions in logs.
8. No ports conflict: `ss -tlnp` on MS-S1 shows port 3000 bound to `archon2-app` only, 8181/8051/8052/3737 still bound to V1's containers.
9. Secrets not committed: `git diff origin/main --name-only | xargs grep -l 'TOKEN=.\{20,\}'` returns nothing.
10. PRD file committed on `feat/archon-v3-deployment` branch; PR opened against `main`; passes CI (if present).

---

## Deferred Decisions

Tracked explicitly so they don't get lost:

| # | Decision | Default in this PRD | Trigger to revisit |
|---|---|---|---|
| 1 | GitHub App vs PAT | PAT (classic, `repo` scope) | When diligence review flags service-account practice, OR multi-user access needed |
| 2 | Which repos V3 authorized against | Narrow: `lab_infrastructure`, `Archon`, `grc-platform-poc` | When workflow coverage expands to other repos |
| 3 | Claude auth inside container | `CLAUDE_USE_GLOBAL_AUTH=true` pending Dockerfile verification | If verification shows `claude` CLI not in image, switch to `CLAUDE_CODE_OAUTH_TOKEN` |
| 4 | V3 backup integration | Not in this PRD; handled by task `97c2a6fd-…` after standup stable | Standup green for 48h |
| 5 | OpenBao migration to cianras-admin-vps | Not in this PRD; handled by task `8650bb8a-…` | After V3 stable + OpenBao move PRD approved |
| 6 | Cloudflare Tunnel exposure | Not enabled | If V3 needs to be reachable outside the lab (e.g., webhook intake from GitHub cloud) |
| 7 | MetaMCP server name for V3 | `Archon2` | If it conflicts with existing convention or Robert prefers `ArchonV3` |
| 8 | Retirement of V1 MCP task tools | V1 stays live | When GitHub-based workflow is proven sufficient |

---

## References

| Reference | Link/ID |
|-----------|---------|
| **Archon project** | Infra Mgmt (`216be995-1a40-4661-b930-99029b9f80f1`) |
| **Archon task** | TBD — created after PRD approval (pre-impl step 4) |
| **Related tasks** | Backup hygiene `97c2a6fd-c96c-419e-8b41-1eaa5fdeb40a`, OpenBao move `8650bb8a-d607-4d7e-8157-7ce91a8d9a4d` |
| **Upstream repo** | https://github.com/coleam00/Archon (main @ v0.3.6) |
| **Fork** | https://github.com/RNWTenor/Archon |
| **V3 tutorial reference** | `docs_rnwtenor/archon/Your_Own_Archon_v3_Server_in_20_Minutes_VPS_Tutorial_Hand-On.md` (VPS path; we adapt to on-prem) |
| **V1 Archon stack (unaffected)** | `/opt/stacks/archon/` on MS-S1, `v1-task-management-rag` branch, HEAD `ecaece46` |
| **Canonical framework doctrine** | `/home/robert/projects/CIANRAS/claude-project-template/.claude/reference/doctrine/` (APTDL pillar, CIA-AN, UNC) |
| **Pre-backup snapshots** | `/home/fedora/backups/archon-pre-v3-standup-20260418T014726Z/` (229 MB) and `/home/fedora/backups/hindsight-pre-v3-standup-20260418T015648Z/` (15 MB) on MS-S1 |
