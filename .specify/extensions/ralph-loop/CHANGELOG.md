# Changelog

All notable changes to the Ralph Loop extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.1] - 2026-06-05

### Fixed
- Install-time Ralph config placement now targets `.specify/extensions/ralph/ralph-config.yml`, matching the path loaded by the orchestrator scripts.

## [1.1.0] - 2026-06-01

### Added
- Official Codex CLI support via a dedicated `codex exec` invocation path in both Bash and PowerShell orchestrators
- Regression coverage for agent CLI detection and Codex prompt assembly

### Changed
- Documented supported `agent_cli` values and marked Copilot/Codex tool requirements as alternative optional agent CLIs

## [1.0.2] - 2026-05-01

### Changed
- Updated repository references from `Rubiss/spec-kit-ralph` to `Rubiss-Projects/spec-kit-ralph` after the repository transfer
- Updated the README installation example to point at the `v1.0.2` release archive

## [1.0.1] - 2026-04-12

### Added
- Two-workflow release pipeline: `release.yml` (workflow_dispatch) creates a version-bump PR, and `release-publish.yml` creates the tag and GitHub Release when the PR merges — respects branch protection without elevated tokens
- `.github/workflows/tests.yml` — CI workflow running bash tests on Ubuntu and PowerShell tests on Windows for PRs and pushes to main
- Regression test suites: 25 bash tests (`tests/regression/bash/`) and 26 PowerShell tests (`tests/regression/powershell/`)

### Fixed
- `get_incomplete_task_count` in `ralph-loop.sh` returning `"0 0"` instead of `"0"` when no incomplete tasks exist — `grep -c` outputs `"0"` with exit code 1, then `|| echo 0` duplicated it ([#1](https://github.com/Rubiss-Projects/spec-kit-ralph/issues/1))
- Hardcoded `model: Claude Haiku 4.5 (copilot)` in `run.md` frontmatter preventing use with non-Copilot CLIs or setups without Haiku access ([#1](https://github.com/Rubiss-Projects/spec-kit-ralph/issues/1))

## [1.0.0] - 2026-03-08

### Added

#### Extension Manifest
- `extension.yml` — schema v1.0 manifest declaring 2 commands, 1 hook, 1 config template, and tool requirements (copilot, git)

#### Commands
- `speckit.ralph.run` — thin launcher that validates prerequisites, resolves configuration, and launches the platform-appropriate orchestrator script in a visible terminal
- `speckit.ralph.iterate` — single-iteration agent command that completes one work unit from `tasks.md`, commits, and updates `progress.md`

#### Orchestrator Scripts
- `ralph-loop.ps1` — PowerShell orchestrator for Windows with real-time agent output streaming
- `ralph-loop.sh` — Bash orchestrator for macOS/Linux with real-time agent output streaming
- 5-layer configuration precedence: extension defaults → project config → local config → environment variables → CLI parameters
- 3-consecutive-failure circuit breaker
- Graceful Ctrl+C / SIGINT handling (exit code 130)
- Summary block on all 4 termination paths (completed, interrupted, failed, iteration limit)
- Cross-iteration progress tracking via `progress.md`

#### Configuration
- `ralph-config.template.yml` — config template with `model`, `max_iterations`, and `agent_cli` settings
- Environment variable overrides: `SPECKIT_RALPH_MODEL`, `SPECKIT_RALPH_MAX_ITERATIONS`, `SPECKIT_RALPH_AGENT_CLI`

#### Hooks
- `after_tasks` hook for optional post-task-generation loop start

#### Project Files
- `README.md` with installation, usage (agent command + direct script), configuration reference, loop architecture diagram, and extension structure
- `CONTRIBUTING.md` with PR guidelines
- `LICENSE` (MIT)
- `CODEOWNERS` — auto-request review from `@Rubiss`
- `.extensionignore` — excludes `.github/`, `.specify/`, `.vscode/`, and `specs/` from extension packaging
- `.gitignore` for local config and build artifacts

#### Spec Documentation
- Full spec-kit design artifacts under `specs/001-port-ralph-extension/`: spec, plan, research, data model, quickstart, tasks, requirements checklist, and contracts (command schemas, config schema, extension manifest)
