# Spec: NIST 800-218 Per-Control-Family Compliance Mapping Format

**Purpose**: Define the standard format for NIST SP 800-218 compliance mapping documents, one per control family. Use this spec when creating or updating any docs/compliance-by-family mapping document.

**Source of Truth**: `references/NIST.SP.800-218.pdf` (SSDF v1.1, February 2022)
**Cross-Reference Sources**: Pipeline profile, steering rules (local or global), organization standards (via `references/ORG-STANDARDS-SSDF-CROSSWALK.md`)

---

## Control Families

| Family | File | Practices |
|--------|------|-----------|
| PO — Prepare the Organization | `PO-PREPARE-ORGANIZATION.md` | PO.1, PO.2, PO.3, PO.4, PO.5 |
| PS — Protect the Software | `PS-PROTECT-SOFTWARE.md` | PS.1, PS.2, PS.3 |
| PW — Produce Well-Secured Software | `PW-PRODUCE-WELL-SECURED-SOFTWARE.md` | PW.1, PW.2, PW.4, PW.5, PW.6, PW.7, PW.8, PW.9 |
| RV — Respond to Vulnerabilities | `RV-RESPOND-VULNERABILITIES.md` | RV.1, RV.2, RV.3 |

Note: PW.3 was moved to PW.4 in SSDF v1.1.

## Directory Structure

```
docs/compliance-by-family/
├── .profile-id                          # Active pipeline profile ID
├── PO-PREPARE-ORGANIZATION.md           # PO family mapping
├── PS-PROTECT-SOFTWARE.md               # PS family mapping
├── PW-PRODUCE-WELL-SECURED-SOFTWARE.md  # PW family mapping
├── RV-RESPOND-VULNERABILITIES.md        # RV family mapping
├── PO/                                  # PO gap remediation + PO-specific artifacts
├── PS/                                  # PS gap remediation + PS-specific artifacts
├── PW/                                  # PW gap remediation + PW-specific artifacts
├── RV/                                  # RV gap remediation + RV-specific artifacts
└── SHARED/                              # Cross-family artifacts (referenced by 2+ families)
```

Shared artifacts are those referenced by multiple families in their mappings or gap
remediation plans. Examples: RISK-REGISTER.md (PW + PO), ROOT-CAUSE-ANALYSIS-TEMPLATE.md
(PW + RV), LESSONS-LEARNED.md (RV + PW). Reference them as `SHARED/{artifact}.md` in
all documents.

---

## Requirements

1. **PDF is source of truth**: Every sub-task definition and notional example MUST come from `references/NIST.SP.800-218.pdf` Table 1. Before generating any mapping, read the PDF to extract the exact sub-practice IDs and descriptions for the target family. Every sub-practice in the PDF must appear — no additions, no omissions. Paraphrase to stay under 30 consecutive words from the source.

2. **Check sub-practice tier**: Read `references/SUB-PRACTICE-TIERS.md` to determine each sub-practice's tier before mapping:
   - **T1 (Pipeline-Assessable)**: Full mapping treatment — implementation details, evidence, validation, gap assessment.
   - **T2 (Organization-Deferred)**: Abbreviated section — paraphrase the NIST definition, state "This sub-practice is an organizational process outside the scope of pipeline technical assessment", cite the org standards crosswalk entries as organizational evidence, and mark status as `🏢 Organization-Deferred`. Do NOT generate pipeline gaps or remediation tasks for T2 sub-practices.

3. **Map from profile** (T1 only): For each T1 sub-task, use the pipeline profile's `pipeline_stages[].nist_mapping` AND `pipeline_stages[].artifacts` to identify which stages implement the control. The `nist_mapping` field shows direct sub-practice mappings. The `artifacts` field shows what evidence each stage produces, including which tool creates each artifact. When documenting pipeline implementation, build a table with columns for **Stage**, **Tool**, and **Artifact** so auditors can trace each artifact to the specific tool that creates it. Every claim in the Pipeline Implementation section must trace to a specific stage number, tool, and artifact from the profile.

4. **Cross-reference steering rules** (T1 only): Check for steering rules (local then global) that provide security context (e.g., secure coding standards, infrastructure requirements).

5. **Cross-reference organization standards**: Read `references/ORG-STANDARDS-SSDF-CROSSWALK.md` to identify which org policies, standards, and handbook controls support each sub-practice. For T1 sub-practices, add an "Organization Standards Alignment" section. For T2 sub-practices, the org standards crosswalk IS the primary evidence.

4. **Auditor-ready content**: An auditor will read each sub-task as defined by the PDF and ask "show me how you meet this control." The content must directly answer that question with specific evidence, commands, and file references.

5. **Honest gap reporting**: If a control is not implemented or only partially implemented, say so clearly. State what would be needed to fully implement it.

6. **Coverage summary table**: Each file ends with a summary table showing status per sub-practice.

---

## Document Template

```markdown
# NIST SP 800-218 Compliance Mapping: {FAMILY_CODE} — {Family Name}

**Protocol**: SSDF-RELEASE-PIPELINE-{FAMILY_CODE}-MAPPING
**Version**: {version}
**Created**: {date}
**Source of Truth**: NIST SP 800-218 v1.1 (February 2022)
**Pipeline Profile**: `{profile_id}`

---

## Practice: {CODE} — {Practice Name}

**NIST Definition**: {Paraphrased practice-level description from PDF Table 1, column 1}

---

### {CODE}.{TASK}: {Full task description from PDF Table 1, column 2}

**NIST Notional Examples** (summarized):
1. {Summarized example 1 from PDF Table 1, column 3}
2. {Summarized example 2}
...

**Pipeline Implementation**:

{Describe HOW the pipeline implements this sub-task. Be specific:}
- Reference specific pipeline stages (Stage 0-8)
- Build a table with Stage | Tool | Artifact columns using the profile's structured artifact data
- Include tool commands with exact flags/arguments
- For NOT IMPLEMENTED controls, use: ❌ NOT IMPLEMENTED and explain what would be needed

**Cross-References**:
- Steering: `{path}` — {Brief description}
- Profile: `{field}` — {Brief description}

**Organization Standards Alignment**:
- {Document ID} §{Section}: {Brief description of how org standard supports this sub-practice}

**Evidence**:
- {Artifact name} — {Description}
  ```bash
  {Command to retrieve or verify the artifact}
  ```

**Validation**:
```bash
# {Description of what this validates}
{aws cli or shell command}
```

**Gaps**: {Honest assessment of what's missing or incomplete. "None" if fully implemented.}

---

{For T2 (Organization-Deferred) sub-practices, use this abbreviated format instead:}

### {CODE}.{TASK}: {Full task description}

🏢 **Organization-Deferred** — This sub-practice is an organizational process outside the scope of pipeline technical assessment.

**NIST Definition**: {Brief paraphrase}

**Organization Standards Evidence**:
- {Document ID} §{Section}: {How org standard satisfies this sub-practice}

**Status**: 🏢 Organization-Deferred

---

{Repeat for each sub-task in the practice}

{Repeat for each practice in the family}

## Coverage Summary — {FAMILY_CODE} Control Family

| Sub-Practice | Tier | Status | Coverage |
|-------------|------|--------|----------|
| {CODE}.{TASK} | T1 | ✅ Implemented / ⚠️ Partial / ❌ Not Implemented | {Brief description} |
| {CODE}.{TASK} | T2 | 🏢 Organization-Deferred | {Org process description} |

### T1 (Pipeline-Assessable) — X sub-practices
**Implemented**: X of Y (Z%)
**Partial**: X of Y (Z%)
**Not Implemented**: X of Y (Z%)

### T2 (Organization-Deferred) — X sub-practices
**Organization-Deferred**: X sub-practices — {list}
```

---

## Status Icons

| Icon | Meaning | Criteria |
|------|---------|----------|
| ✅ | Implemented | Pipeline directly addresses the NIST sub-task with evidence |
| ⚠️ | Partial | Pipeline addresses some but not all aspects of the sub-task |
| ❌ | Not Implemented | Pipeline does not address the sub-task (organizational/process gap or technical gap) |
| 🏢 | Organization-Deferred | Sub-practice is an organizational process outside pipeline scope; satisfied by org standards |

---

## Sample Sub-Task Entry (PO.1.1) — T1 Pipeline-Assessable

```markdown
### PO.1.1: Identify and document all security requirements for the organization's software development infrastructures and processes, and maintain the requirements over time.

**NIST Notional Examples** (summarized):
1. Define policies for securing software development infrastructures and components throughout the SDLC
2. Define policies for securing software development processes, including for open-source and third-party components
3. Review and update security requirements at least annually or when new requirements emerge
4. Educate affected individuals on impending changes to requirements

**Pipeline Implementation**:

Stage 2 (SecurityValidation) enforces security requirements via a 6-tool fail-fast control gate:

| Stage | Tool | Artifact | Description |
|-------|------|----------|-------------|
| 2 — SecurityValidation | gitleaks | gitleaks-report.json | Secret detection |
| 2 — SecurityValidation | semgrep | semgrep-report.json | SAST — OWASP Top 10, CWE Top 25 |
| 2 — SecurityValidation | trivy | trivy-report.json | SCA — HIGH/CRITICAL vulnerabilities |
| 2 — SecurityValidation | checkov | checkov-report.json | IaC security scanning |
| 2 — SecurityValidation | kics | kics-report.json | IaC security scanning |
| 2 — SecurityValidation | cfn-lint | cfn-lint-report.json | CloudFormation syntax validation |

**Cross-References**:
- Steering: `{project}/.kiro/steering/security-compliance.md` (local) — Mandatory security controls
- Profile: `security_scanning` — Scanner configurations with exact commands

**Organization Standards Alignment**:
- IT-STD-50-11 §4.1.1: All solutions provisioned per security controls in IT-MAN-50-A
- IT-HB-50-1C §3.12.1: Security risks reviewed; secure coding practices required

**Evidence**:
- Security scan reports (6 JSON files per pipeline run):
  ```bash
  aws s3 ls s3://{bucket}/SecurityReports/{build-id}/
  ```

**Validation**:
```bash
# Verify security scanning stage exists
aws codepipeline get-pipeline --name {pipeline} | jq '.pipeline.stages[] | select(.name=="SecurityValidation")'
```

**Gaps**: None — security requirements enforced via pipeline profile, steering rules, and org standards.
```

---

## Sample T2 Entry (PO.2.2) — Organization-Deferred

```markdown
### PO.2.2: Provide role-based training for all personnel with responsibilities that contribute to secure development.

🏢 **Organization-Deferred** — This sub-practice is an organizational process outside the scope of pipeline technical assessment.

**NIST Definition**: Ensure personnel with SDLC responsibilities receive appropriate role-based training.

**Organization Standards Evidence**:
- IT-HB-50-1C §3.2.1: Cyber Security Awareness Training within 30 days, annually thereafter
- IT-HB-50-1C §3.2.2: Personnel trained to carry out assigned security duties
- IT-MAN-50-A §4: References IT-STD-50-4 Cyber Security Awareness Training Standard

**Status**: 🏢 Organization-Deferred
```

---

## Update Process

1. When the pipeline changes (new stages, tools, or requirements), update the affected control family document
2. When steering rules change, verify cross-references are still accurate
3. When the NIST PDF is superseded, update all 4 family documents against the new source
4. When org standards are updated, regenerate `references/ORG-STANDARDS-SSDF-CROSSWALK.md` and update T2 citations
5. Maintain the version number and date in each document header
