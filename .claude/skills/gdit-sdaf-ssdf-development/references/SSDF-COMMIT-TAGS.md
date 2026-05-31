# SSDF Commit Tag Reference

Maps development activities to NIST SP 800-218 practice IDs for use in git checkpoint `Compliance:` fields.

Used by:
- The agent when writing commit messages (determines which tags to apply)
- `collect_evidence.py` when parsing git history (knows which tags to look for)

## Activity → Practice Mapping

| Development Activity | SSDF Practices | Rationale |
|---------------------|----------------|-----------|
| Security scan (semgrep, trivy, gitleaks) | PW.7.1, PW.7.2 | Analyze software for vulnerabilities |
| Code implementation with input validation | PW.1.1 | Design to meet security requirements |
| Code review / design review | PW.4.1, PW.4.2 | Review human-readable code |
| Dependency update / pinning | PS.3.1, PS.3.2 | Protect software components |
| SBOM generation | PS.3.2 | Software composition analysis |
| Vulnerability remediation | RV.1.1, RV.2.1 | Identify and respond to vulnerabilities |
| Secret detection and rotation | PW.1.1, PS.1.1 | Protect access to code and infrastructure |
| IaC security validation (checkov, cfn-guard) | PW.7.1, PW.1.1 | Analyze infrastructure for security |
| Test execution | PW.8.1, PW.8.2 | Test software with security scenarios |
| Threat model update | PW.1.1 | Design to meet security requirements |
| Spec creation / requirements review | PW.1.1 | Security requirements at design time |
| Artifact integrity verification | PS.2.1 | Protect software integrity |

## Commit Message Format

```
feat: implement user input validation (Task 3)

- Add email validation with allowlist pattern
- Add parameterized database queries

Compliance: PW.1.1, PW.4.1
Evidence: semgrep 0 findings, gitleaks 0 secrets
```

## Rules

- Include `Compliance:` line in every git checkpoint commit
- List only practices that were actually exercised in the task (not aspirational)
- Multiple practices separated by commas
- Use sub-practice IDs (e.g., PW.1.1 not PW.1)
- The `Evidence:` line remains separate — it captures tool output, not SSDF mapping

## Full Practice ID Reference

### PO — Prepare the Organization
PO.1.1, PO.1.2, PO.1.3 | PO.2.1, PO.2.2 | PO.3.1, PO.3.2, PO.3.3 | PO.4.1, PO.4.2 | PO.5.1, PO.5.2

### PS — Protect the Software
PS.1.1 | PS.2.1 | PS.3.1, PS.3.2

### PW — Produce Well-Secured Software
PW.1.1 | PW.2.1 | PW.4.1, PW.4.2 | PW.5.1 | PW.6.1, PW.6.2 | PW.7.1, PW.7.2 | PW.8.1, PW.8.2 | PW.9.1, PW.9.2

### RV — Respond to Vulnerabilities
RV.1.1, RV.1.2, RV.1.3 | RV.2.1, RV.2.2 | RV.3.1, RV.3.2, RV.3.3, RV.3.4
