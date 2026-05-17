---
description: PIV loop — run the project's full validation suite and report health.
argument-hint: (no arguments — auto-detects the project's tooling)
---

# PIV Validate: Verify the Implementation

**Workflow ID**: $WORKFLOW_ID

Run comprehensive validation of the project and report overall health. This workflow is
toolchain-agnostic — **detect** how this project validates itself; do not assume a stack.

---

## Phase 1: DETECT THE TOOLCHAIN

Inspect the repo to find the real validation commands. Check, in order:

1. **A project validation entry point** — a `validate` script in `package.json`, a
   `Makefile` target, a `justfile` recipe, `noxfile.py`, `tox.ini`, or a `CLAUDE.md` /
   `CONTRIBUTING.md` section documenting how to validate. If one exists, prefer it.
2. **Otherwise, detect per-tool from manifest files:**
   - `package.json` → JS/TS. Look for `test`, `lint`, `type-check`/`typecheck`, `build`,
     `format`/`format:check` scripts. Use the repo's package manager (`bun`/`pnpm`/`yarn`/
     `npm`, inferred from the lockfile).
   - `pyproject.toml` / `setup.cfg` → Python. Detect `pytest`, `mypy`/`pyright`, `ruff`/
     `flake8`, run via `uv run` / `poetry run` / plain, matching the project.
   - `Cargo.toml` → Rust. `cargo test`, `cargo clippy`, `cargo fmt --check`.
   - `go.mod` → Go. `go test ./...`, `go vet ./...`, `gofmt -l`.
   - Other manifests → use the ecosystem's standard test/lint/type/build commands.

Only run commands that actually exist in this repo. Skip a category cleanly if the project
has no such tooling — record it as "not configured", not as a failure.

### PHASE_1_CHECKPOINT
- [ ] Validation commands for this specific project identified
- [ ] Categories with no tooling marked "not configured"

## Phase 2: RUN VALIDATION

Run, in sequence, recording the full result of each:

1. **Tests** — the project's test command
2. **Type checking** — the project's type checker (if any)
3. **Linting** — the project's linter (if any)
4. **Build / smoke check** — the build command, or a live-server smoke test if the project
   is a service (start it, hit a health endpoint, stop it)

For every failure, record the file path and the exact error message.

### PHASE_2_CHECKPOINT
- [ ] Test results recorded
- [ ] Type-check results recorded
- [ ] Lint results recorded
- [ ] Build / smoke result recorded

## Phase 3: GENERATE THE VALIDATION REPORT

Write `$ARTIFACTS_DIR/validation.md`:

```markdown
# Validation Report

| Check | Status | Detail |
|-------|--------|--------|
| Tests | PASS / FAIL / not configured | X passed, Y failed |
| Type check | PASS / FAIL / not configured | [errors] |
| Lint | PASS / FAIL / not configured | [warnings] |
| Build / smoke | PASS / FAIL / not configured | [detail] |

## Failures
[For each failure: file path, error message, likely cause — or "None"]

## Overall: PASS / FAIL
```

### PHASE_3_CHECKPOINT
- [ ] `$ARTIFACTS_DIR/validation.md` written
- [ ] Overall PASS/FAIL stated

## Phase 4: REPORT

Summarize the validation results and the overall health verdict. If anything failed, list
the specific failures so the code-review and fix phases can address them.
