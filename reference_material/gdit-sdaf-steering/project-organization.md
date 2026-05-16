---
inclusion: always
enforcement: mandatory
---

# Project Organization Standards

Reference examples: `~/.kiro/steering/project-organization-reference.md`

## Context

This steering file enforces project-level file organization to maintain clean, scalable project structure. It prevents root directory clutter and ensures consistent file placement across all project types.

## Root Directory Policy

**CRITICAL**: Keep root directory clean - folders and core files only

### Allowed in Root

- README.md
- CHANGELOG.md
- LICENSE
- .gitignore
- CLAUDE.md (AI assistant context/instructions)
- .gitleaks.toml (Gitleaks scanner configuration)
- .release-config.json (Release automation configuration)
- requirements.txt (Python dependencies - if project-level)
- Directories only (no loose files beyond above)

### Prohibited in Root

- ❌ Scripts (use scripts/)
- ❌ Test files (use tests/)
- ❌ Backup files (use git checkpoints instead)
- ❌ Build artifacts (use dist/, build/)
- ❌ Scanner output reports (use temp/)
- ❌ General documentation (use docs/ - except CLAUDE.md)

## File Organization by Type

### Scripts and Automation

**Location**: `scripts/[category]/[script-name]`
**Categories**: `scripts/build/`, `scripts/deploy/`, `scripts/test/`, `scripts/utils/`
**Rules**: ALL scripts in scripts/[category]/, include README.md, make executable, use descriptive names

### Infrastructure as Code

**Location**: `infrastructure/[tool]/`
**Structure**: `infrastructure/cloudformation/`, `infrastructure/sam/`, `infrastructure/cdk/`, `infrastructure/terraform/`, `infrastructure/ansible/`
**Rules**: Numeric prefixes for deployment order (01-, 02-), include validation scripts, keep environment-agnostic

### Configuration Files

**Location**: `config/[environment]/`
**Structure**: `config/dev/`, `config/staging/`, `config/prod/`, `config/templates/`
**Rules**: NEVER in root, use environment subdirectories, sensitive data in Parameter Store/Secrets Manager

### Test Files

**Location**: `tests/[type]/`
**Structure**: `tests/unit/`, `tests/integration/`, `tests/e2e/`, `tests/fixtures/`
**Rules**: ALL tests in tests/[type]/, include README.md, organize by type

### Documentation

**Location**: `docs/[category]/`
**Structure**: `docs/architecture/`, `docs/api/`, `docs/guides/`, `docs/analysis/`

### Architecture Diagrams

**Location**: `docs/architecture/`
**Formats**: `.drawio` (source), `.png`/`.svg` (exported)
**Rules**: ALL architecture diagrams in docs/architecture/, keep .drawio source alongside exported images, use descriptive kebab-case names (e.g., `gdit-sdaf-component-overview.drawio`)

### Temporary Files

**Location**: `temp/`
**Rules**: ALL temporary files in temp/, git-ignored by default

### Git Checkpoints

**Purpose**: Atomic rollback points for AI-managed changes
**Rules**: AI manages automatically, keep local, use git history instead of backup files
**Deprecated**: `backup/` directory approach - use git checkpoints instead

### Build Artifacts

**Location**: `dist/` and `build/`
**Rules**: ALWAYS git-ignored, never commit, clean before fresh builds

## Multi-Service Project Structure

### Service Definition

A service is an independently deployable unit with own lifecycle, bounded context, independent data store, and API contract.

### Feature vs Service Decision

- **Single-Service (src/)**: shared deployment, tight coupling, single team, shared database
- **Multi-Service (services/)**: independent deployment, loose coupling, multiple teams, separate databases

### Repository Strategy

- **Monorepo** (recommended): shared infrastructure/tooling, coordinated releases
- **Multi-Repo**: completely independent teams, different tech stacks

## Service Directory Organization

### Service Root Policy

**Allowed**: README.md, package.json/requirements.txt/pom.xml, tsconfig.json/pyproject.toml, .gitignore
**Prohibited**: docs, tests, configs, build artifacts, temp files, scripts (use project-level directories)

## Validation Questions

Before creating any file:

1. **What type?** Script→scripts/, Config→config/, Test→tests/, Doc→docs/, Temp→temp/, IaC→infrastructure/, Diagram→docs/architecture/
2. **Temporary?** Yes→temp/
3. **Root?** Only README.md, CHANGELOG.md, LICENSE, .gitignore
4. **Build artifact?** Yes→dist/ or build/ (git-ignore)

## Anti-Patterns to Avoid

- ❌ Creating scripts/temp/config/test/doc files in root directory
- ❌ Putting files outside their designated type directories
- ❌ Not using subdirectories within scripts/, tests/, docs/, config/

## Summary

**Keep root clean. Organize by purpose. Use consistent patterns.**
