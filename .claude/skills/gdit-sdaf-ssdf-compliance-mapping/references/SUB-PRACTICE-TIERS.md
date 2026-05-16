# NIST 800-218 Sub-Practice Assessment Tiers

**Purpose**: Classify each NIST SP 800-218 sub-practice by whether it can be assessed through pipeline/technical evidence or requires organizational process evidence. This prevents the skill from generating false gaps against the pipeline for controls that are inherently organizational.

**Rationale**: NIST SP 800-218 §2 states PO practices operate "at the organization level" and that "many organizations will find *some* PO practices to also be applicable to subsets of their software development." The skill assesses a release pipeline's technical compliance — not organizational HR, procurement, or governance processes.

---

## Tier Definitions

| Tier | Label | Meaning | Mapping Treatment |
|------|-------|---------|-------------------|
| T1 | Pipeline-Assessable | Pipeline can implement and evidence this control | Full mapping: implementation details, evidence commands, validation, gap assessment |
| T2 | Organization-Deferred | Organizational process that the pipeline cannot implement | Brief section: acknowledge the sub-practice, cite org standards crosswalk as evidence, mark as "Organization-Deferred — see org standards alignment", do NOT generate pipeline gaps or remediation tasks |

---

## Classification

### PO — Prepare the Organization

| Sub-Practice | Tier | Rationale |
|---|---|---|
| PO.1.1 | T1 | Pipeline documents security requirements via profile, steering rules, scanner configs |
| PO.1.2 | T1 | Pipeline enforces software security requirements via SAST, SCA, SBOM, signing |
| PO.1.3 | T2 | Communicating requirements to third-party vendors is a procurement/contractual process |
| PO.2.1 | T2 | Creating and maintaining SDLC roles is an HR/org structure process |
| PO.2.2 | T2 | Providing role-based security training is an LMS/HR process |
| PO.2.3 | T2 | Obtaining management commitment is executive governance |
| PO.3.1 | T1 | Pipeline profile specifies the toolchain with exact tools per stage |
| PO.3.2 | T1 | Pipeline is IaC-managed with change control, logging, VPC isolation |
| PO.3.3 | T1 | Pipeline stages generate artifacts (scan reports, SBOM, signatures, attestations) |
| PO.4.1 | T1 | Pipeline defines severity thresholds and fail-fast control gate criteria |
| PO.4.2 | T1 | Pipeline automatically gathers and safeguards security information |
| PO.5.1 | T1 | Pipeline enforces environment separation via VPC, IAM, Secrets Manager |
| PO.5.2 | T2 | Hardening developer workstations/endpoints is an endpoint management process |

### PS — Protect the Software

| Sub-Practice | Tier | Rationale |
|---|---|---|
| PS.1.1 | T1 | Pipeline stores code in repositories with access controls and versioning |
| PS.2.1 | T1 | Pipeline provides GPG signatures and SHA-256 checksums for integrity verification |
| PS.3.1 | T1 | Pipeline archives releases to encrypted, versioned S3 storage |
| PS.3.2 | T1 | Pipeline generates SBOM and release metadata for provenance |

### PW — Produce Well-Secured Software

| Sub-Practice | Tier | Rationale |
|---|---|---|
| PW.1.1 | T1 | Threat modeling can be evidenced by pipeline artifacts or documented process |
| PW.1.2 | T1 | Risk tracking can be evidenced by pipeline artifacts or documented process |
| PW.1.3 | T1 | Pipeline uses standardized security features (encryption, signing, SBOM format) |
| PW.2.1 | T1 | Design review can be evidenced by approval gates or review process |
| PW.4.1 | T1 | Pipeline scans third-party components via SCA |
| PW.4.2 | T1 | Pipeline enforces secure coding via SAST and steering rules |
| PW.4.4 | T1 | Pipeline verifies acquired components via SCA throughout lifecycle |
| PW.5.1 | T1 | Pipeline enforces secure coding practices via SAST rulesets |
| PW.6.1 | T1 | Pipeline uses compiler/build tools with security features |
| PW.6.2 | T1 | Pipeline configures tool security features (severity thresholds, rulesets) |
| PW.7.1 | T1 | Code review/analysis determination evidenced by pipeline config |
| PW.7.2 | T1 | Pipeline performs automated code analysis with recorded results |
| PW.8.1 | T1 | Executable testing determination evidenced by pipeline config (or known gap) |
| PW.8.2 | T1 | Pipeline performs (or lacks) executable testing with documented results |
| PW.9.1 | T1 | Secure baseline defined via IaC hardening and configuration |
| PW.9.2 | T1 | Default settings implemented via IaC and documented |

### RV — Respond to Vulnerabilities

| Sub-Practice | Tier | Rationale |
|---|---|---|
| RV.1.1 | T1 | Pipeline gathers vulnerability information via scanners and Security Hub |
| RV.1.2 | T1 | Pipeline reviews/tests code to identify vulnerabilities via SAST/SCA |
| RV.1.3 | T2 | Establishing a vulnerability disclosure policy and PSIRT is an organizational process |
| RV.2.1 | T1 | Pipeline tracks vulnerabilities via Security Hub with severity scoring |
| RV.2.2 | T1 | Pipeline supports remediation planning via auto-resolution and tracking |
| RV.3.1 | T1 | Root cause analysis can be evidenced by Security Hub trend data |
| RV.3.2 | T1 | Pattern analysis across vulnerabilities can be evidenced by Security Hub |
| RV.3.3 | T1 | Reviewing software for similar vulnerabilities evidenced by scanner coverage |
| RV.3.4 | T2 | Reviewing and updating the SDLC process is organizational governance |

---

## Summary

| Tier | Count | Sub-Practices |
|------|-------|---------------|
| T1 — Pipeline-Assessable | 35 | PO.1.1, PO.1.2, PO.3.1–PO.3.3, PO.4.1–PO.4.2, PO.5.1, PS.1.1, PS.2.1, PS.3.1–PS.3.2, PW.1.1–PW.1.3, PW.2.1, PW.4.1–PW.4.2, PW.4.4, PW.5.1, PW.6.1–PW.6.2, PW.7.1–PW.7.2, PW.8.1–PW.8.2, PW.9.1–PW.9.2, RV.1.1–RV.1.2, RV.2.1–RV.2.2, RV.3.1–RV.3.3 |
| T2 — Organization-Deferred | 7 | PO.1.3, PO.2.1, PO.2.2, PO.2.3, PO.5.2, RV.1.3, RV.3.4 |
