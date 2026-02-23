# Version Control Protocol

## Version File

`python/src/server/config/version.py` — single source of truth for `ARCHON_VERSION`.

## Semantic Versioning: When to Bump

Format: `MAJOR.MINOR.PATCH` (e.g., `0.2.1`)

| Segment | When to bump | Examples |
|---------|-------------|---------|
| **PATCH** `0.0.x` | Bug fix, style tweak, refactor, rename, config change | Fix a broken query · Rename an agent · Update styling · Fix a typo · Update a constant |
| **MINOR** `0.x.0` | New feature, new page, new panel, new API endpoint | Add `/telemetry` page · Add a new Kanban column · Add a new MCP tool · Add a new backend service |
| **MAJOR** `x.0.0` | Architecture overhaul, breaking change, new product identity | Replace polling with WebSockets · Add authentication · New database · Packaged product release |

## Rules

1. **Same commit** — bump the version in the same commit as the change it marks, not after.
2. **Commit message** — include the new version in the message: `feat: add /telemetry page (v0.2.0)` or `chore: bump version to 0.2.1`.
3. **MINOR resets PATCH** — when you bump minor, reset patch to 0. `0.2.3 → 0.3.0`, not `0.3.3`.
4. **MAJOR resets both** — `0.9.5 → 1.0.0`, not `1.9.5`.
5. **Do not bump for** — comments-only changes, documentation updates, test-only changes, `.gitignore` updates.

## Current Version Milestones

| Version | What it marked |
|---------|---------------|
| `0.1.0` | Initial Archon release — Knowledge Base, Projects, Sessions, Agents, Handoffs |
| `0.2.0` | Telemetry Dashboard (`/telemetry`) + all-Claude agent roster |

## Practical Decision Guide

Ask yourself: *"If someone pulled this version, would they notice something new?"*

- **Yes, a whole new page or capability** → MINOR
- **Yes, a bug is fixed or something looks different** → PATCH
- **The system fundamentally works differently or targets a new audience** → MAJOR
- **No, it's internal cleanup only** → no bump needed
