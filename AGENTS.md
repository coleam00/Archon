# Repository Guidelines

This guide helps contributors work effectively on the Archon V2 Alpha codebase. The project is local‑only, iterates fast, and favors detailed errors for quick fixes.

## High-Level Overview
- Purpose: Command center for AI coding assistants; exposes an MCP server that powers knowledge, search, and tasks.
- Core features: website crawling and document uploads, semantic RAG search, optional projects/tasks, and live status/progress.
- Architecture: microservices — Frontend (React + TypeScript + Vite + Tailwind), API Server (FastAPI), MCP server (HTTP), Agents service (PydanticAI), and Supabase (PostgreSQL + pgvector).
- UI pages: MCP Dashboard, Settings, Crawl, Knowledge Base, and RAG Chat.
- Run modes: Docker Compose for all services; hybrid dev with local frontend and backend in containers.
- Defaults: UI `3737`, API `8181`, MCP `8051`, Agents `8052`.

## Project Structure & Module Organization
- Frontend: `archon-ui-main/src/`
  - `features/` (preferred): vertical slices, Radix UI, TanStack Query
  - `components/` (legacy), `pages/`, `services/`, `hooks/`, `contexts/`
- Backend: `python/src/`
  - `server/` (FastAPI app, `api_routes/`, `services/`), `mcp/`, `agents/`
- Ports: UI `3737`, API `8181`, MCP `8051`, Agents `8052`

## Build, Test, and Development Commands
- Frontend (from `archon-ui-main/`)
  - `npm run dev` — start Vite dev server (3737)
  - `npm run build` — production build
  - `npm run lint` — ESLint
  - `npm run test` | `npm run test:coverage` — Vitest (+coverage)
- Backend (from `python/`)
  - `uv sync` — install/update deps
  - `uv run python -m src.server.main` — run API locally (8181)
  - `uv run pytest` — run tests (e.g., `tests/test_api_essentials.py`)
- Docker: `docker-compose up --build -d`, `docker-compose logs -f`

## Coding Style & Naming Conventions
- TypeScript/React: Biome in `src/features/**` (2 spaces, 80 cols), ESLint elsewhere. Prefer TanStack Query (no prop drilling). Feature paths: `features/<domain>/<subfeature>/…`.
- State naming: `is[Action]ing`, `[resource]Error`, `selected[Resource]`.
- Python: Ruff (errors/style), 120‑char lines; MyPy for type safety.

## Testing Guidelines
- Frontend: Vitest. Name files `*.test.ts(x)`. Useful cmds: `npm run test:ui`, `npm run test:coverage:stream`.
- Backend: Pytest via `uv run pytest -v`. Add tests under `python/tests/`; keep unit and integration tests separate.

## Error Handling (Alpha)
- Fail fast on startup/config/DB/auth/critical dependency or invalid/corrupt data.
- For batches/background/external APIs: continue, skip failed items entirely, and log with full traceback; never persist placeholder or corrupt data.

## Commit & Pull Request Guidelines
- Commits: concise, imperative (e.g., `feat(ui/projects): add polling hooks`). Reference issues when applicable.
- PRs: clear description, linked issues, screenshots for UI changes, and test notes (what was run and results).

## Configuration & Security
- Required env: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`. Optional: `OPENAI_API_KEY`, `LOGFIRE_TOKEN`, `LOG_LEVEL`.
- Dev tips: UI uses Vite proxy; services communicate via HTTP with polling/ETag caching.
