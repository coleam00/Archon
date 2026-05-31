---
name: ssdf-development
metadata:
  version: "1.0.1"
description: Development-time NIST SP 800-218 (SSDF) evidence collection, SBOM generation, compliance dashboards, and CISA attestation readiness checks. Use during active development to generate and assess compliance evidence from git history and project artifacts. For creating auditor-facing mapping documents and gap analysis, use ssdf-compliance-mapping instead.
---

# SSDF Development Skill

Development-time companion to the `ssdf-compliance-mapping` skill. This skill produces evidence artifacts; the mapping skill produces documentation artifacts. Zero overlap.

## When to Use This Skill

Three layers handle SSDF compliance — most developers never load this skill directly:

| Layer | What | When | Who |
|-------|------|------|-----|
| Core Steering (automatic) | SSDF-tagged commits, security scans, input validation | Every commit — no action needed | All developers |
| This skill (on-demand) | Evidence reports, SBOMs, dashboard, attestation readiness | Periodic during development | Dev leads, compliance officers |
| ssdf-compliance-mapping (separate) | Mapping docs, gap analysis, remediation plans | Periodic post-development | Compliance officers, auditors |

## SDLC Alignment

| Workflow | SDLC Phase | Trigger | Frequency |
|----------|-----------|---------|-----------|
| `generate-sbom` | Release prep, after dependency changes | Dev lead or CI | Per release or monthly |
| `collect-evidence` | Sprint check-in, release prep, pre-attestation | Dev lead or compliance | Weekly to monthly |
| `evidence-dashboard` | Sprint review, compliance check-in | Dev lead or compliance | Bi-weekly to monthly |
| `attestation-check` | Before CISA submission, before audit | Compliance officer | Quarterly or annually |

```
Plan          → (PO family — organizational, outside this skill)
Requirements  → GDIT framework specs (requirements.md, design.md, tasks.md)
Design        → Core steering enforces security-by-design (PW.1)
Implement     → Core steering: every commit gets SSDF tags automatically
Test          → Core steering: test results in commit evidence (PW.8)
Release Prep  → This skill: generate-sbom, collect-evidence, dashboard
Deploy        → git-dev-workflow skill handles MR/PR
Operate       → This skill: periodic evidence-dashboard
Audit/Attest  → This skill: attestation-check
                 ssdf-compliance-mapping: mapping docs, gap closure
```

### Typical Usage

Day-to-day (no skill loading):
```
Write code → agent enforces steering → commit gets SSDF tags
```

Sprint review / release prep:
```
"load ssdf-development skill"
→ generate-sbom → collect-evidence → evidence-dashboard
```

Before attestation:
```
"load ssdf-development skill"
→ attestation-check → if NOT READY: report says what's missing and which skill to use
```

## Workflows

### 1. collect-evidence
Scrape git history for SSDF compliance tags. Produces per-practice evidence report.
```
python3 ~/.kiro/skills/ssdf-development/scripts/collect_evidence.py [--days N] [--output PATH]
```

### 2. generate-sbom
Generate CycloneDX SBOM from project dependencies. Detects tools (syft, cyclonedx-py/npm) with manual fallback.
```
python3 ~/.kiro/skills/ssdf-development/scripts/generate_sbom.py [--project DIR] [--format cyclonedx|spdx] [--output PATH]
```

### 3. evidence-dashboard
Agent-driven workflow (no script). Synthesizes evidence report + steering coverage into a consolidated dashboard at `docs/compliance-by-family/DASHBOARD.md`.

### 4. attestation-check
Validate readiness against CISA attestation form statements.
```
python3 ~/.kiro/skills/ssdf-development/scripts/validate_attestation.py [--project DIR] [--days N] [--output PATH]
```

## ComplianceGraph Integration

When the `--sysml` flag is passed to `collect-evidence` or `attestation-check`, scripts cross-reference commit evidence against `ComplianceGraph` blocks found in `.kiro/specs/*/model.sysml`. This enables four-dimensional coverage analysis:

| Dimension | Source | What It Proves |
|-----------|--------|----------------|
| Graph satisfy | `part X { satisfy requirement Y; }` in ComplianceGraph | A component claims to implement the practice |
| Graph verify | `verification X { verify requirement Y; }` in ComplianceGraph | A test claims to verify the practice |
| Commit evidence | `Compliance:` tags in git history | Development activity generated evidence |
| Artifact existence | SBOM, threat model, mapping docs on disk | Required deliverables are present |

Without `--sysml`, scripts behave identically to before — the flag is optional and all output is backward-compatible.

Corporate policy references (from `doc /* ... | ITSTD5011 §4.1.4 */` strings) are shown for practices with organizational backing.

## References

- `references/SSDF-COMMIT-TAGS.md` — Activity-to-practice mapping for commit tags. Read when writing commits or understanding tag meanings.
- `references/CISA-ATTESTATION-FORM.md` — Attestation statement-to-practice mapping with readiness criteria. Read when assessing attestation readiness.
- `references/SBOM-REQUIREMENTS.md` — Federal SBOM minimum elements, formats, tool detection. Read when generating or validating SBOMs.

## Boundary with ssdf-compliance-mapping

This skill NEVER: creates mapping documents, runs gap analysis, scaffolds compliance artifacts, manages pipeline profiles, or closes gaps.

The mapping skill NEVER: scrapes git history, generates SBOMs, produces evidence reports, or assesses attestation readiness.

Relationship is one-directional: this skill produces richer project artifacts → the mapping skill has better inputs when it runs.

## Prerequisites

This skill requires GDIT-SDAF to be set up. Run once per machine:

```
archon workflow run gdit-sdaf-setup
```

After setup, scripts are available at `~/.kiro/skills/ssdf-development/scripts/`.
