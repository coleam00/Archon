---
name: aws-security-remediation
description: Systematic remediation of AWS Security Hub findings with automated workflows, compliance tracking, and audit reporting. Use when remediating AWS security findings, managing security compliance, or generating security audit reports.
license: MIT
compatibility: Requires Python 3.12+, boto3>=1.34.0, AWS CLI, and access to AWS Security Hub. All scripts use PEP 723 inline metadata for platform-agnostic execution.
metadata:
  author: GDIT Platform Team
  version: "2.0.0"
  category: security
  tags: aws, security-hub, compliance, remediation, audit, pep723
  source_extension: security-compliance
  python_version: ">=3.12"
allowed-tools: Bash(aws:*) Bash(python3.12:*) Read Write
---

# AWS Security Remediation

Systematic remediation of AWS Security Hub findings following specification-driven development principles. This skill provides reusable workflows for discovering, documenting, remediating, and validating security findings with full audit trails.

## Platform Requirements

- **Python**: 3.12 or greater
- **Dependencies**: boto3>=1.34.0 (declared via PEP 723 inline metadata)
- **AWS CLI**: Configured with appropriate profiles
- **Platform**: Fully platform-agnostic (no shell scripts)

All scripts use [PEP 723](https://peps.python.org/pep-0723/) inline script metadata for dependency declaration, making them executable on any platform with Python 3.12+.

## When to Use This Skill

Use this skill when you need to:
- Remediate AWS Security Hub findings systematically
- Convert security findings into trackable requirements
- Generate compliance audit reports
- Validate security remediation with automated checks
- Track security work using specification-driven development
- Manage AWS security compliance across multiple accounts

### Interaction Modes

**Natural Language**: Just mention AWS security topics, and I'll help you
**Interactive Menu**: Say "load aws remediation skill" to see structured menu
**Direct Scripts**: Execute scripts directly from command line

See `MENU.yaml` for interactive menu structure.

## Core Capabilities

### 1. Security Finding Discovery

Query AWS Security Hub for active findings and convert them to structured requirements:

```bash
# List active findings by severity
aws securityhub get-findings \
  --filters '{"SeverityLabel": [{"Value": "CRITICAL", "Comparison": "EQUALS"}]}' \
  --profile your-profile

# Get findings for specific control
aws securityhub get-findings \
  --filters '{"ComplianceSecurityControlId": [{"Value": "Config.1", "Comparison": "EQUALS"}]}' \
  --profile your-profile
```

### 2. Requirement Generation Pattern

Convert security findings to EARS notation requirements:

**Template:**
```markdown
# Security Requirement: [Finding Title]

**Security ID:** SEC-[CATEGORY]-001
**Finding ID:** [Security Hub Finding ARN]
**Severity:** Critical|High|Medium|Low
**Compliance Framework:** [NIST, SOC2, AWS Foundational Security]
**Status:** 🚧 In Progress | ✅ Completed | ❌ Not Started

## Finding Details
- **Control ID:** [e.g., Config.1]
- **Resource:** [Affected AWS resource]
- **Description:** [Security Hub finding description]

## Security Requirement (EARS Notation)
**WHEN** [security condition or trigger]
**THE SYSTEM SHALL** [required security behavior]
**WHERE** [implementation constraints or context]

## Remediation Steps
1. [Step with AWS CLI commands]
2. [Validation steps]
3. [Compliance verification]

## Acceptance Criteria
**WHEN** remediation is completed
**THE SYSTEM SHALL** [validation criteria]
**AND** Security Hub finding status **SHALL** be updated to RESOLVED
```

### 3. AWS Profile Management

Select and persist AWS profile for remediation session:

```python
#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""AWS Profile Selection"""

import boto3
import json
from pathlib import Path

def list_profiles():
    """List available AWS profiles from ~/.aws/config"""
    config_file = Path.home() / '.aws' / 'config'
    profiles = []
    
    if config_file.exists():
        with open(config_file) as f:
            for line in f:
                if line.strip().startswith('[profile '):
                    profile = line.strip()[9:-1]
                    profiles.append(profile)
    
    creds_file = Path.home() / '.aws' / 'credentials'
    if creds_file.exists():
        profiles.insert(0, 'default')
    
    return profiles

def validate_profile(profile_name):
    """Validate profile and get account info"""
    try:
        session = boto3.Session(profile_name=profile_name)
        sts = session.client('sts')
        identity = sts.get_caller_identity()
        
        return {
            'valid': True,
            'account_id': identity['Account'],
            'arn': identity['Arn'],
            'region': session.region_name or 'us-east-1'
        }
    except Exception as e:
        return {'valid': False, 'error': str(e)}
```

### 4. Common Remediation Patterns

#### Pattern A: IAM Policy Remediation

For overly permissive IAM policies:

```python
#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""IAM Policy Remediation"""

import boto3
import json
import sys

profile = sys.argv[1] if len(sys.argv) > 1 else 'default'
policy_arn = sys.argv[2]

session = boto3.Session(profile_name=profile)
iam = session.client('iam')

# Get current policy version
policy = iam.get_policy(PolicyArn=policy_arn)
current_version = policy['Policy']['DefaultVersionId']

# Get policy document
policy_doc = iam.get_policy_version(
    PolicyArn=policy_arn,
    VersionId=current_version
)

print(json.dumps(policy_doc['PolicyVersion']['Document'], indent=2))
print(f"\nReview and modify policy, then create new version")
```

#### Pattern B: S3 Bucket Security

For S3 bucket security findings:

```python
#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""S3 Security Remediation"""

import boto3
import sys

def remediate_s3_bucket(bucket_name, profile_name):
    session = boto3.Session(profile_name=profile_name)
    s3 = session.client('s3')
    
    s3.put_bucket_versioning(
        Bucket=bucket_name,
        VersioningConfiguration={'Status': 'Enabled'}
    )
    print(f"✓ Enabled versioning on {bucket_name}")
    
    s3.put_bucket_encryption(
        Bucket=bucket_name,
        ServerSideEncryptionConfiguration={
            'Rules': [{
                'ApplyServerSideEncryptionByDefault': {
                    'SSEAlgorithm': 'AES256'
                }
            }]
        }
    )
    print(f"✓ Enabled default encryption on {bucket_name}")
    
    s3.put_public_access_block(
        Bucket=bucket_name,
        PublicAccessBlockConfiguration={
            'BlockPublicAcls': True,
            'IgnorePublicAcls': True,
            'BlockPublicPolicy': True,
            'RestrictPublicBuckets': True
        }
    )
    print(f"✓ Blocked public access on {bucket_name}")

if __name__ == '__main__':
    bucket = sys.argv[1]
    profile = sys.argv[2] if len(sys.argv) > 2 else 'default'
    remediate_s3_bucket(bucket, profile)
```

#### Pattern C: Config Rule Compliance

For AWS Config rule violations:

```bash
# Check Config recorder status
aws configservice describe-configuration-recorder-status --profile "$PROFILE"

# Enable Config recorder if not active
aws configservice start-configuration-recorder \
  --configuration-recorder-name default \
  --profile "$PROFILE"

# Verify compliance
aws configservice describe-compliance-by-config-rule \
  --config-rule-names "$RULE_NAME" \
  --profile "$PROFILE"
```

### 5. Compliance Validation

Validate remediation and update Security Hub:

```python
#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""Security Hub Validation"""

import boto3
from datetime import datetime

def update_finding_status(finding_id, profile_name, note="Remediated"):
    session = boto3.Session(profile_name=profile_name)
    securityhub = session.client('securityhub')
    
    response = securityhub.batch_update_findings(
        FindingIdentifiers=[{'Id': finding_id, 'ProductArn': finding_id.split('/')[0]}],
        Workflow={'Status': 'RESOLVED'},
        Note={
            'Text': note,
            'UpdatedBy': 'security-remediation-skill'
        }
    )
    
    return response

def verify_compliance(control_id, profile_name):
    session = boto3.Session(profile_name=profile_name)
    securityhub = session.client('securityhub')
    
    findings = securityhub.get_findings(
        Filters={
            'ComplianceSecurityControlId': [{'Value': control_id, 'Comparison': 'EQUALS'}],
            'WorkflowStatus': [{'Value': 'NEW', 'Comparison': 'EQUALS'}]
        }
    )
    
    return len(findings['Findings']) == 0
```

### 6. Audit Reporting

Generate compliance audit reports with proper data masking:

```python
#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""Compliance Audit Report Generator"""

import boto3
import json
from datetime import datetime
from pathlib import Path

def mask_access_key(key_id):
    if not key_id or len(key_id) < 4:
        return "****"
    return f"****{key_id[-4:]}"

def generate_audit_report(profile_name):
    session = boto3.Session(profile_name=profile_name)
    securityhub = session.client('securityhub')
    iam = session.client('iam')
    
    findings = securityhub.get_findings(
        Filters={'WorkflowStatus': [{'Value': 'NEW', 'Comparison': 'EQUALS'}]}
    )
    
    users = iam.list_users()
    access_key_report = []
    
    for user in users['Users']:
        keys = iam.list_access_keys(UserName=user['UserName'])
        for key in keys['AccessKeyMetadata']:
            access_key_report.append({
                'UserName': user['UserName'],
                'AccessKeyId': mask_access_key(key['AccessKeyId']),
                'Status': key['Status'],
                'CreateDate': key['CreateDate'].isoformat()
            })
    
    report = {
        'generated_at': datetime.now().isoformat(),
        'profile': profile_name,
        'account_id': session.client('sts').get_caller_identity()['Account'],
        'findings_summary': {
            'total': len(findings['Findings']),
            'by_severity': {}
        },
        'access_keys': access_key_report
    }
    
    for finding in findings['Findings']:
        severity = finding['Severity']['Label']
        report['findings_summary']['by_severity'][severity] = \
            report['findings_summary']['by_severity'].get(severity, 0) + 1
    
    output_dir = Path('temp')
    output_dir.mkdir(exist_ok=True)
    
    timestamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    output_file = output_dir / f'security-audit-{timestamp}.json'
    
    with open(output_file, 'w') as f:
        json.dump(report, f, indent=2)
    
    print(f"✓ Audit report saved to: {output_file}")
    return output_file
```

**CRITICAL: Audit Report Storage Rules**
- ✅ ALWAYS save audit reports to `temp/` directory
- ❌ NEVER save reports to `scripts/` or framework directories
- ✅ ALWAYS mask AWS access key IDs (show only last 4 characters)
- ❌ NEVER include AKIA prefix in reports
- ✅ temp/ directory is git-ignored to prevent sensitive data commits

## Workflow Integration

### Complete Remediation Workflow

```python
#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""Complete Security Remediation Workflow"""

import boto3
import json
import sys
from pathlib import Path

profile = sys.argv[1]
finding_id = sys.argv[2]

# Get finding details
session = boto3.Session(profile_name=profile)
securityhub = session.client('securityhub')

findings = securityhub.get_findings(
    Filters={'Id': [{'Value': finding_id, 'Comparison': 'EQUALS'}]}
)

output_dir = Path('temp')
output_dir.mkdir(exist_ok=True)

with open(output_dir / 'finding-details.json', 'w') as f:
    json.dump(findings, f, indent=2)

print(f"✓ Finding details saved to temp/finding-details.json")
print(f"✓ Execute control-specific remediation script")
print(f"✓ Run validation and update Security Hub status")
```

## Best Practices

### 1. Specification-Driven Approach

- Convert ALL security findings to requirements before remediation
- Use EARS notation for consistency with functional requirements
- Track security work in tasks.md with time estimates
- Generate audit trails for compliance validation

### 2. AWS Profile Management

- Always validate profile before operations
- Display account ID and region for confirmation
- Persist profile selection for session duration
- Use `--profile` flag consistently across all AWS CLI commands

### 3. Data Security

- Mask all AWS access key IDs in reports
- Save audit reports to temp/ directory only
- Never commit sensitive data to version control
- Use git-ignored directories for temporary files

### 4. Compliance Validation

- Verify remediation with automated checks
- Update Security Hub finding status
- Generate evidence for audit trails
- Re-run security controls to confirm resolution

### 5. Remediation Safety

- Review changes before applying
- Test in non-production first
- Maintain rollback procedures
- Document all changes in specifications

## Anti-Patterns to Avoid

❌ **Don't** remediate without creating requirement specifications
❌ **Don't** skip AWS profile validation
❌ **Don't** save audit reports outside temp/ directory
❌ **Don't** include unmasked access keys in reports
❌ **Don't** update Security Hub without validation
❌ **Don't** apply changes without review
❌ **Don't** skip compliance verification

## Example: Complete IAM Policy Remediation

```python
#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""IAM Policy Remediation Example"""

import boto3
import json
from pathlib import Path

profile = "com-r"
policy_arn = "arn:aws:iam::123456789012:policy/OverlyPermissivePolicy"
finding_id = "arn:aws:securityhub:us-east-1:123456789012:finding/abc123"

session = boto3.Session(profile_name=profile)
iam = session.client('iam')

# Get current policy
policy = iam.get_policy(PolicyArn=policy_arn)
policy_doc = iam.get_policy_version(
    PolicyArn=policy_arn,
    VersionId=policy['Policy']['DefaultVersionId']
)

output_dir = Path('temp')
output_dir.mkdir(exist_ok=True)

with open(output_dir / 'current-policy.json', 'w') as f:
    json.dump(policy_doc['PolicyVersion']['Document'], f, indent=2)

print(f"✓ Current policy saved to temp/current-policy.json")
print(f"✓ Review and edit policy to remove overly permissive actions")
print(f"✓ Apply updated policy with create_policy_version()")
print(f"✓ Validate and update Security Hub finding status")
```

## Integration with the GDIT framework Platform

This skill integrates with the GDIT framework's specification-driven development:

- **Requirements**: Security findings become EARS notation requirements
- **Tasks**: Remediation work tracked in tasks.md with estimates
- **Validation**: Automated compliance checks provide evidence
- **Audit**: Full audit trails for compliance reporting

## File Organization

```
.kiro/specs/security-compliance/
├── requirements.md          # Security requirements (EARS notation)
├── design.md               # Technical architecture
├── tasks.md                # Implementation tasks
├── findings/               # Individual finding specs
│   ├── SEC-CONFIG-001.md
│   ├── SEC-IAM-001.md
│   └── SEC-S3-001.md
└── reports/                # Compliance reports

temp/                       # Git-ignored temporary files
├── security-audit-*.json   # Audit reports (MASKED data)
├── finding-details.json
└── current-policy.json
```

## References

See [references/COMPLIANCE-FRAMEWORKS.md](references/COMPLIANCE-FRAMEWORKS.md) for compliance framework mappings.

See [references/REMEDIATION-LIBRARY.md](references/REMEDIATION-LIBRARY.md) for detailed remediation scripts.

See [references/AWS-CONTROLS.md](references/AWS-CONTROLS.md) for AWS Security Hub control reference.

## Support

For issues or questions:
- Review original extension: `/home/tom.moore/dev/extensions/security-compliance/`
- Check remediation library: `remediation-library/scripts/`
- Consult security compliance documentation

## Prerequisites

This skill requires GDIT-SDAF to be set up. Run once per machine:

```
archon workflow run gdit-sdaf-setup
```

After setup, scripts are available at `~/.kiro/skills/aws-security-remediation/scripts/`.
