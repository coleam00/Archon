---
name: ssdf-compliance-mapping
metadata:
  version: "1.0.1"
description: Systematic NIST SP 800-218 (SSDF) compliance mapping, gap analysis, and remediation artifact generation for any software project. Use when users need to create per-control-family compliance mappings (PO, PS, PW, RV), analyze gaps against NIST practices, generate gap remediation plans, or scaffold required compliance artifacts (threat models, risk registers, secure coding guidelines, etc.). Covers all 4 SSDF practice groups and 21 practices.
---

# SSDF Compliance Mapping Skill

Systematic workflow for achieving NIST SP 800-218 compliance through per-control-family mapping documents, gap analysis, and remediation artifact generation.

## Overview

NIST SP 800-218 defines 4 practice groups, 21 practices, and 42 sub-practices for secure software development. This skill guides creation of auditor-ready compliance documentation by:

1. Selecting a pipeline profile that captures the pipeline's security capabilities
2. Generating per-family compliance mapping documents
3. Identifying gaps per sub-practice with honest assessments
4. Creating gap remediation plans with prioritized subtasks
5. Scaffolding the artifacts needed to close each gap
6. Validating completeness and consistency of all documentation

## Control Families

| Family | Name | Practices | Sub-Practices |
|--------|------|-----------|---------------|
| PO | Prepare the Organization | PO.1, PO.2, PO.3, PO.4, PO.5 | 13 |
| PS | Protect the Software | PS.1, PS.2, PS.3 | 4 |
| PW | Produce Well-Secured Software | PW.1, PW.2, PW.4, PW.5, PW.6, PW.7, PW.8, PW.9 | 16 |
| RV | Respond to Vulnerabilities | RV.1, RV.2, RV.3 | 9 |

Note: PW.3 was renumbered to PW.4 in SSDF v1.1.

## Pipeline Profiles

The skill needs to know a project's pipeline capabilities to map them to NIST controls. This is solved with a library of pipeline profiles — structured YAML files in `assets/pipeline-profiles/` that describe CI/CD pipeline patterns in enough detail for NIST mapping.

Pre-built profiles:
- `codepipeline-full-a3f7b` — 9 stages, 6 scanners, ~88% coverage
- `codepipeline-full-fc8d7` — 9 stages, 7 scanners (6 SAST + ZAP DAST), ~96% coverage
- `codepipeline-minimal-d92c1` — 4 stages, 2 scanners, ~48% coverage
- `gitlab-ci-security-e8b4a` — 4 stages, 4 scanners, ~64% coverage

Each profile captures stages with NIST mappings, tool configs with exact commands, infrastructure controls, and pre-identified gaps. The library grows as new variations are needed.

**Workflow**: User selects the profile that matches their project's pipeline — they know which pipeline serves their project. The AI scans the project only for project-level context (steering rules, existing compliance docs, spec locations) needed for cross-referencing in mappings. The profile is accepted as-is; profile modifications happen through `manage-profiles` when the pipeline itself changes.

The project stores only a `.profile-id` file in `docs/compliance-by-family/` pointing to the profile in the library. See `references/PIPELINE-PROFILES.md` for details.

## Workflow

### Phase 1: Select & Validate Profile

1. Present available pipeline profiles from the library
2. User selects the profile matching their project's pipeline
3. AI scans the project for context needed in mappings:
   - Steering rules (local vs global path)
   - Existing compliance docs
   - Project spec locations (may differ per project)
4. Write `.profile-id` to `docs/compliance-by-family/`

Profile modifications only happen through `manage-profiles` when the pipeline itself changes — not based on project scanning.

### Phase 2: Map

For each control family, create a mapping document following `references/COMPLIANCE-MAPPING-FORMAT.md`:
1. Load the project's pipeline profile from the library
2. Map profile capabilities to each NIST sub-practice
3. Cross-reference steering rules (local or global) for security context
4. Document evidence with platform-appropriate retrieval commands (see `references/EVIDENCE-PATTERNS.md`)
5. Honestly assess gaps

Output: `docs/compliance-by-family/{FAMILY}-{NAME}.md`

### Phase 3: Gap Analysis

For each family, create a gap remediation plan using `assets/templates/GAP-REMEDIATION.md`:
1. Extract all gaps from the mapping document
2. Classify: risk, type, effort, priority
3. Break into subtasks with recommended content
4. Create prioritized roadmap

Output: `docs/compliance-by-family/{FAMILY}/GAP-REMEDIATION.md`

### Phase 4: Scaffold Artifacts

For each gap requiring a new document, scaffold from `assets/templates/` (24 templates):

**PW family**: THREAT-MODEL, RISK-REGISTER, ARCHITECTURE-DOC, REVIEW-POLICY, SECURE-CODING-GUIDELINES, SECURE-CONFIGURATION-BASELINE, ROOT-CAUSE-ANALYSIS-TEMPLATE, TESTING-STRATEGY
**PO family**: AUDIT-SCHEDULE, MANAGEMENT-COMMITMENT, ROLES-AND-RESPONSIBILITIES, SECURITY-GATE-CRITERIA, THIRD-PARTY-REQUIREMENTS, TOOLCHAIN-CHANGE-POLICY, TRAINING-PLAN
**PS family**: KEY-MANAGEMENT-POLICY
**RV family**: LESSONS-LEARNED, RISK-ASSESSMENT-METHODOLOGY, SECURITY-ADVISORY-TEMPLATE, SECURITY-RESPONSE-PLAYBOOK, VULNERABILITY-CLASS-ERADICATION, VULNERABILITY-DISCLOSURE-POLICY, VULNERABILITY-INTAKE
**Meta**: GAP-REMEDIATION (template for the remediation plan itself)

Cross-family artifacts (referenced by 2+ families) go in `docs/compliance-by-family/SHARED/`:
- RISK-REGISTER.md (PW + PO)
- ROOT-CAUSE-ANALYSIS-TEMPLATE.md (PW + RV)
- LESSONS-LEARNED.md (RV + PW)

Family-specific artifacts go in `docs/compliance-by-family/{FAMILY}/`.

After scaffolding, the workflow updates GAP-REMEDIATION.md to record which gaps now have artifacts (`📄 Scaffolded`). This is informational — scaffolding does not close gaps.

### Phase 4b: Close Gaps

When a gap has been genuinely remediated (artifact completed, process implemented, profile updated), use the `close-gap` workflow to:

1. Verify evidence that the gap is actually closed (no security theater)
2. Update GAP-REMEDIATION.md — mark gap as `✅ Remediated` with closure date and evidence
3. Update the mapping document — change sub-practice status (❌→⚠️ or ⚠️→✅ or ❌→✅) and recalculate coverage percentages

This is the ONLY workflow that changes compliance status in mapping documents. The status flow is:
```
scaffold-artifacts: creates template → GAP-REMEDIATION gets "📄 Scaffolded" annotation
(user fills in artifact, implements process, etc.)
close-gap: verifies evidence → GAP-REMEDIATION gets "✅ Remediated" → mapping doc status updated
```

### Phase 5: Validate

Run `scripts/validate_compliance.py` to verify:
- Profile ID file exists and references a valid profile
- Every NIST sub-practice has a mapping entry
- Every gap has a remediation entry
- Referenced artifacts exist on disk
- Coverage percentages match status counts

### Phase 6: Update (Delta)

When the project changes (new tool, closed gap, new stage):
1. Determine if the change requires a new profile variation or just a mapping update
2. If profile change needed: create new variation in library, update `.profile-id`
3. Update only the affected mapping doc sections
4. Update the affected GAP-REMEDIATION.md
5. Re-run validation

## Key Rules

1. **PDF is source of truth**: All practice definitions come from `references/NIST.SP.800-218.pdf` Table 1. Every sub-practice in the PDF must appear in the mapping — no additions, no omissions. Paraphrase — never reproduce more than 30 consecutive words.
2. **PDF verification required**: Before generating any mapping, read the PDF to extract the exact sub-practice IDs and descriptions for the target family. Cross-check against `references/NIST-800-218-PRACTICES.md` — if any discrepancy, the PDF wins.
3. **Sub-practice tiering**: Read `references/SUB-PRACTICE-TIERS.md` before mapping. T1 (Pipeline-Assessable) sub-practices get full mapping treatment. T2 (Organization-Deferred) sub-practices get an abbreviated section citing org standards as evidence, marked `🏢 Organization-Deferred`. T2 sub-practices do NOT generate pipeline gaps or remediation tasks.
4. **Profile drives mapping**: The profile describes the pipeline — an external shared infrastructure. Projects are consumers. All pipeline capabilities come from the profile, not from scanning the project. Do not look for pipeline IaC, buildspecs, or scanner configs in the project.
4. **NEVER fabricate or infer capabilities**: If a tool, service, endpoint, or capability is not explicitly listed in the profile, it DOES NOT EXIST. Do not infer capabilities from context (e.g., do not assume API Gateway exists because Lambda functions exist). Do not invent services, URLs, endpoints, or architecture components. Every claim in a mapping or artifact must trace to a specific field in the profile YAML. If you cannot point to the profile field, do not include it.
5. **Cross-reference steering rules**: Steering rules (local or global) provide additional security context for mappings. Project feature specs (requirements.md, tasks.md) are NOT relevant — SSDF mappings are about the pipeline, and the profile contains all pipeline details.
6. **Cross-reference organization standards**: Read `references/ORG-STANDARDS-SSDF-CROSSWALK.md` to cite org policies, standards, and handbook controls that support each sub-practice. This provides auditors with dual evidence: pipeline implementation (from profile) AND organizational policy backing.
7. **Cross-reference everything**: Every sub-practice maps to specific pipeline stages, tools, and evidence from the profile.
7. **Honest gaps**: If a control is not implemented, say so. State what would be needed.
8. **Auditor-ready**: Content must directly answer "show me how you meet this" with evidence and commands.
9. **No security theater**: Require concrete evidence, not claims. No fabricated evidence.
10. **Artifacts in family subfolder**: Family-specific artifacts go in `docs/compliance-by-family/{FAMILY}/`. Cross-family artifacts (referenced by 2+ families) go in `docs/compliance-by-family/SHARED/`.
11. **Platform-aware evidence**: Use evidence patterns from `references/EVIDENCE-PATTERNS.md` matching the project's CI platform.
12. **100% implemented families still get gap docs**: Even if all sub-practices are ✅ Implemented, create a GAP-REMEDIATION.md for improvement items noted in the mapping.

## SysML ComplianceGraph Integration

When `sysml.enabled: true` in `project.yaml` and `model.sysml` files contain `package ComplianceGraph { }` blocks, the skill reads satisfy/verify relationships and corporate policy references directly from requirement def doc strings. This provides a structured, machine-parseable evidence layer on top of the pipeline profile.

**How it works:**
- `create-family-mapping` scans `.kiro/specs/*/model.sysml` for ComplianceGraph blocks targeting the requested family's practices. Satisfy relationships build a component-to-practice map. Corporate policy references come directly from doc strings (no catalog lookup needed). Results appear as a "SysML Graph Evidence" subsection in each sub-practice mapping.
- `analyze-gaps` classifies gaps into three tiers when ComplianceGraph data is available: Implementation gap (no satisfy), Test gap (satisfy but no verify), Evidence gap (satisfy + verify but no commit evidence).
- `validate-docs` checks that practices marked ✅ Implemented have at least one satisfy relationship in a ComplianceGraph block.

**Graceful degradation:** When no ComplianceGraph blocks exist, the skill falls back to current behavior — pipeline profile + steering file inference. All existing functionality is unchanged.

## Status Icons

| Icon | Meaning | Criteria |
|------|---------|----------|
| ✅ | Implemented | Directly addresses the NIST sub-practice with evidence |
| ⚠️ | Partial | Addresses some but not all aspects |
| ❌ | Not Implemented | Does not address the sub-practice |
| 🏢 | Organization-Deferred | Sub-practice is an organizational process outside pipeline scope; satisfied by org standards |

## Prerequisites

This skill requires GDIT-SDAF to be set up. Run once per machine:

```
archon workflow run gdit-sdaf-setup
```

After setup, scripts are available at `~/.kiro/skills/ssdf-compliance-mapping/scripts/`.
