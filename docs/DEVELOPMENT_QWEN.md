## Qwen CLI quick usage for Archon

This repository includes a small `.qwen` configuration to standardize developer automation via the Qwen CLI.

Available qwen commands (invoke from repo root):

- `qwen -p "/dev"` — Start hybrid development (backend in Docker, frontend hot reload).
- `qwen -p "/migrate"` — Run SQL migrations using `run_migrations.py` (prefers local psql; falls back to docker exec).
- `qwen -p "/test"` — Run backend (pytest) and frontend (vitest) tests.
- `qwen -p "/lint"` — Run ruff/mypy and frontend linters.
- `qwen -p "/build"` — Build frontend and Docker images.

Notes:
- Do not commit secrets. Configure `SUPABASE_SERVICE_KEY` and other secrets via your environment or CI secrets.
- For Windows, use `scripts\run_migrations.ps1` to run migrations locally.
- Qwen is installed globally in this environment; if not available in CI you can install with `npm install -g @qwen-code/qwen-code`.
