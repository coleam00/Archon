# CISA Attestation Form — SSDF Practice Mapping

Maps each statement from the CISA Secure Software Development Attestation Form to the SSDF sub-practices it requires, and defines what evidence constitutes READY / PARTIAL / NOT READY.

Used by `validate_attestation.py` to assess attestation readiness.

## Attestation Statements

### Statement 1: Secure Development Environment

"The software was developed and built in secure environments."

| Evidence Type | What to Check | Required |
|--------------|---------------|----------|
| Commit evidence | PS.1.1, PS.2.1 tags in git history | Yes |
| Project artifact | None specific | — |
| Mapping doc presence | PS-PROTECT-SOFTWARE.md exists | Yes |

**READY**: Commit evidence for PS.1.1 AND PS.2.1 within period AND PS mapping doc exists
**PARTIAL**: Commit evidence for one of PS.1.1/PS.2.1 OR mapping doc exists but no commit evidence
**NOT READY**: No commit evidence AND no mapping doc
**Remediation (NOT READY)**: Run `load ssdf-compliance-mapping skill` → create-family-mapping for PS family. Ensure supply-chain-security.md steering is active.

### Statement 2: Security-Focused Development Processes

"The software producer has made a good-faith effort to maintain trusted source code supply chains."

| Evidence Type | What to Check | Required |
|--------------|---------------|----------|
| Commit evidence | PS.3.1, PS.3.2 tags in git history | Yes |
| Project artifact | SBOM file in `docs/compliance-by-family/PS/SBOM-*.json` | Yes |
| Mapping doc presence | PS-PROTECT-SOFTWARE.md exists | Yes |

**READY**: Commit evidence for PS.3.1 AND PS.3.2 AND SBOM exists AND PS mapping doc exists
**PARTIAL**: Some but not all of the above
**NOT READY**: No SBOM AND no commit evidence
**Remediation (NOT READY)**: Run `load ssdf-development skill` → generate-sbom. Implement dependency pinning per supply-chain-security.md steering.

### Statement 3: Automated Security Tools

"The software producer employs automated tools or comparable processes to check for security vulnerabilities."

| Evidence Type | What to Check | Required |
|--------------|---------------|----------|
| Commit evidence | PW.7.1, PW.7.2 tags in git history | Yes |
| Project artifact | None specific (scan results in commit Evidence fields) | — |
| Mapping doc presence | PW-PRODUCE-WELL-SECURED-SOFTWARE.md exists | Recommended |

**READY**: Commit evidence for PW.7.1 AND PW.7.2 within period (indicates scans are running)
**PARTIAL**: Commit evidence for one of PW.7.1/PW.7.2
**NOT READY**: No commit evidence for PW.7.x
**Remediation (NOT READY)**: Ensure security-compliance.md steering is active (enforces semgrep, trivy, gitleaks). Run security scans on existing code.

### Statement 4: Remediation of Vulnerabilities

"The software producer has remediated or mitigated known exploited vulnerabilities."

| Evidence Type | What to Check | Required |
|--------------|---------------|----------|
| Commit evidence | RV.1.1, RV.2.1 tags in git history | Yes |
| Project artifact | None specific | — |
| Mapping doc presence | RV-RESPOND-VULNERABILITIES.md exists | Recommended |

**READY**: Commit evidence for RV.1.1 AND RV.2.1 within period
**PARTIAL**: Commit evidence for one of RV.1.1/RV.2.1 OR RV mapping doc exists
**NOT READY**: No commit evidence for RV.x.x AND no RV mapping doc
**Remediation (NOT READY)**: Run `load ssdf-compliance-mapping skill` → create-family-mapping for RV family. Ensure vulnerability response behavior (#10) is active in agent prompt.

### Statement 5: SBOM Generation

"The software producer can provide a Software Bill of Materials when requested."

| Evidence Type | What to Check | Required |
|--------------|---------------|----------|
| Commit evidence | PS.3.2 tags in git history | Recommended |
| Project artifact | SBOM file in `docs/compliance-by-family/PS/SBOM-*.json` | Yes |
| Mapping doc presence | None specific | — |

**READY**: SBOM file exists AND is less than 365 days old
**PARTIAL**: SBOM file exists but older than 365 days
**NOT READY**: No SBOM file found
**Remediation (NOT READY)**: Run `load ssdf-development skill` → generate-sbom.

### Statement 6: Secure Software Design

"The software was designed to meet security requirements and mitigate security risks."

| Evidence Type | What to Check | Required |
|--------------|---------------|----------|
| Commit evidence | PW.1.1 tags in git history | Yes |
| Project artifact | Threat model in `docs/compliance-by-family/PW/THREAT-MODEL.md` | Recommended |
| Mapping doc presence | PW-PRODUCE-WELL-SECURED-SOFTWARE.md exists | Recommended |

**READY**: Commit evidence for PW.1.1 within period AND (threat model exists OR PW mapping doc exists)
**PARTIAL**: Commit evidence for PW.1.1 but no threat model or mapping doc
**NOT READY**: No commit evidence for PW.1.1
**Remediation (NOT READY)**: Ensure security-compliance.md steering is active. Run `load ssdf-compliance-mapping skill` → create-family-mapping for PW, then scaffold-artifacts for threat model.

### Statement 7: Code Review

"The software producer has performed code review to identify and mitigate security vulnerabilities."

| Evidence Type | What to Check | Required |
|--------------|---------------|----------|
| Commit evidence | PW.4.1, PW.4.2 tags in git history | Yes |
| Project artifact | None specific | — |
| Mapping doc presence | PW-PRODUCE-WELL-SECURED-SOFTWARE.md exists | Recommended |

**READY**: Commit evidence for PW.4.1 within period
**PARTIAL**: PW mapping doc exists but no commit evidence for PW.4.x
**NOT READY**: No commit evidence AND no PW mapping doc
**Remediation (NOT READY)**: Ensure development-workflow.md steering enforces code review. AI-assisted code review generates PW.4.1 tags automatically.

### Statement 8: Testing

"The software producer has tested the code to identify and mitigate security vulnerabilities."

| Evidence Type | What to Check | Required |
|--------------|---------------|----------|
| Commit evidence | PW.8.1, PW.8.2 tags in git history | Yes |
| Project artifact | None specific (test results in commit Evidence fields) | — |
| Mapping doc presence | None specific | — |

**READY**: Commit evidence for PW.8.1 within period
**PARTIAL**: Commit evidence exists but only PW.8.2 (not PW.8.1)
**NOT READY**: No commit evidence for PW.8.x
**Remediation (NOT READY)**: Enable testing in project.yaml (`test-after` or `test-driven`). Run tests and commit with PW.8.1 tags.

## Parsing Notes for validate_attestation.py

- Statement IDs are `Statement 1` through `Statement 8`
- Each statement has a table with columns: Evidence Type, What to Check, Required
- The "What to Check" column for commit evidence contains practice IDs (e.g., `PS.1.1, PS.2.1`)
- The "What to Check" column for project artifacts contains file glob patterns
- Mapping doc presence checks are file existence only — do NOT parse internal status
- READY/PARTIAL/NOT READY definitions follow each table
- Remediation lines that reference `ssdf-compliance-mapping` skill indicate documentation gaps outside this skill's scope
