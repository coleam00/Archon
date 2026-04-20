---
title: 데이터베이스
description: SQLite와 PostgreSQL 백엔드를 위한 데이터베이스 설정, 스키마 개요, 마이그레이션 가이드입니다.
category: reference
area: database
audience: [developer, operator]
status: current
sidebar:
  order: 5
---

Archon은 두 가지 데이터베이스 백엔드를 지원합니다: **SQLite**(기본값, 별도 설정 불필요)와 **PostgreSQL**(선택 사항, 클라우드/고급 배포용). 어떤 백엔드를 사용할지는 `DATABASE_URL` 환경 변수가 설정되어 있는지에 따라 자동으로 결정됩니다.

## SQLite(기본값 - 설정 불필요)

`.env` 파일에서 **`DATABASE_URL` 변수를 생략**하면 됩니다. 앱은 자동으로 다음 작업을 수행합니다.
- `~/.archon/archon.db`에 SQLite 데이터베이스 생성
- 첫 실행 시 스키마 초기화
- 모든 작업에 이 데이터베이스 사용

**장점:**
- 설정이 전혀 필요 없음
- 외부 데이터베이스 불필요
- 단일 사용자 CLI 사용에 적합

**단점:**
- 다중 컨테이너 배포에는 적합하지 않음
- 네트워크 접근 불가(CLI와 서버가 서로 다른 호스트에 있을 때 데이터베이스 공유 불가)

## 원격 PostgreSQL(Supabase, Neon 등)

`.env`에 원격 연결 문자열을 설정합니다.

```ini
DATABASE_URL=postgresql://user:password@host:5432/dbname
```

**새로 설치하는 경우** 통합 마이그레이션을 실행합니다.

```bash
psql $DATABASE_URL < migrations/000_combined.sql
```

**기존 설치를 업데이트하는 경우** 아직 적용하지 않은 마이그레이션만 실행합니다.

```bash
# 이미 실행한 마이그레이션을 확인한 뒤 새 마이그레이션을 적용합니다.
psql $DATABASE_URL < migrations/002_command_templates.sql
psql $DATABASE_URL < migrations/003_add_worktree.sql
psql $DATABASE_URL < migrations/004_worktree_sharing.sql
psql $DATABASE_URL < migrations/005_isolation_abstraction.sql
psql $DATABASE_URL < migrations/006_isolation_environments.sql
psql $DATABASE_URL < migrations/007_drop_legacy_columns.sql
psql $DATABASE_URL < migrations/008_workflow_runs.sql
psql $DATABASE_URL < migrations/009_workflow_last_activity.sql
psql $DATABASE_URL < migrations/010_immutable_sessions.sql
psql $DATABASE_URL < migrations/011_partial_unique_constraint.sql
psql $DATABASE_URL < migrations/012_workflow_events.sql
psql $DATABASE_URL < migrations/013_conversation_titles.sql
psql $DATABASE_URL < migrations/014_message_history.sql
psql $DATABASE_URL < migrations/015_background_dispatch.sql
psql $DATABASE_URL < migrations/016_session_ended_reason.sql
psql $DATABASE_URL < migrations/017_drop_command_templates.sql
psql $DATABASE_URL < migrations/018_fix_workflow_status_default.sql
psql $DATABASE_URL < migrations/019_workflow_resume_path.sql
psql $DATABASE_URL < migrations/020_codebase_env_vars.sql
```

## Docker를 통한 로컬 PostgreSQL

자동 PostgreSQL 설정에는 `with-db` Docker Compose profile을 사용합니다.

`.env`에 다음을 설정합니다.

```ini
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

**새로 설치하는 경우** `docker compose --profile with-db`로 시작하면 데이터베이스 스키마가 자동으로 생성됩니다. 첫 시작 시 통합 마이그레이션이 실행됩니다.

**기존 Docker 설치를 업데이트하는 경우** 새 마이그레이션을 직접 실행해야 합니다.

```bash
# 실행 중인 postgres 컨테이너에 접속합니다.
docker compose exec postgres psql -U postgres -d remote_coding_agent

# 아직 적용하지 않은 마이그레이션을 실행합니다.
\i /migrations/012_workflow_events.sql
\i /migrations/013_conversation_titles.sql
\i /migrations/014_message_history.sql
\i /migrations/015_background_dispatch.sql
\i /migrations/016_session_ended_reason.sql
\i /migrations/017_drop_command_templates.sql
\i /migrations/018_fix_workflow_status_default.sql
\i /migrations/019_workflow_resume_path.sql
\i /migrations/020_codebase_env_vars.sql
\q
```

또는 호스트 머신에서 실행할 수 있습니다(`psql` 설치 필요).

```bash
psql postgresql://postgres:postgres@localhost:5432/remote_coding_agent < migrations/020_codebase_env_vars.sql
# ... 아직 적용하지 않은 각 마이그레이션에 대해 같은 방식으로 실행합니다.
```

## 데이터베이스 확인

**Health check:**
```bash
curl http://localhost:3090/health/db
# Expected: {"status":"ok","database":"connected"}
```

**테이블 목록(PostgreSQL):**
```bash
psql $DATABASE_URL -c "\dt"
```

## 스키마 개요

데이터베이스에는 8개 테이블이 있으며, 모두 `remote_agent_` 접두사를 사용합니다.

1. **`remote_agent_codebases`** - 저장소 메타데이터
   - 명령은 JSONB로 저장: `{command_name: {path, description}}`
   - codebase별 AI assistant 유형
   - 기본 작업 디렉터리

2. **`remote_agent_conversations`** - 플랫폼 conversation 추적
   - 플랫폼 유형 + conversation ID(unique constraint)
   - foreign key로 codebase에 연결
   - 생성 시 AI assistant 유형 고정

3. **`remote_agent_sessions`** - AI session 관리
   - 활성 session 플래그(conversation당 하나)
   - resume 기능을 위한 session ID
   - 명령 컨텍스트용 metadata JSONB

4. **`remote_agent_isolation_environments`** - worktree 격리
   - issue/PR별 git worktree 추적
   - 연결된 issue와 PR 사이에서 worktree 공유 가능

5. **`remote_agent_workflow_runs`** - workflow 실행 추적
   - conversation별 활성 workflow 추적
   - `working_path`별 동시 실행 잠금: 활성 run(status `pending`/`running`/`paused`)이 있는 경로에 두 번째 dispatch가 들어오면 조치 가능한 메시지와 함께 자동 취소됩니다. 5분보다 오래된 `pending` row는 orphan으로 간주해 무시합니다.
   - workflow state, step progress, parent conversation 연결 정보 저장

6. **`remote_agent_workflow_events`** - step 단위 workflow event log
   - workflow run별 step transition, artifact, error 기록
   - UI에 필요한 가벼운 이벤트(상세 verbose log는 JSONL 파일에 저장)
   - workflow run 상세 화면과 디버깅 지원

7. **`remote_agent_messages`** - conversation message history
   - user/assistant 메시지와 timestamp 저장
   - tool call metadata(name, input, duration)를 JSONB로 저장
   - Web UI에서 페이지 새로고침 후에도 message history 제공

8. **`remote_agent_codebase_env_vars`** - workflow 실행용 프로젝트별 env var
   - codebase 범위의 key-value pair
   - 실행 시 Claude SDK subprocess 환경에 주입
   - Web UI Settings panel에서 관리하며, CLI 사용자는 `.archon/config.yaml`의 `env:` 사용

## 마이그레이션 목록

| Migration | 설명 |
|-----------|-------------|
| `000_combined.sql` | 통합 초기 스키마(새 설치에 사용) |
| `001_initial_schema.sql` | 초기 스키마(codebases, conversations, sessions) |
| `002_command_templates.sql` | Command templates table |
| `003_add_worktree.sql` | Worktree column 추가 |
| `004_worktree_sharing.sql` | Worktree sharing 지원 |
| `005_isolation_abstraction.sql` | Isolation abstraction layer |
| `006_isolation_environments.sql` | Isolation environments table |
| `007_drop_legacy_columns.sql` | Legacy worktree column 제거 |
| `008_workflow_runs.sql` | Workflow runs table |
| `009_workflow_last_activity.sql` | Workflow last activity tracking |
| `010_immutable_sessions.sql` | Immutable session model |
| `011_partial_unique_constraint.sql` | Partial unique constraint |
| `012_workflow_events.sql` | Workflow events table |
| `013_conversation_titles.sql` | Conversation titles |
| `014_message_history.sql` | Message history table |
| `015_background_dispatch.sql` | Background dispatch 지원 |
| `016_session_ended_reason.sql` | Session ended reason field |
| `017_drop_command_templates.sql` | Command templates table 제거 |
| `018_fix_workflow_status_default.sql` | Workflow status default value 수정 |
| `019_workflow_resume_path.sql` | Workflow resume path 지원 |
| `020_codebase_env_vars.sql` | 프로젝트별 environment variables |
