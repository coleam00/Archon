# Step 08 — Tests and performance benchmarks

Goal
- Verify correctness and quantify performance improvements.

Why
- Ensures measurable impact and guards against regressions.

Scope (isolated)
- Backend and frontend test additions
- Lightweight payload benchmarks

Acceptance criteria
- All new unit/integration tests pass.
- Payload for 50-task list ≤ 25–30 KB after changes.

Test checklist
- Backend unit: list excludes large fields; details endpoint 200/404
- Backend validation: reject >50k descriptions
- Frontend unit: services build correct URLs; hooks respect enabled; modal states
- Integration: edit task flow with lazy details; failure path safe

Benchmarking
- Measure JSON size for 50-task list before/after
- Record loading time with browser devtools and/or scripted fetch

Commands (safe)
- Backend: `uv run ruff check && uv run mypy src/ && uv run pytest -v`
- Frontend: `cd archon-ui-main && npm run test:coverage -w`

Rollback
- Revert individual test changes if flakiness occurs; investigate root cause.

Time estimate
- 45–60 minutes

