# Security Scanner Configuration

## Scanner Overview

All scanners run locally before commit and in CI/CD pipeline on merge/pull requests. Works with any Git provider.

## Gitleaks - Secret Detection

**Purpose:** Detect exposed secrets, API keys, tokens, passwords

**Installation:**
```bash
curl -sSfL https://raw.githubusercontent.com/gitleaks/gitleaks/master/scripts/install.sh | sh -s -- -b /usr/local/bin
```

**Usage:**
```bash
gitleaks detect --source . --no-git --verbose
```

**Configuration:** `.gitleaks.toml` (optional)

**Blocking Criteria:** Any secret detected

## Semgrep - SAST

**Purpose:** Static application security testing

**Installation:**
```bash
pip3 install --user semgrep
```

**Usage:**
```bash
semgrep --config=auto --severity=ERROR --severity=WARNING .
```

**Blocking Criteria:** ERROR-level findings

## Trivy - Vulnerability Scanning

**Purpose:** Scan for vulnerabilities in dependencies, containers, IaC

**Installation:**
```bash
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin
```

**Usage:**
```bash
trivy fs --scanners vuln --severity HIGH,CRITICAL .
```

**Blocking Criteria:** HIGH or CRITICAL vulnerabilities

## cfn-lint - CloudFormation Linting

**Purpose:** Validate CloudFormation templates

**Installation:**
```bash
pip3 install --user cfn-lint
```

**Usage:**
```bash
cfn-lint template.yaml
```

**Blocking Criteria:** Error-level findings

## cfn-guard - CloudFormation Policy Validation

**Purpose:** Enforce CloudFormation policies and compliance rules

**Installation:**
```bash
# Via cargo
cargo install cfn-guard

# Or download binary
curl -L -o cfn-guard.tar.gz https://github.com/aws-cloudformation/cloudformation-guard/releases/latest/download/cfn-guard-v3-ubuntu-latest.tar.gz
tar -xzf cfn-guard.tar.gz -C /usr/local/bin
```

**Usage:**
```bash
cfn-guard validate --data template.yaml --rules assets/cfn-guard-rules.guard
```

**Configuration:** `assets/cfn-guard-rules.guard` (included in skill)

**Blocking Criteria:** Policy violations (configurable)

## Checkov - IaC Security

**Purpose:** Security and compliance scanning for IaC

**Installation:**
```bash
pip3 install --user checkov
```

**Usage:**
```bash
checkov -d . --framework cloudformation terraform
```

**Blocking Criteria:** Advisory only (warnings)

## KICS - IaC Scanning

**Purpose:** Find security vulnerabilities in IaC

**Installation:**
```bash
curl -sfL https://raw.githubusercontent.com/Checkmarx/kics/master/install.sh | bash
```

**Usage:**
```bash
kics scan -p . --exclude-paths node_modules
```

**Blocking Criteria:** HIGH or CRITICAL findings

## Scanner Matrix

| Scanner | Type | Blocks | Install Method | Config File |
|---------|------|--------|----------------|-------------|
| gitleaks | Secrets | Yes | Binary | .gitleaks.toml |
| semgrep | SAST | Yes | pip | .semgrep.yml |
| trivy | Vuln | Yes | Binary | trivy.yaml |
| cfn-lint | CFN | Yes | pip | .cfnlintrc |
| cfn-guard | Policy | Yes | Binary/Cargo | cfn-guard-rules.guard |
| checkov | IaC | No | pip | .checkov.yml |
| KICS | IaC | Yes | Binary | kics.config |

## Suppressing False Positives

### Gitleaks
```yaml
# .gitleaks.toml
[allowlist]
paths = ["docs/examples/"]
```

### Semgrep
```python
# nosemgrep
code_with_false_positive()
```

### Trivy
```yaml
# .trivyignore
CVE-2021-12345
```

### Checkov
```python
# checkov:skip=CKV_AWS_1:Reason for skip
resource "aws_s3_bucket" "example" {}
```

## CI/CD Integration

All scanners run in Git provider CI/CD pipeline:

```yaml
security-scan:
  stage: test
  script:
    - gitleaks detect --source . --no-git
    - semgrep --config=auto --severity=ERROR .
    - trivy fs --severity HIGH,CRITICAL .
    - cfn-lint **/*.yaml
    - checkov -d .
    - kics scan -p .
  allow_failure: false
```
