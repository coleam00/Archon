# Pipeline Profiles

Pipeline profiles are structured YAML files that describe an SSDF pipeline's security capabilities in enough detail for the skill to map them to NIST 800-218 controls. They live in a shared library (`assets/pipeline-profiles/`) that grows as new variations are needed.

## Naming Convention

```
{platform}-{variant}-{5-digit-guid}.yaml
```

- **platform**: CI/CD system (`codepipeline`, `gitlab-ci`, `github-actions`, `jenkins`, `azure-devops`)
- **variant**: Meaningful differentiator (`full`, `minimal`, `security`, `govcloud`, `no-approval`)
- **guid**: 5-character hex string for uniqueness when profiles are shared across teams

Examples:
- `codepipeline-full-a3f7b.yaml`
- `codepipeline-minimal-d92c1.yaml`
- `gitlab-ci-security-e8b4a.yaml`
- `codepipeline-govcloud-f1c3e.yaml`

Generate a GUID: `python3 -c "import secrets; print(secrets.token_hex(3)[:5])"`

## How It Works

1. **Select**: User picks the profile that matches their pipeline — they know which pipeline serves their project
2. **Context**: AI scans the project ONLY for steering rules (local then global) and existing compliance docs
3. **Accept**: The profile is accepted as-is. Profile modifications happen through `manage-profiles` when the pipeline itself changes.

## What AI Scans in the Project

The profile is the source of truth for pipeline capabilities. AI scans the project only for:

- **Steering rules** — `{project}/.kiro/steering/` (local) then `~/.kiro/steering/` (global)
- **Existing compliance docs** — `docs/compliance-by-family/`

The AI does NOT scan for pipeline IaC, buildspecs, scanner configs, or project feature specs (requirements.md, tasks.md). SSDF mappings document how the pipeline meets NIST controls — the profile contains all pipeline implementation details.

Scanner configurations (tools, rulesets, severity thresholds) come from the pipeline
profile's `security_scanning` section only.

## Library

```
assets/pipeline-profiles/
├── codepipeline-full-a3f7b.yaml       # 9 stages, 6 scanners, ~88%
├── codepipeline-minimal-d92c1.yaml    # 4 stages, 2 scanners, ~48%
├── gitlab-ci-security-e8b4a.yaml      # 4 stages, 4 scanners, ~64%
└── {new-variations}.yaml
```

## Project Reference

The project stores only `docs/compliance-by-family/.profile-id` — a one-line file containing the profile ID (e.g., `codepipeline-full-a3f7b`). The full profile lives in the skill library.

## Profile Structure

- `profile` — ID, name, description, platform, estimated SSDF coverage
- `pipeline_stages` — Each stage with purpose, tools, artifacts, and NIST sub-practice mapping
- `security_scanning` — Tool configurations with exact commands
- `infrastructure` — Encryption, IAM, VPC, logging, secrets management
- `integrity` — Signing, checksums, SBOM, manifests
- `vulnerability_management` — Tracking system, scoring, SLAs
- `processes` — Human processes (code review, design review, training)
- `approval` — Approval gates and notification
- `known_gaps` — Pre-identified NIST gaps for this pipeline pattern
- `existing_docs` / `pipeline_docs` — Pipeline-project documentation (not expected in consumer projects)

## Path Resolution for .kiro/ References

Profiles may reference files under `.kiro/` (steering rules, hooks, configs).
These can live locally in the project or globally in the user's home directory.

Search order:
1. `{project}/.kiro/steering/`, `{project}/.kiro/hooks/`
2. `~/.kiro/steering/`, `~/.kiro/hooks/`

When a file is not found locally, the skill checks global paths as fallback.

In mapping documents, record the actual resolved path (local or global) so
auditors know where the evidence lives.
