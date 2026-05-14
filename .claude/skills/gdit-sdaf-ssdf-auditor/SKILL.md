---
name: ssdf-auditor
description: Query and report on NIST SP 800-218 (SSDF) compliance evidence from SysML ComplianceGraph models. Use when auditors need to verify compliance, generate coverage matrices, identify gaps, or check CISA attestation readiness.
triggers:
  - audit query
  - compliance report
  - show evidence for
  - attestation readiness
  - coverage matrix
  - ssdf audit
  - compliance query
  - gap report
---

# SSDF Auditor

Provides machine-queryable access to NIST SP 800-218 compliance evidence stored in SysML ComplianceGraph blocks across project specs.

## What This Skill Does

- **Query by practice**: Show all evidence (components, tests, org-policy refs) for a specific SSDF sub-practice
- **Coverage matrix**: Full T1/T2 matrix showing compliance posture at a glance
- **Gap report**: Focused view of practices with missing or incomplete evidence
- **Attestation check**: Cross-reference against CISA attestation form requirements

## How It Works

All scripts read `.kiro/specs/*/model.sysml` files and extract `package ComplianceGraph {}` blocks. The shared `sysml_graph.py` parser (in `~/.kiro/scripts/`) handles parsing; this skill adds the query and reporting layer.

## Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `query_practice.py` | Query single practice | `python3 query_practice.py PW.1.1 --specs-dir .kiro/specs/` |
| `coverage_matrix.py` | Full coverage matrix | `python3 coverage_matrix.py --specs-dir .kiro/specs/` |
| `gap_report.py` | Gaps only | `python3 gap_report.py --specs-dir .kiro/specs/` |
| `attestation_check.py` | CISA readiness | `python3 attestation_check.py --specs-dir .kiro/specs/` |

## Prerequisites

This skill requires GDIT-SDAF to be set up. Run once per machine:

```
archon workflow run gdit-sdaf-setup
```

After setup, scripts are available at `~/.kiro/skills/ssdf-auditor/scripts/`.
