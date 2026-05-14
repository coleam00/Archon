# Root Cause Analysis Template

**NIST 800-218**: PW.7.2 (Code Analysis), RV.2.1 (Vulnerability Analysis)

---

## Finding Information

- **Finding ID**: [Security Hub or scanner finding ID]
- **Tool**: [semgrep/trivy/checkov/kics/gitleaks/cfn-lint/other]
- **Severity**: [CRITICAL/HIGH/MEDIUM/LOW]
- **First Detected**: [DATE]
- **Recurrence Count**: [number]

## Root Cause

- [ ] Developer knowledge gap
- [ ] Missing input validation
- [ ] Dependency vulnerability (upstream)
- [ ] Configuration drift
- [ ] Design flaw
- [ ] Other: ___

## Analysis

<!-- TODO: Describe why this vulnerability exists and how it was introduced -->

## Remediation

<!-- TODO: Specific code/config changes to fix -->

## Prevention

<!-- TODO: What process/tool change prevents recurrence -->
- [ ] Add scanner rule
- [ ] Update secure coding guidelines
- [ ] Add policy-as-code rule
- [ ] Update training materials
- [ ] Other: ___

## Verification

<!-- TODO: How to confirm the fix works and recurrence is prevented -->
