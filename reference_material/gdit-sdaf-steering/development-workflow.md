---
inclusion: always
enforcement: mandatory
---

# Development Workflow

Reference examples: `~/.kiro/steering/development-workflow-reference.md`

## Context

This steering file enforces specification-driven development and prevents ad-hoc implementation. All work must follow the requirements → design → tasks pattern with complete traceability.

### Specification Sources

GDIT-SDAF supports two specification sources, configured in `project.yaml` under `workflow.spec-source`:

- **gdit-sdaf** (default): Specifications live in `.kiro/specs/<feature>/` as `requirements.md`, `design.md`, `tasks.md`. Full structural validation via `validate-spec.py`.
- **bmad**: Specifications are authored and maintained as BMAD artifacts (PRD, architecture doc, stories) in `.bmad/docs/` or a user-specified path. GDIT-SDAF reads them directly and maps BMAD concepts to GDIT-SDAF concepts at runtime. `validate-spec.py` is not used. See the `bmad-bridge` skill for mapping details.

When `spec-source: bmad`, all steering rules about "specifications" and "specs" apply to BMAD artifacts. The requirement for specs before implementation is unchanged — only the format and location differ.

## Related Standards

This workflow must be followed in conjunction with:

- **security-compliance.md** - Security scanning and compliance requirements
- **infrastructure-standards.md** - IaC-only infrastructure changes
- **project-organization.md** - File location and organization standards
- **naming-conventions.md** - Resource and code naming standards

## Language Standards

Language-specific standards (version, validation tools, naming, security patterns) are defined in separate `lang-*.md` steering files loaded per agent variant. See `lang-python.md`, `lang-java-springboot.md`, `lang-dotnet.md`, etc.

## Skills Management

### Global Skills Directory

- **Location**: `~/.kiro/skills/` (user home directory, not project-specific)
- **Cache**: `~/.kiro/skills/.skills-cache.txt` (loaded on agent startup)
- **Update Script**: `~/.kiro/skills/update-agent.py` (Python for cross-platform compatibility)
- **Refresh**: Daily automatic refresh, or manual with "reload skills" command
- **Purpose**: Avoid project-specific compliance findings from skills configuration

## PROJECT CONFIGURATION CHECK

Before ANY spec creation or implementation work, the agent MUST verify the project has a configuration file.

### Detection

1. Check if `.kiro/config/project.yaml` exists in the project's local `.kiro/` directory
2. If file EXISTS → read silently, check section completeness (see below), apply settings, continue with requested work
3. If file is MISSING → run initialization flow (see below)

### Section Completeness

When `project.yaml` exists, the agent MUST verify all required top-level sections are present. Compare the file against the default template below. Missing sections and keys are handled in two tiers:

#### Tier 1: Universal Defaults (silent backfill)

These sections have safe defaults regardless of tech stack. Backfill silently — no prompt, no detection needed:

| Section / Key                      | Default                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `workflow.spec-source`             | `gdit-sdaf`                                                                                |
| `workflow.value-tracking`          | `true`                                                                                     |
| `workflow.commit-types`            | `[fix, feat, docs, refactor, test, chore]`                                                 |
| `workflow.audit.*` (all toggles)   | `true` for all except `graphql-schema-validation` (false), `1800` for scan-recency-seconds |
| `security.semgrep.severity-levels` | `[ERROR, WARNING]`                                                                         |
| `security.trivy.severity-levels`   | `[HIGH, CRITICAL]`                                                                         |
| `security.log-retention`           | `application-days: 90`, `security-days: 365`                                               |
| `sysml.enabled`                    | `true`                                                                                     |
| `sysml.scope`                      | `both`                                                                                     |
| `well-architected.enabled`         | `true`                                                                                     |
| `finops.enabled`                   | `true`                                                                                     |
| `design-system.enabled`            | `false`                                                                                    |
| `shared.registry-path`             | `.kiro/registry/shared-registry.yaml`                                                      |

#### Tier 2: Stack-Dependent Defaults (detect then populate)

These sections depend on the project's tech stack. The agent MUST detect the stack before populating:

1. **Scan project root** for stack indicators:
   - Python: `requirements.txt`, `pyproject.toml`, `setup.py`, `Pipfile`, `*.py` in `src/` or root
   - Java: `pom.xml`, `build.gradle`, `*.java` in `src/`
   - JavaScript/TypeScript: `package.json`, `tsconfig.json`
   - Go: `go.mod`
   - Rust: `Cargo.toml`
   - C#/.NET: `*.csproj`, `*.sln`, `*.fsproj`, `global.json`, `*.cs` in `src/`
   - IaC: `*.tf`, `*.yaml`/`*.yml` with `AWSTemplateFormatVersion`, `template.yaml`, `samconfig.toml`
   - Containers: `Dockerfile`, `docker-compose.yml`
   - Frameworks (test/build/app):
     - pytest: `conftest.py`, `pytest.ini`, `pyproject.toml` with `[tool.pytest`, `setup.cfg` with `[tool:pytest]`
     - unittest: `test_*.py` files with `import unittest`
     - jest: `jest.config.*`, `package.json` with `"jest"` key
     - vitest: `vitest.config.*`, `package.json` with `"vitest"` dependency
     - playwright: `playwright.config.*`, `package.json` with `"@playwright/test"` dependency
     - cypress: `cypress.config.*`, `cypress/` directory
     - junit: `pom.xml` with `junit`, `build.gradle` with `junit`
     - go test: `*_test.go` files
     - flask: `requirements.txt` or `pyproject.toml` with `flask`
     - fastapi: `requirements.txt` or `pyproject.toml` with `fastapi`
     - django: `manage.py`, `requirements.txt` or `pyproject.toml` with `django`
     - spring-boot: `pom.xml` with `spring-boot`, `build.gradle` with `spring-boot`
     - react: `package.json` with `"react"` dependency
     - nextjs: `next.config.*`, `package.json` with `"next"` dependency
     - express: `package.json` with `"express"` dependency
     - sam: `template.yaml` with `AWS::Serverless`, `samconfig.toml`
     - cdk: `cdk.json`, `package.json` with `"aws-cdk-lib"` or `requirements.txt` with `aws-cdk-lib`
     - terraform: `*.tf` files, `.terraform/` directory
     - xunit: `*.csproj` with `xunit`, `*.csproj` with `Microsoft.NET.Test.Sdk`
     - nunit: `*.csproj` with `NUnit`
     - mstest: `*.csproj` with `MSTest`
     - aspnet: `*.csproj` with `Microsoft.AspNetCore`, `Program.cs` with `WebApplication`
     - blazor: `*.csproj` with `Microsoft.AspNetCore.Components`

2. **Populate based on detection:**

   | Section                     | Detection                                           | Defaults                                                                                                                    |
   | --------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
   | `workflow.frameworks`       | Test framework markers in project files             | See detection rules below                                                                                                   |
   | `language.python.*`         | Python markers found                                | `min-version: "3.12"`, `linter: ruff`, `type-checker: pyright`                                                              |
   | `language.java.*`           | Java markers found                                  | `version: "21"`, `build-tool: maven`, `base-package: com.organization.service`                                              |
   | `language.dotnet.*`         | .NET markers found                                  | `version: "8.0"`, `build-tool: dotnet`, `analyzer: roslyn`                                                                  |
   | `workflow.frameworks`       | Framework markers found (see scan indicators above) | List of all detected framework identifiers, e.g. `[pytest, flask, sam]`                                                     |
   | `security.enabled-scanners` | Union of detected stacks                            | Only scanners relevant to detected languages and file types                                                                 |
   | `git-remote.*`              | `git remote -v` output                              | `name` from tracking remote, `provider` from URL pattern, `default-branch` from `git symbolic-ref refs/remotes/origin/HEAD` |

   **`workflow.frameworks` detection rules** (check each, add all that match):

   | Framework    | Detection                                                                                                                  |
   | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
   | `pytest`     | `pyproject.toml` contains `[tool.pytest` or `testpaths`, or `conftest.py` exists, or `pytest` in requirements/dependencies |
   | `jest`       | `package.json` contains `"jest"` in dependencies/devDependencies/scripts, or `jest.config.*` exists                        |
   | `playwright` | `playwright.config.*` exists, or `@playwright/test` in package.json dependencies                                           |
   | `junit`      | `pom.xml` contains `junit`, or `build.gradle` contains `junit`                                                             |
   | `vitest`     | `vitest.config.*` exists, or `vitest` in package.json dependencies                                                         |
   | `mocha`      | `mocha` in package.json dependencies, or `.mocharc.*` exists                                                               |
   | `go test`    | `go.mod` exists and `*_test.go` files found                                                                                |
   | `cargo test` | `Cargo.toml` exists and `#[cfg(test)]` or `#[test]` found in `*.rs` files                                                  |

3. **If detection is ambiguous** (e.g., no recognizable markers, or multiple conflicting stacks), **ask the user** rather than guess:

   ```
   Could not auto-detect project tech stack. What languages/frameworks does this project use?
   ```

4. **For monorepos** with multiple stacks (e.g., Python + Java), populate all detected language sections.

#### Backfill Rules

- Do NOT prompt for Tier 1 sections — always backfill silently
- Do NOT overwrite existing values — only add what is missing
- Do NOT reorder or reformat existing content
- After backfilling, report what was added: "Added missing sections to project.yaml: workflow.audit, security, language.python (detected from pyproject.toml)"

### Initialization Flow

When `.kiro/config/project.yaml` is missing:

1. Create `.kiro/config/` directory if it doesn't exist
2. Create `project.yaml` with defaults:

   ```yaml
   # Project-level GDIT-SDAF Framework settings (checked into version control)
   workflow:
     spec-source: gdit-sdaf # gdit-sdaf | bmad
     testing: disable # disable | test-after | test-driven
     frameworks: [] # [jest, pytest, playwright] — all test frameworks used
     value-tracking: true # enable/disable effort tables in tasks.md
     # test-config:         # populated when testing != disable
     #   - scope: default
     #     framework: pytest
     #     directory: tests/
     #     naming: test_{module}.py
     commit-types: [fix, feat, docs, refactor, test, chore]
     audit: # per-check toggles (true = enabled, false = skip)
       git-checkpoint: true
       spec-validation: true
       security-scans: true
       test-execution: true
       value-tracking: true
       language-validation: true
       test-evidence: true
       graphql-schema-validation: false # true if project uses GraphQL
       scan-recency-seconds: 1800 # how recent .scan-manifest.json must be
       # validation-tools:          # override lang-specific tool names checked in evidence
       #   python: [ruff, pyright, semgrep, gitleaks, trivy, py_compile]
       #   java: [spotbugs, pmd, gitleaks, spotless, dependency-check]
       #   dotnet: [dotnet-format, semgrep, gitleaks, trivy, dotnet-build]
       # test-evidence-patterns:    # additional patterns merged with defaults
       #   - behave
       #   - hypothesis

   security:
     enabled-scanners: [gitleaks, semgrep, trivy, checkov, ruff] # agent only runs these
     scanner-file-mapping: # central scanner-to-filetype map (overrides defaults)
       ruff: [.py] # Python linting and code quality
       # gitleaks: ["*"]                # "*" = all files
       # checkov: [.yaml, .yml, .json, .tf, .bicep]
     semgrep:
       severity-levels: [ERROR, WARNING]
     trivy:
       severity-levels: [HIGH, CRITICAL]
     log-retention:
       application-days: 90
       security-days: 365

   language: # overrides defaults from lang-*.md steering files
     # python:
     #   min-version: "3.12"
     #   linter: ruff
     #   type-checker: pyright
     # java:
     #   version: "21"
     #   build-tool: maven
     #   base-package: com.organization.service
     # dotnet:
     #   version: "8.0"
     #   build-tool: dotnet
     #   analyzer: roslyn

   # graphql:                # required when graphql-schema-validation: true
   #   cfn-template: infrastructure/cloudformation/api.yml
   #   service-file: frontend/src/services/graphqlService.js

   sysml:
     enabled: true # true (default) | false
     scope: both # behavioral | compliance | both

   well-architected:
     enabled: true # true (default) | false — design-time WAF assessment + post-IaC cfn-guard WAF rules

   finops:
     enabled: true # true (default) | false — design-time Cost Profile requirement + cost anti-pattern checks

   documentation-impact: # post-audit doc drift detection
     enabled: true
     targets: ['docs/']
     exclude: []

   design-system: # Google Labs DESIGN.md integration
     enabled: false # true | false (default: false — opt-in for UI projects)
     # path: DESIGN.md        # file path relative to project root (overrides resolution order)
     # lint-on-frontend: true # run @google/design.md lint during validation
     # export-format: none    # css-tailwind | json-tailwind | dtcg | none

   ssdf: # SSDF evidence collection and pipeline inheritance
     # pipeline: codepipeline-serverless-v1  # {platform}-{type}-{version} — inherits controls from variant
     # last-evidence-collection:  # ISO 8601 timestamp, updated automatically by audit
     staleness-days: 14 # threshold in days before auto-run triggers (default: 14)

   # git-remote:             # auto-detected; override if needed
   #   name: origin
   #   provider: codecommit  # codecommit | gitlab | github | bitbucket
   #   default-branch: main
   #   credentials:
   #     backend: local      # local | secrets-manager

   shared: # shared component library
     registry-path: .kiro/registry/shared-registry.yaml
   ```

3. **Auto-detect project stack** using Tier 2 detection rules (scan for `requirements.txt`, `pom.xml`, `package.json`, `*.tf`, `Dockerfile`, etc.)
4. **Auto-populate all settings** using detected stack and defaults:
   - `workflow.spec-source`: `gdit-sdaf` (default). Auto-detect `bmad` only if `.bmad/docs/` directory exists.
   - `workflow.testing`: `disable` (default)
   - `workflow.frameworks`: Populate from Tier 2 framework detection (e.g., `[pytest, flask, sam]`). Empty list `[]` if none detected.
   - `language.*`: Populate based on detected stack using lang-\*.md defaults
   - `security.enabled-scanners`: Select scanners relevant to detected file types
   - `workflow.value-tracking`: `true`
   - `sysml`: `enabled: true, scope: both`
   - `well-architected`: `enabled: true`
   - `finops`: `enabled: true`
   - `shared.registry-path`: `.kiro/registry/shared-registry.yaml`. If the registry file does not exist, the agent copies `~/.kiro/config/shared-registry-template.yaml` to `.kiro/registry/shared-registry.yaml`, scans the project to discover shared code, and customizes entries. The registry is always scaffolded — shared code reuse is a core development principle, not an opt-in feature.
5. **Report what was created** — single summary line listing detected stack and key settings:
   ```
   Created .kiro/config/project.yaml — detected: Python (from requirements.txt), IaC (from *.yaml). Scanners: gitleaks, semgrep, trivy, checkov. Testing: disable. Spec source: gdit-sdaf.
   ```
6. **If detection is ambiguous** (no recognizable stack markers at all), create with universal defaults only and note: "No stack detected — language section left empty. Run `reconfigure project` to set manually."
7. Continue with the originally requested work

**No interactive prompts.** All settings use sensible defaults. Users can change any setting later by editing `project.yaml` directly or saying "reconfigure project" (which triggers an interactive flow for the specific setting they want to change).

### When the Agent Asks

- Only when user explicitly requests reconfiguration (e.g., "change testing mode", "reconfigure project")
- Only when stack detection is completely ambiguous (no recognizable markers at all)

### When the Agent Does NOT Ask

- On initial creation of `project.yaml` — always auto-detect and use defaults
- When `project.yaml` already exists and agent reads it normally
- On every session start
- When backfilling missing sections

### Platform Independence

This check has two layers: (1) behavioral rules in this steering file (primary), and (2) the `update-agent.py` agentSpawn script which detects `project.yaml` and outputs a config summary at agent load (reliability layer for kiro-cli). The behavioral rules work when steering files are loaded. The spawn script ensures the agent sees project state even if steering fails to load.

---

## MANDATORY FIRST ACTION - NO EXCEPTIONS

Before ANY implementation task, execute this exact sequence:

0. **PROJECT CONFIG**: Verify `.kiro/config/project.yaml` exists — if missing, run initialization flow above. Read `spec-source` setting.

### When spec-source is `gdit-sdaf` (default):

1. **STOP AND SEARCH**: Execute `grep` with pattern "tasks.md" to find ALL spec directories
2. **MANDATORY READ**: Read EVERY tasks.md file found - NO PARTIAL READING
3. **TASK IDENTIFICATION**: Quote the EXACT task number and full text being implemented
4. **REQUIREMENT MAPPING**: List ALL requirement numbers this task addresses
5. **DESIGN VALIDATION**: Quote relevant design sections that guide implementation
6. **SYSML MODEL** (when `sysml.enabled: true`): Read `model.sysml` in the spec directory. Use behavioral models as implementation guides — state machines define the expected control flow, constraints define invariants the code must enforce, interface contracts define typed inputs/outputs the implementation must match. If `model.sysml` is missing, generate it before proceeding.
7. **USER CONFIRMATION**: Present spec summary and validation status to user — wait for explicit approval before writing code

### When spec-source is `bmad`:

1. **STOP AND SEARCH**: Scan BMAD artifact location (`bmad-path` in project.yaml, default `.bmad/docs/`) for PRD, architecture doc, and stories
2. **MANDATORY READ**: Read ALL BMAD artifacts found — PRD, architecture, stories. NO PARTIAL READING
3. **RUNTIME MAPPING**: Map BMAD artifacts to GDIT-SDAF concepts:
   - PRD user stories → requirements (numbered in document order: first story = REQ-1)
   - PRD acceptance criteria → acceptance criteria (used directly)
   - Architecture sections → design guidance
   - Stories → tasks, story subtasks → task checkboxes
   - Infer traceability from content (story references to PRD sections, architecture references)
4. **TASK IDENTIFICATION**: Quote the EXACT BMAD story being implemented and its mapped task number
5. **REQUIREMENT MAPPING**: List ALL mapped requirement numbers (from PRD user stories) this story addresses
6. **DESIGN VALIDATION**: Quote relevant architecture sections that guide implementation
7. **GAP CHECK**: If BMAD artifacts are missing acceptance criteria, architecture detail, or clear story-to-PRD traceability, flag to user before proceeding
8. **USER CONFIRMATION**: Present mapped spec summary to user — wait for explicit approval before writing code

**FAILURE TO EXECUTE THIS SEQUENCE = IMMEDIATE PROTOCOL VIOLATION**

## REQUIRED RESPONSE FORMAT

Every implementation response MUST start with the SPEC-DRIVEN IMPLEMENTATION PROTOCOL header containing: specification discovery (spec location, task, requirements, design quote) and compliance verification (5 checkboxes).

When `spec-source: bmad`, the protocol header uses BMAD artifact references instead of GDIT-SDAF spec paths. The header must include the source mode (`BMAD direct`) and the runtime-mapped requirement/task numbers.

**MISSING THIS HEADER = AUTOMATIC PROTOCOL VIOLATION**

## Enforcement

### Specification-First Development

When working with any file in the project:

- **Read `spec-templates.md`** before creating or modifying any GDIT-SDAF spec file — it contains the exact patterns enforced by `validate-spec.py` (applies to `spec-source: gdit-sdaf` only)
- **Verify project configuration** exists (`.kiro/config/project.yaml`) before creating or modifying specs — if missing, run initialization flow
- **Auto-validate after spec changes** (`spec-source: gdit-sdaf` only): After creating or modifying any spec file (requirements.md, design.md, or tasks.md), immediately run `python3 ~/.kiro/scripts/validate-spec.py .kiro/specs/<feature>/` — do not wait until implementation to discover spec issues
- **Auto-validate after spec changes** (`spec-source: bmad`): Re-read the modified BMAD artifact and re-run the runtime mapping. Flag any new gaps (missing acceptance criteria, broken story-to-PRD references) to the user
- **User confirmation before implementation**: After spec validation passes (gdit-sdaf) or gap check completes (bmad), present the results to the user and ask for confirmation before proceeding to implementation. The user must explicitly approve the spec before code is written
- **Always check for existing specifications** in `.kiro/specs/` (gdit-sdaf) or BMAD artifact location (bmad) before making changes
- **Create specifications first** for new features — using GDIT-SDAF spec pattern or BMAD artifacts depending on `spec-source`
- **Update specifications** when modifying existing functionality
- **Validate cross-references** between specifications and implementation

### Specification Organization

For project structure:

- **Permanent features**: `.kiro/specs/[feature-name]/` (single-service or cross-service)
- **Multi-service monorepos**: `.kiro/specs/[service-name]-[feature-name]/`
- **One-time tasks**: `.kiro/specs/one-time/[task-name]/` (migrations, refactors, cleanup)
- **Bug fixes**: NEVER create new specs — update existing feature spec with "FIX:" prefix tasks

### SysML v2 Supplemental Modeling

When `sysml.enabled: true` in `project.yaml`, the agent generates a formal SysML v2 model alongside the Markdown specs. The `.sysml` file is NOT a reformatted copy of the Markdown — it adds formal modeling that prose cannot express. The Markdown remains the human-readable source of truth for requirements, design, and tasks. The `.sysml` model adds the machine-parseable formal layer.

#### Anti-Duplication Rule

Every element in `model.sysml` MUST add information that does NOT exist in the Markdown specs. If a SysML construct would merely restate what the Markdown already says, do not include it. The `.sysml` file earns its existence by enabling capabilities the Markdown cannot provide:

- **Formal constraints** that tools can evaluate (not prose descriptions of limits)
- **Behavioral state machines** that model workflow logic (not narrative descriptions of steps)
- **Typed interface contracts** between components (not informal descriptions of data flow)
- **Compliance traceability graphs** that auditors can query programmatically (not tables in Markdown)

#### What to Model (by scope)

**scope: behavioral** — Formal behavioral and structural models:

1. **Behavioral models** (`action def`, `state def`) — Model workflows as state machines with typed transitions. These catch logic errors at the model level. Example: the sync-with-main workflow modeled as states (clean → stashed → fetched → rebased → pushed) with guard conditions and error transitions.

2. **Interface contracts** (`port def`, `attribute`) — Define typed inputs/outputs between components. Example: `load_config()` returns `remote_name : RemoteName` (constrained to not contain `://`), `detect_provider()` accepts `RemoteName` and returns `Provider` enum. Type mismatches are caught by the model.

3. **Formal constraints** (`constraint def`, `assert constraint`) — Express acceptance criteria as checkable assertions. Example: `constraint scannerCount { scanners->size() >= 7 }` instead of prose "runs 8 required scanners". These can be validated against the implementation.

4. **Satisfy/verify relationships** — Link design elements to requirements and test cases to requirements. Unlike the Markdown traceability (which is regex-matched text patterns), these are typed relationships queryable via the SysML v2 API — enabling programmatic analysis of coverage gaps.

**scope: compliance** — NIST/SSDF control mapping:

5. **Compliance requirement definitions** — NIST 800-218 practices and NIST 800-171 controls as `requirement def` elements with formal `satisfy` relationships from implementation components. Creates a machine-queryable compliance graph for audit evidence. All compliance elements go in a dedicated `package ComplianceGraph { }` block at the end of model.sysml with constrained syntax optimized for regex extraction. See `spec-templates.md` for the ComplianceGraph block convention, two-zone structure, and strict doc string format.

**T1/T2 Sub-Practice Classification**: Not all NIST 800-218 sub-practices are code-auditable. The ComplianceGraph MUST model only T1 (Pipeline-Assessable) sub-practices — those that can be evidenced through code, configuration, or pipeline artifacts. T2 (Organization-Deferred) sub-practices are organizational processes (HR training, vendor contracts, management commitment, endpoint hardening, vulnerability disclosure policy) that cannot be satisfied by code-based artifacts. See `~/.kiro/skills/ssdf-compliance-mapping/references/SUB-PRACTICE-TIERS.md` for the authoritative classification.

- **T1 sub-practices**: Model in ComplianceGraph with `requirement def` + `satisfy` when design.md content triggers their catalog keywords
- **T2 sub-practices** (PO.1.3, PO.2.1, PO.2.2, PO.2.3, PO.5.2, RV.1.3, RV.3.4): Do NOT model in ComplianceGraph — these are excluded from compliance validation findings
- **Full T1 coverage**: When generating or updating a ComplianceGraph, cross-reference design.md content against the compliance pattern catalog (`~/.kiro/steering/compliance-pattern-catalog.md`). Every T1 sub-practice whose trigger keywords match design.md text MUST have a corresponding `requirement def` and `satisfy` relationship

**scope: both** — All of the above.

#### When to Generate

- **On spec creation**: After creating requirements.md, design.md, and tasks.md, generate `model.sysml` with behavioral models, interface contracts, and constraints derived from the design
- **On spec update**: When design changes affect workflows, interfaces, or constraints, update the corresponding SysML elements
- **On task completion**: Update `satisfy` relationships to reflect which components now implement which requirements

#### Compliance Cross-Check (Mandatory After model.sysml Generation)

After generating or updating `model.sysml`, the agent MUST cross-check design.md keywords against the ComplianceGraph before running `validate-spec.py`. This prevents advisory findings that require a second edit-validate cycle.

**Steps:**

1. Scan `design.md` for trigger keywords from `~/.kiro/steering/compliance-pattern-catalog.md`
2. For each T1 sub-practice whose keywords match: verify a corresponding `requirement def` and `satisfy` exist in the `ComplianceGraph` block. If missing, add them.
3. For each `satisfy` in the ComplianceGraph: verify the matched sub-practice's trigger keywords appear in `design.md`. If missing, add the relevant keywords to the appropriate design section.
4. Run `validate-spec.py` — it MUST produce zero SysML compliance warnings. If warnings remain, repeat steps 1–3 before proceeding.

**Rationale:** The validator checks keyword-to-ComplianceGraph consistency. Performing this cross-check during authoring eliminates the advisory-then-fix loop that wastes a validation cycle.

#### What NOT to Model

- Do not create `requirement def` elements that merely restate acceptance criteria prose — the Markdown already has that
- Do not model static structure that adds no type or constraint information beyond what the Markdown describes
- Do not duplicate the task list or effort tracking — that's purely a project management concern

#### File Location

```
.kiro/specs/<feature>/model.sysml
```

#### Validation

When `sysml.enabled: true`, `validate-spec.py` adds these checks:

- `model.sysml` exists in the spec directory
- File contains at least one behavioral model (`action def` or `state def`) OR one `constraint def` — proving it adds value beyond the Markdown
- File contains at least one `satisfy` relationship — proving traceability is modeled
- When `scope: compliance` or `both`: file contains compliance-related `requirement def` elements with NIST/SSDF references

#### Template

See `spec-templates.md` for the `model.sysml` template pattern.

### Quality Gates

#### When spec-source is `gdit-sdaf`:

Run `python3 ~/.kiro/scripts/validate-spec.py .kiro/specs/<feature>/` at two points:

1. **After spec creation/modification** — immediately after writing or updating any spec file
2. **Before implementation** — as a gate before writing any code

The validator checks:

- **File completeness**: All three spec files exist (requirements.md, design.md, tasks.md)
- **Requirements quality**: Every `## REQ-N:` section has `**Acceptance Criteria:**`
- **Design verifiability**: design.md has `**Correctness Properties:**` sections and `**Implemented by**: Task N` references
- **Design → Tasks validity**: Task numbers in `**Implemented by**:` lines match actual `### Task N:` headers in tasks.md
- **REQ coverage**: Every REQ-N in requirements.md is referenced by at least one task's `**Addresses**: REQ-N`
- **Design → REQ validity**: REQ-N references in design section headers (`### Section (REQ-N)`) exist in requirements.md
- **REQ → Design coverage**: Every REQ-N is referenced in at least one design section header (advisory)
- **Task → REQ traceability**: Every task has `**Addresses**: REQ-N`
- **Task → Design traceability**: Every task has `**Design**: design.md#section-anchor` and anchors resolve to actual headings
- **Testing readiness**: Test configuration matches project.yaml testing mode
- **Project configuration**: `.kiro/config/project.yaml` exists and testing mode is applied

Use `--all` flag to validate all specs: `python3 ~/.kiro/scripts/validate-spec.py --all`

### Cross-Reference Validation

All specifications must maintain bidirectional traceability using these exact patterns (enforced by `validate-spec.py`):

| Direction             | Pattern                                                       | Severity              |
| --------------------- | ------------------------------------------------------------- | --------------------- |
| Requirements → Tasks  | Every REQ-N has at least one task with `**Addresses**: REQ-N` | FAIL                  |
| Tasks → Requirements  | Every `### Task N:` has `**Addresses**: REQ-N`                | FAIL                  |
| Design → Tasks        | `**Implemented by**: Task N` with valid task numbers          | FAIL on phantom tasks |
| Tasks → Design        | `**Design**: design.md#anchor` resolving to actual heading    | WARN                  |
| Design → Requirements | `### Section (REQ-N)` headers reference valid REQ IDs         | FAIL on invalid       |
| Requirements → Design | Every REQ-N in at least one design `###` header               | WARN                  |

#### When spec-source is `bmad`:

`validate-spec.py` is NOT used. Instead, the agent performs a runtime gap check when reading BMAD artifacts:

| Check                     | What the agent verifies                               | Severity                                |
| ------------------------- | ----------------------------------------------------- | --------------------------------------- |
| PRD completeness          | Every user story has acceptance criteria              | BLOCK — ask user to add via BMAD        |
| Architecture coverage     | Every story references an architecture section        | WARN — flag to user                     |
| Story clarity             | Stories have clear subtasks/definition of done        | WARN — flag to user                     |
| Story-to-PRD traceability | Stories reference PRD user stories by name or section | WARN — agent infers if possible         |
| Architecture detail       | Architecture sections have enough detail to implement | BLOCK — suggest BMAD adversarial review |

BLOCK-level gaps halt implementation until the user addresses them in BMAD. WARN-level gaps are flagged but don't block.

## ABSOLUTE PROHIBITIONS

The agent MUST NEVER:

- Write ANY code without reading complete specifications first (GDIT-SDAF specs or BMAD artifacts, per `spec-source`)
- Make ANY assumptions not explicitly documented in specs or BMAD artifacts
- Take ANY "quick deployment" or "shortcut" or "workaround" approaches
- Create ANY workarounds instead of following spec guidance
- Implement ANY features not defined in tasks.md (gdit-sdaf) or BMAD stories (bmad)
- Skip the mandatory protocol header format
- Proceed without explicit task identification
- Create ANY AWS resources manually (use IaC only)
- Modify infrastructure outside of CloudFormation/CDK/Terraform/SAM - exception is updating Lambda or Layer code

## GIT CHECKPOINT MANAGEMENT

**Purpose**: AI-managed atomic rollback points for safe change management

### When AI Creates Checkpoints

- **After completing each task** (mandatory): stage only current-task files, structured commit with evidence
- **Before high-risk operations**: bulk modifications, destructive changes, complex refactoring, infrastructure changes
- **After validation failures**: preserve working state before attempting fixes

### Checkpoint Commit Format

Type: `fix`, `feat`, `docs`, `refactor`, `test`, `chore`
Format: `[type]: [summary]` + body with `Compliance:` and `Evidence:` fields

**Compliance tag format**: `NIST 800-218 XX.N.N` (sub-practice level, NOT practice level)

- ✅ Correct: `Compliance: NIST 800-218 PW.1.1, PS.3.2`
- ❌ Wrong: `Compliance: NIST 800-218 PW.1` (practice level — too general for evidence collection)
- Multiple sub-practices: comma-separated on one line
- Map each task to the most specific sub-practice(s) it addresses:
  - Security scanning implementation → PW.7.1 (use automated tools), PW.4.1 (review code)
  - IaC security controls → PW.1.1 (design security requirements), PS.1.1 (protect code)
  - Vulnerability management → RV.1.1 (identify vulnerabilities), RV.2.1 (assess vulnerabilities)
  - Testing → PW.8.1 (test executable code), PW.8.2 (determine test adequacy)
  - SBOM generation → PS.3.2 (archive and protect release integrity)
  - Documentation → PO.1.1 (define security requirements)

### Rules

- ✅ AI creates checkpoint after each completed task
- ✅ Keep checkpoints local (don't push until user runs git-dev-workflow)
- ✅ Use git history for rollback (not backup files)
- ✅ Stage only files modified in current task
- ✅ Include validation evidence in commit message
- ✅ Always validate after changes, rollback if validation fails
- ❌ Never skip checkpoint after task completion
- ❌ Never push checkpoints automatically
- ❌ Never create backup files (deprecated - use git instead)
- ❌ Checkpoint is NOT the same as MR/PR (use git-dev-workflow skill for that)

## POST-TASK COMPLETION AUDIT

After completing all subtasks in a task AND creating the git checkpoint, the agent MUST:

1. Run: `python3 ~/.kiro/scripts/audit-steering-compliance.py .kiro/specs/<feature>/`
2. Include the full audit output in the response to the user
3. If any check shows FAIL, remediate the failure before presenting the task as complete
4. Only present the task as complete when audit shows 0 failures

**This audit is mandatory and automatic — the agent runs it without being asked.**

### Automatic Verification on Spec Completion

When the audit script output includes `SPEC COMPLETE` and `ACTION: Run two-layer verification`, the agent MUST immediately:

1. Run `python3 ~/.kiro/scripts/validate-spec.py --verify .kiro/specs/<feature>/` (Layer 1)
2. Perform the semantic verification pass (Layer 2) as defined in the IMPLEMENTATION VERIFICATION section below
3. Generate `.kiro/specs/<feature>/VERIFICATION.md` with Script Results, Criterion Checklist, and Coverage Summary
4. Stage and amend the git checkpoint to include VERIFICATION.md

This is automatic — the agent does not ask the user whether to verify. When all tasks are done and the audit passes, verification happens as part of the same flow.

## POST-AUDIT DOCUMENTATION IMPACT ASSESSMENT

After the steering compliance audit passes (and after verification if triggered), the agent SHOULD assess whether the completed task's changes should trigger documentation updates.

### Configuration

Read from `project.yaml`:

```yaml
documentation-impact:
  enabled: true
  targets: ['docs/']
  exclude: []
```

- `enabled`: Toggle the assessment on/off (default: `true`)
- `targets`: Documentation paths to evaluate against (default: `["docs/"]` when `docs/` exists)
- `exclude`: Paths within targets to skip (e.g., `["docs/compliance-by-family/"]`)

When `enabled` is `false` or the `documentation-impact` section is missing, the agent skips the assessment with: "documentation impact assessment: disabled"

### Assessment Flow

1. Read `documentation-impact` config from `project.yaml`
2. If disabled or missing, skip with note
3. Read the diff of files modified in the current task (`git diff HEAD~1 --name-only`)
4. Filter out files matching `exclude` patterns
5. For each target path, assess: "Do the modified files alter behavior, APIs, workflows, configuration, or user-facing features that would make documentation at this target inaccurate or incomplete?"
6. If impact detected: emit ADVISORY listing specific documentation files/sections that may need updating
7. If no impact: state "no documentation impact detected"

### Rules

- This assessment runs AFTER the audit passes — never before or instead of
- Findings are ADVISORY — they do NOT block task completion
- The assessment does not modify any files — it is read-only
- The evidence is the agent's response itself (visible in conversation)
- The agent checks for impact on: user guides, architecture docs, diagrams, skill docs, README, and any files under `targets`

## TESTING STRATEGY

The testing approach is configured per-project in `.kiro/config/project.yaml` under `workflow.testing`. The agent reads this setting and modifies the workflow accordingly.

### Mode: disable (default)

No automated test generation. Security scans only. The workflow is unchanged:

```
Requirements → Design → Tasks → Implement → Validate (security scans)
```

### Mode: test-after

After implementation and BEFORE git checkpoint, the agent generates and runs tests:

```
Requirements → Design → Tasks → Implement → Tests → Validate
```

Agent behavior:

1. Complete implementation as normal
2. Read acceptance criteria from requirements.md and correctness properties from design.md
3. Generate test file(s) in the project's test directory following project conventions
4. Run the tests
5. Tests MUST pass before git checkpoint is created
6. If tests fail, fix implementation or flag to user — do NOT checkpoint with failing tests
7. Include test results as evidence in checkpoint commit

### Mode: test-driven

After tasks.md is created/reviewed and BEFORE implementation, the agent generates tests:

```
Requirements → Design → Tasks → Tests → Implement → Validate
```

Agent behavior:

1. After tasks.md is created and user has reviewed it
2. Read acceptance criteria from requirements.md and correctness properties from design.md
3. Generate test file(s) that encode acceptance criteria as executable tests
4. Tests are expected to FAIL at this point (no implementation yet)
5. Present tests to user for review
6. Implementation goal: write code that makes the tests pass
7. After implementation, run tests — must pass before git checkpoint
8. Include test results as evidence in checkpoint commit

### Test Derivation

Tests are derived from two existing spec artifacts — no new information needed:

| Source                                                                                 | Produces                                                                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Acceptance criteria (requirements.md or BMAD PRD)                                      | Functional test cases — each criterion becomes one or more test assertions |
| Correctness properties (design.md) or architecture constraints (BMAD architecture doc) | Unit test cases — each property/constraint becomes a direct assertion      |

### Test File Conventions

Test file placement and naming are determined by `workflow.test-config` in `project.yaml`. Each entry is scoped:

| Field       | Purpose                                        | Example                                                                              |
| ----------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `scope`     | Which layer this config applies to             | default, backend, frontend                                                           |
| `framework` | Test framework to use                          | pytest, unittest, jest, junit, vitest, go, playwright, cypress, xunit, nunit, mstest |
| `directory` | Where test files live relative to project root | tests/, tests/e2e/, src/test/java/                                                   |
| `naming`    | Test file naming pattern                       | test\_{module}.py, {feature}.spec.ts                                                 |

Framework-specific conventions (structure, fixtures, patterns) are defined in the language steering files (`lang-python.md`, `lang-java-springboot.md`, `lang-dotnet.md`, etc.).

### Scope Assignment

When generating tests, the agent determines which test-config scope applies:

| Signal                                                                                                           | Scope                               |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| design.md references API endpoints, database, Lambda, services                                                   | backend                             |
| design.md references UI components, pages, user interactions, browser                                            | frontend                            |
| design.md references deployed AWS resources (Lambda ARNs, API endpoints, DynamoDB tables, CloudFormation stacks) | pipeline                            |
| Spec contains explicit `Scope: backend` or `Scope: frontend` tag in requirements.md                              | as tagged                           |
| Only one scope configured (scope: default)                                                                       | default                             |
| Ambiguous                                                                                                        | Agent asks user which scope applies |

Users can add a scope tag to any spec's requirements.md:

```markdown
**Scope**: backend
```

### Test Suite Growth

One test file per spec feature, one test function/method per acceptance criterion.

When `layers` is configured in test-config, tests are organized by layer:

```
tests/
├── conftest.py                          .kiro/specs/
├── unit/                                ├── user-greeting/
│   ├── conftest.py                      │   ├── requirements.md
│   └── test_user_greeting.py   ←        │   └── design.md
├── integration/                         ├── authentication/
│   └── test_auth_with_db.py    ←        └── data-export/
└── e2e/
    └── test_login_flow.py      ←
```

### Layer Placement Rules

| Derivation Source                                                                              | Layer                       | Rationale                                                  |
| ---------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------- |
| Correctness properties (design.md)                                                             | unit                        | Tests isolated functions/modules                           |
| Acceptance criteria referencing multiple modules or services                                   | integration                 | Tests cross-module interactions                            |
| Acceptance criteria describing user-facing behavior                                            | e2e                         | Tests full user workflows                                  |
| Acceptance criteria referencing deployed infrastructure (invoke Lambda, call API, query table) | pipeline                    | Tests require live deployment — run in CI/CD pipeline only |
| Ambiguous                                                                                      | Agent asks user which layer | Fallback                                                   |

When `layers` is not configured, all tests go in the flat `directory` — backward compatible:

```
tests/                           .kiro/specs/
├── conftest.py                  ├── user-greeting/
├── test_user_greeting.py   ←    │   └── requirements.md
├── test_authentication.py  ←    ├── authentication/
└── test_data_export.py     ←    └── data-export/
```

When a spec is updated (new requirements, FIX: tasks), the agent updates the corresponding test file(s) in the appropriate layer(s).

### Test Markers

When layers are configured, every test function/method is tagged with its layer using framework-specific markers. This enables selective execution independent of directory structure. See language steering files for marker syntax per framework.

### Runner Configuration

On first test creation, if no runner configuration file exists, the agent generates one appropriate to the framework (e.g., `pyproject.toml` [tool.pytest.ini_options], `jest.config.js`, Maven surefire plugin). The generated config registers layer markers and sets default options. The agent never overwrites an existing runner config.

### Execution Triggers

Different test layers run at different workflow stages for fast feedback:

| Workflow Stage                                | Tests Run                            | Rationale                                             |
| --------------------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| Per-task checkpoint                           | Unit tests for the current spec      | Fast feedback (seconds)                               |
| Feature completion (all tasks in a spec done) | Unit + integration for the feature   | Verify module interactions                            |
| Pre-push (git-dev-workflow skill)             | Full suite: unit + integration + e2e | Gate before sharing with team                         |
| Pipeline deploy-and-test stage (CodeBuild)    | Pipeline tests only (`-m pipeline`)  | Requires deployed infrastructure — too slow for local |
| On demand (user request)                      | Whatever user specifies              | Flexibility                                           |

When layers are not configured, all tests run at every trigger.

### Selective Execution

Tests can be run at any granularity using standard framework commands — no custom tooling:

- All tests
- By layer (directory or marker)
- By feature/spec name
- Single test file

See language steering files for framework-specific commands.

### Test Evidence in Checkpoints

Test results are included in git checkpoint commits when testing is enabled:

```
feat: implement greeting function (Task 1)

- Create greet.py with greet(name) function
- Handle default "World" when no name provided

Compliance: NIST 800-218 PW.1.1
Evidence: semgrep 0 findings, gitleaks 0 secrets, pytest 3 passed 0 failed
```

### Pipeline Test Requirements

When generating tests with `pipeline` scope, the agent MUST:

- Use `conftest.py` fixtures for stack outputs — never hardcode endpoints, ARNs, or resource names
- Read all configuration from environment variables (set by CodeBuild from stack outputs)
- Tag every test function with `@pytest.mark.pipeline`
- Place tests in `tests/pipeline/` directory (not `tests/unit/` or `tests/integration/`)
- List test dependencies in `requirements-test.txt` (separate from application `requirements.txt`)
- Pipeline tests are NOT run at per-task checkpoint — they run only in the CI/CD deploy-and-test stage

---

## PRE-IMPLEMENTATION CHECKLIST

Before writing ANY code:

- [ ] Verified `.kiro/config/project.yaml` exists and testing mode is known
- [ ] Verified file locations follow project-organization.md standards
- [ ] Executed mandatory spec discovery sequence
- [ ] Read complete tasks.md file(s)
- [ ] Identified exact task being implemented
- [ ] Listed all requirements addressed
- [ ] Quoted relevant design guidance
- [ ] Included mandatory protocol header
- [ ] Confirmed zero assumptions beyond specs
- [ ] If test-driven mode: test files generated and reviewed before implementation

## POST-IMPLEMENTATION VALIDATION

After completing ANY implementation:

- [ ] Git checkpoint commit created with structured message and evidence
- [ ] Security scans completed (as applicable to file types):
  - [ ] Gitleaks (secrets detection - all files)
  - [ ] Semgrep (code security - .py, .js, .ts, .go, .java, .cs files)
  - [ ] Trivy (container/dependency scanning - Dockerfile, package.json, requirements.txt)
  - [ ] cfn-lint (CloudFormation syntax - .yaml, .yml, .json IaC files)
  - [ ] cfn-guard (compliance rules - CloudFormation templates)
  - [ ] cfn-guard-waf (Well-Architected rules - when `well-architected.enabled: true`)
  - [ ] checkov (security scanning - IaC files, policy-as-code)
  - [ ] KICS (IaC security - CloudFormation/Terraform, Lambda unique role enforcement)
  - [ ] Ruff (Python linting and code quality - .py files)
  - [ ] dotnet-format (.NET code formatting - .cs files)
- [ ] If testing mode is `test-after`: tests generated, executed, and passing
- [ ] If testing mode is `test-driven`: tests executed and passing
- [ ] Test execution scope matches trigger: unit only for per-task, unit+integration for feature completion
- [ ] Test results included as evidence in git checkpoint (when testing != disable)
- [ ] Resource names follow naming-conventions.md standards
- [ ] Code references specific task number
- [ ] Implementation matches task description exactly
- [ ] No features added beyond task scope
- [ ] No shortcuts or workarounds created
- [ ] Deployment/changes verified and tested

## VERIFICATION BEFORE COMPLETION

**CRITICAL:** Never claim completion without verification.

### Anti-Documentation Theater

Verification requires evidence, not claims.

**Prohibited**: "Tests passed successfully", "Deployment completed", "All checks passed"
**Required**: Show actual command output with timestamps, pass/fail counts, curl responses, user confirmation

### Verification Requirements

- **Deployments**: Deploy → monitor → wait for completion → check for rollbacks → verify resources → test → THEN claim success
- **Code Changes**: Implement → deploy → run tests → wait for user confirmation → THEN mark complete

**Required Language**: "Deploying... awaiting verification", "Implementation complete, please test [functionality]"

## IMPLEMENTATION VERIFICATION

When the user requests implementation verification (e.g., "verify implementation for X", "verify implementation against spec", "check if X is implemented"), the agent performs a two-layer verification — deterministic script first, then AI semantic analysis — producing a unified report with 100% coverage and zero duplication.

### Step 1: Deterministic Verification (Script)

When `spec-source: gdit-sdaf`, run the validation script with `--verify`:

```
python3 ~/.kiro/scripts/validate-spec.py --verify .kiro/specs/<feature>/
```

When `spec-source: bmad`, skip this step — proceed directly to Step 2. The deterministic checks (file existence, traceability markers) don't apply to BMAD format.

This checks:

- Spec quality gates (traceability, acceptance criteria, correctness properties)
- Task completion status (checkbox parsing)
- Referenced file existence on disk
- Effort tracking completeness
- Compliance tag coverage in git commits

Read and retain the script output. Checks that pass are already verified — do not re-evaluate them.

### Step 2: Semantic Verification (AI)

After the script completes (gdit-sdaf) or directly (bmad), perform the semantic pass on what the script cannot check:

1. Read the spec's requirements.md (acceptance criteria) and design.md (correctness properties) — or for BMAD: read PRD (acceptance criteria) and architecture doc (design decisions)
2. Count the total number of acceptance criteria across all completed REQs (gdit-sdaf) or completed stories (bmad) — this is the target checklist size
3. From completed tasks in tasks.md, identify implementation file paths
4. Read each implementation file
5. For EVERY acceptance criterion of EVERY completed REQ (not ad-hoc spot checks):
   - If the script already verified a structural aspect (file exists, test exists), note it as "script-verified"
   - Otherwise, evaluate whether the code implements the criterion's intent
   - Cite specific file:line evidence
6. For each correctness property:
   - Verify the implementation enforces it in code logic (not just documented)
   - Cite specific file:line evidence
7. Produce per-requirement verdict: **IMPLEMENTED** / **PARTIAL** / **NOT IMPLEMENTED**
   - PARTIAL requires explanation of what is missing
   - All verdicts must cite file:line evidence — no unsupported claims

### Step 3: Unified Report

Write `.kiro/specs/<feature>/VERIFICATION.md` containing:

- **Script Results**: deterministic check output (copied from script)
- **Criterion Checklist**: one row per acceptance criterion across all completed REQs

  | REQ   | Criterion                  | Verified By | Verdict     | Evidence           |
  | ----- | -------------------------- | ----------- | ----------- | ------------------ |
  | REQ-1 | Accepts email and password | AI          | IMPLEMENTED | auth.py:42         |
  | REQ-1 | Returns JWT on success     | AI          | IMPLEMENTED | auth.py:58         |
  | REQ-2 | Test file exists           | Script      | PASS        | tests/test_auth.py |

- **Coverage Summary**: total criteria checked vs total criteria in spec — must match (missing rows = incomplete verification)

### Rules

- The script is ALWAYS run first when `spec-source: gdit-sdaf` — never skip the deterministic pass
- When `spec-source: bmad`, the semantic pass is the primary verification layer
- Every acceptance criterion of every completed REQ/story MUST appear in the checklist — no omissions
- Before writing the report, count checklist rows and compare to total criteria count — if they don't match, the verification is incomplete
- Each criterion is evaluated by exactly one layer — no duplication
- Verdicts without file:line evidence are prohibited
- If the spec has no completed tasks, report "No completed tasks to verify"

## VALUE TRACKING

### Purpose

Quantify AI-assisted development value by comparing traditional human effort against AI-assisted effort. Supports sprint planning, capacity forecasting, and ROI reporting.

### Agent Behavior

- On task start: parse effort table, record start timestamp
- On task completion: record completion timestamp, calculate actuals, update tasks.md, report savings

## Shared Registry

When a project has `.kiro/registry/shared-registry.yaml`:

### Before Creating New Code

- CHECK the registry for existing shared components, utilities, types, or services that cover the need
- READ `contract` fields to determine if existing components cover the need (props, variants, returns)
- READ `rationale` fields to understand when to use vs when NOT to use a component
- If a shared component exists: USE it. Do not create a one-off implementation.
- If a shared component is close but needs extension: EXTEND the shared component and update the registry

### After Modifying Shared Code

- RUN `python3 ~/.kiro/scripts/audit-component-usage.py` to check for consumer breakage
- RUN `python3 ~/.kiro/scripts/audit-component-usage.py --diff` to detect regressions (removed exports, narrowed contracts)
- UPDATE the registry if exports changed (add/remove entries in `exports` list)
- UPDATE `migration-status` if consumers were migrated

### When Adding New Shared Code

- AUTOMATICALLY add the entry to the registry in the same commit — this is mandatory, not optional
- The steering audit BLOCKS if unregistered shared files are detected
- Include: name, path, exports, description, and migration-status
- Add `replaces` patterns if the new component replaces inline implementations
- The AI agent is responsible for registry updates — never leave this for the user to request

### Design System + Registry Coordination

When both `design-system.enabled: true` AND `shared.registry-path` exists:

- **Source of truth separation**: DESIGN.md owns visual identity (colors, typography, spacing, radii). The registry owns component existence, API contracts, and structural reuse. Neither overrides the other.
- **Token flow**: DESIGN.md tokens → framework config (Tailwind, CSS variables) → component implementation. Registry `contract` fields describe component APIs but never specify raw color/spacing values — those come from DESIGN.md via the framework config.
- **Bridge requirement**: A framework config file (e.g., `tailwind.config.js`, CSS custom properties) must map DESIGN.md tokens to consumable values. This is the connector — components reference semantic classes/variables, not raw token values.
- **Agent behavior**: When generating frontend code, check DESIGN.md for visual values AND registry for component existence. Use registry components styled with DESIGN.md tokens. Never hardcode a value that exists as a DESIGN.md token, even if the registry doesn't mention it.

## Design System Integration

**Configuration**: Controlled by `design-system.enabled` in `project.yaml` (default: `false`). When `false`, all design-system behaviors are inactive. This is opt-in for projects with UI components.

**Spec reference**: [Google Labs DESIGN.md](https://github.com/google-labs-code/design.md) — a format specification for describing a visual identity to coding agents using YAML design tokens + markdown rationale.

### Configuration Schema

```yaml
design-system:
  enabled: false # true | false (default: false — opt-in)
  path: DESIGN.md # file path relative to project root (overrides resolution order)
  lint-on-frontend: true # run @google/design.md lint during validation
  export-format: none # css-tailwind | json-tailwind | dtcg | none
```

### DESIGN.md Resolution Order

The agent resolves DESIGN.md using a priority chain. First file found wins (no merging):

1. **project.yaml `design-system.path`** → `<project-root>/<path>` (explicit override)
2. **Local** → `<project-root>/.kiro/config/DESIGN.md` (per-project)
3. **Global** → `~/.kiro/config/DESIGN.md` (cross-project default)

If no file is found at any location and `design-system.enabled: true`, the agent creates a starter DESIGN.md (see "When DESIGN.md is not found" below).

### Pre-Implementation Behavior (Automatic Reading)

When `design-system.enabled: true` and a task involves frontend file extensions (`.jsx`, `.tsx`, `.vue`, `.svelte`, `.css`, `.scss`, `.html`, `.astro`, `.module.css`):

1. Agent resolves DESIGN.md using the resolution order above
2. Agent parses YAML front matter to extract design tokens (colors, typography, spacing, rounded, components)
3. Agent reads markdown body for design rationale
4. During code generation, agent maps token values to CSS variables/utility classes — never hardcodes values that exist as tokens
5. Agent includes token reference comments when mapping is non-obvious

**Token enforcement rules:**

- If DESIGN.md defines `colors.primary: "#1A1C1E"` → agent emits `var(--color-primary)` not `#1A1C1E`
- Typography tokens → CSS custom properties or utility classes
- Spacing tokens → spacing scale variables
- Component tokens → component-level CSS custom properties
- Use DESIGN.md token names exactly as defined — do NOT rename tokens to semantic alternatives (e.g., if DESIGN.md says `colors.red-500`, use `red-500`, don't rename to `danger`). Semantic naming is a DESIGN.md authoring decision, not an agent code-gen decision.

**When DESIGN.md is not found:**

- Create a starter DESIGN.md at `.kiro/config/DESIGN.md` by asking the user for brand values (primary color, font, spacing scale) or scanning existing CSS/Tailwind config for current values
- If user declines or no values are available, create a minimal DESIGN.md with TODO placeholders and proceed
- Do NOT invent token values — use explicit values from user input or existing config only
- When extracting from existing UI: preserve existing color/class names exactly as they are in the codebase. Do NOT rename tokens to semantic alternatives (e.g., if existing code uses `red-500`, the DESIGN.md token is `red-500`, not `danger`). The goal is to document the current visual identity, not refactor it.

### Conversation-Driven Update Detection

The agent monitors conversation for signals that the user is discussing design system changes:

**Explicit signals** (agent proceeds to propose update):

- "update DESIGN.md", "add to design system", "change the brand colors"

**Implicit signals** (agent suggests update, waits for confirmation):

- New color mentions, font changes, spacing adjustments, component pattern discussions, brand updates

**Agent response flow:**

1. Explicit request → show proposed DESIGN.md diff → wait for confirmation → apply
2. Implicit signal → suggest: "This sounds like a design system change. Want me to update DESIGN.md with [proposed change]?"
3. After modification → run `npx @google/design.md lint DESIGN.md` if CLI available (advisory output)

**Prohibitions:**

- Agent NEVER modifies DESIGN.md without explicit user confirmation
- Agent NEVER creates a DESIGN.md when `design-system.enabled` is `false` or absent
- Agent NEVER merges conflicting token values (asks user to resolve)

### Lint Integration

When `lint-on-frontend: true` and the `@google/design.md` CLI is available:

- Agent runs `npx @google/design.md lint DESIGN.md` after DESIGN.md modifications
- Findings are ADVISORY — they do not block implementation
- Lint checks: broken token references, WCAG contrast ratios, structural correctness, section order

### Export Integration

When `export-format` is not `none`:

- Agent can run `npx @google/design.md export --format <format> DESIGN.md` to generate framework-consumable token files
- Export is on-demand (user request or build step), not automatic on every change

## Knowledge Base Usage

The agent has access to indexed knowledge bases that provide semantic and keyword search over project content without loading entire files into context.

### Available Knowledge Bases

Knowledge bases are auto-discovered from project structure based on `project-organization.md` conventions. The `update-agent.py` agentSpawn hook and `knowledge-init.py` script handle discovery and freshness tracking.

Standard discovery candidates (indexed when the directory exists):

| Directory                        | KB Name Pattern                           | Index Type | Use When                                         |
| -------------------------------- | ----------------------------------------- | ---------- | ------------------------------------------------ |
| `.kiro/specs/`                   | `<project>-kiro-specs`                    | Best       | Requirements, design decisions, task status      |
| `src/layers/`                    | `<project>-src-layers`                    | Best       | Shared library/layer utilities                   |
| `src/handlers/`                  | `<project>-src-handlers`                  | Fast       | Handler patterns, event processing               |
| `src/`                           | `<project>-src`                           | Best       | Application source code (when no sub-dirs match) |
| `infrastructure/cloudformation/` | `<project>-infrastructure-cloudformation` | Fast       | Resource names, stack outputs, template patterns |
| `infrastructure/sam/`            | `<project>-infrastructure-sam`            | Fast       | SAM template patterns                            |
| `infrastructure/terraform/`      | `<project>-infrastructure-terraform`      | Fast       | Terraform modules and resources                  |
| `infrastructure/cdk/`            | `<project>-infrastructure-cdk`            | Fast       | CDK stack definitions                            |
| `infrastructure/`                | `<project>-infrastructure`                | Fast       | IaC (when no sub-dirs match)                     |
| `frontend/src/services/`         | `<project>-frontend-src-services`         | Best       | API operations, service layer                    |
| `frontend/src/schemas/`          | `<project>-frontend-src-schemas`          | Best       | Validation schemas, type definitions             |
| `frontend/src/`                  | `<project>-frontend-src`                  | Best       | Frontend source (when no sub-dirs match)         |
| `docs/`                          | `<project>-docs`                          | Best       | Architecture docs, guides, decisions             |
| `.kiro/registry/`                | `<project>-kiro-registry`                 | Fast       | Shared component registry                        |

`<project>` is the project root directory name (e.g., `my-app`, `cardverse-monorepo`).

### When to Search Knowledge (MANDATORY)

Before generating code that references any of the following, the agent MUST search the relevant knowledge base first:

1. **Infrastructure resources** → search `<project>-infrastructure-*`
2. **API operations / service calls** → search `<project>-frontend-src-services` or `<project>-src`
3. **Shared utilities / layers** → search `<project>-src-layers`
4. **Validation schemas** → search `<project>-frontend-src-schemas`
5. **Existing specs** → search `<project>-kiro-specs`
6. **Shared components** → search `<project>-kiro-registry`

### When NOT to Search Knowledge

- Simple file reads where you know the exact path
- Files already in context from a previous read
- Steering rules (already loaded as resources)
- Active work files you're currently editing

### Bootstrap (Session-Start)

On session start, if `knowledge show` returns empty, the agent MUST immediately index the project's core knowledge bases. The `update-agent.py` agentSpawn hook injects specific `knowledge add` commands into the agent context based on auto-discovery. Follow those instructions.

If no bootstrap instructions are present, discover manually:

1. Identify which well-known directories exist in the project root
2. Index the top 3 by priority (specs > src/layers > src > infrastructure > docs)
3. Use naming pattern: `<project-dir-name>-<subdir-slug>`

Knowledge bases persist across sessions once created. Only index what's missing.

### Freshness

- Knowledge bases persist across sessions — no need to re-index every time
- The `knowledge-init.py` script tracks content freshness via git commit hashes
- To force update a stale KB: `knowledge update <path>`
- The script runs automatically on session start (non-blocking, best-effort)

### Active Template Management

Only active files in standard directories are indexed. Archived/legacy content is excluded:

- Files in `archive/` subdirectories are excluded from indexing
- New files added to indexed directories are picked up on next session start
- To retire content from the index, move it to an `archive/` subdirectory
- No whitelist to maintain — the directory structure IS the whitelist

### Configuration

Settings are applied by `knowledge-init.py` on first run:

```
chat.enableKnowledge = true
knowledge.indexType = Best
knowledge.chunkSize = 1024
knowledge.chunkOverlap = 256
knowledge.maxFiles = 10000
```

These are kiro-cli settings (not project-level). The script configures them idempotently.

One-time setup (run once after framework installation):

```bash
python3 ~/.kiro/scripts/knowledge-init.py --configure-only
```

## Success Metrics

- **100% Task Reference Rate**: All implementations quote specific tasks
- **Zero Assumption Rate**: No undocumented assumptions made
- **Complete Requirement Coverage**: All requirements have implementations
- **Perfect Design Fidelity**: All implementations follow design specifications
- **Zero Shortcut Rate**: No quick deployment or workaround patterns

## Accountability

Every code change MUST include:

- **Task Reference**: "Implementing Task [X.Y]: [exact task text]" (gdit-sdaf) or "Implementing Story: [exact story name]" (bmad)
- **Requirement Traceability**: "Addresses Requirements: [list all numbers]" (gdit-sdaf) or "Addresses PRD Stories: [list mapped REQ numbers or story names]" (bmad)
- **Design Compliance**: "Following design approach: [quoted design text]" (gdit-sdaf) or "Following architecture: [quoted architecture section]" (bmad)
- **Assumption Declaration**: "No assumptions made beyond spec documentation"
