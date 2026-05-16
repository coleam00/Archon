---
name: gitlab-security-scanning
description: Automated detection, remediation, and reporting of security vulnerabilities from GitLab security scanners including Gitleaks (secrets), SAST, dependency scanning, and more. Use when scanning for vulnerabilities, remediating security findings, or generating compliance reports from GitLab.
license: MIT
compatibility: Requires Python 3.8+, requests, pyyaml, and GitLab API access
metadata:
  author: GDIT Platform Team
  version: "1.0.1"
  category: security
  tags: gitlab, security, vulnerabilities, gitleaks, sast, secrets, compliance
  source_extension: gitleaks-compliance
  dependencies: gitlab-integration
allowed-tools: Bash(python3:*) Bash(git:*) Read Write
---

# GitLab Security Scanning

Automated detection, remediation, and reporting of security vulnerabilities from GitLab security scanners. Integrates with GitLab to query findings from multiple scanners (Gitleaks, SAST, dependency scanning), provides reusable remediation scripts, and generates executive compliance reports.

## When to Use This Skill

Use this skill when you need to:
- Scan repositories for security vulnerabilities via GitLab
- Query findings from GitLab security scanners:
  - **Secret Detection** (Gitleaks) - Exposed credentials, API keys, tokens
  - **SAST** - Static application security testing findings
  - **Dependency Scanning** - Vulnerable dependencies
  - **Container Scanning** - Container image vulnerabilities
  - **DAST** - Dynamic application security testing
- Remediate detected vulnerabilities systematically
- Mark false positives in GitLab
- Generate security compliance reports
- Track security posture across multiple projects

### Interaction Modes

**Natural Language**: Mention GitLab security, vulnerabilities, or scanning
**Interactive Menu**: Say "load gitlab security skill" for structured workflows
**Direct Scripts**: Execute remediation scripts from command line

See `MENU.yaml` for interactive menu structure.

## Core Capabilities

### 1. GitLab Project Configuration

Manage GitLab projects for scanning:

```python
# scripts/configure_projects.py
import json
from pathlib import Path

def save_project_config(project_id, project_name, gitlab_url):
    """Save GitLab project configuration"""
    config_dir = Path.home() / '.gdit-sdaf-secrets'
    config_dir.mkdir(exist_ok=True)
    
    config_file = config_dir / 'gitlab-projects.json'
    
    # Load existing config
    if config_file.exists():
        with open(config_file) as f:
            config = json.load(f)
    else:
        config = {'projects': []}
    
    # Add or update project
    project = {
        'id': project_id,
        'name': project_name,
        'url': gitlab_url,
        'active': True
    }
    
    # Deactivate other projects
    for p in config['projects']:
        p['active'] = False
    
    config['projects'].append(project)
    
    with open(config_file, 'w') as f:
        json.dump(config, f, indent=2)
    
    print(f"✓ Configured project: {project_name}")
```

### 2. Scan for Security Findings

Query GitLab for security vulnerabilities from all scanners:

```python
# Query GitLab API for security findings
import requests

def scan_security_findings(project_id, gitlab_token, gitlab_url, report_type='all'):
    """Scan GitLab for security findings from all scanners"""
    headers = {'PRIVATE-TOKEN': gitlab_token}
    
    # Get vulnerabilities from GitLab
    url = f"{gitlab_url}/api/v4/projects/{project_id}/vulnerabilities"
    params = {'state': 'detected'}
    
    # Filter by report type if specified
    if report_type != 'all':
        params['report_type'] = report_type
    
    response = requests.get(url, headers=headers, params=params)
    findings = response.json()
    
    print(f"Found {len(findings)} security findings")
    
    # Group by scanner type
    by_scanner = {}
    for finding in findings:
        scanner = finding.get('report_type', 'unknown')
        by_scanner[scanner] = by_scanner.get(scanner, 0) + 1
    
    print("\nFindings by scanner:")
    for scanner, count in by_scanner.items():
        print(f"  - {scanner}: {count}")
    
    # Display findings
    for finding in findings:
        print(f"\n  [{finding['severity']}] {finding['title']}")
        print(f"    Scanner: {finding.get('report_type', 'unknown')}")
        print(f"    File: {finding['location']['file']}")
        print(f"    Line: {finding['location'].get('start_line', 'N/A')}")
    
    return findings

# Scan for all findings
findings = scan_security_findings(project_id, token, gitlab_url)

# Scan for specific scanner
secrets = scan_security_findings(project_id, token, gitlab_url, report_type='secret_detection')
sast = scan_security_findings(project_id, token, gitlab_url, report_type='sast')
deps = scan_security_findings(project_id, token, gitlab_url, report_type='dependency_scanning')
```

**Supported Scanner Types:**
- `secret_detection` - Gitleaks (exposed secrets)
- `sast` - Static application security testing
- `dependency_scanning` - Vulnerable dependencies
- `container_scanning` - Container vulnerabilities
- `dast` - Dynamic application security testing
- `coverage_fuzzing` - Fuzz testing
- `api_fuzzing` - API security testing

### 3. Remediation Patterns

#### Pattern A: AWS Access Key Remediation

```python
# scripts/remediation-library/aws_access_key_remediation.py
import subprocess
import re

def remediate_aws_key(file_path, line_number, finding_id):
    """Remove AWS access key from file"""
    # Read file
    with open(file_path, 'r') as f:
        lines = f.readlines()
    
    # Remove or mask the line
    if line_number <= len(lines):
        original = lines[line_number - 1]
        
        # Replace key with placeholder
        lines[line_number - 1] = re.sub(
            r'AKIA[0-9A-Z]{16}',
            'PLACEHOLDER_AWS_KEY',
            original
        )
        
        # Write back
        with open(file_path, 'w') as f:
            f.writelines(lines)
        
        print(f"✓ Remediated AWS key in {file_path}:{line_number}")
        
        # Git commit
        subprocess.run(['git', 'add', file_path])
        subprocess.run([
            'git', 'commit', '-m',
            f'fix(security): remove exposed AWS key - {finding_id}'
        ])
        
        return True
    
    return False
```

#### Pattern B: Generic API Key Remediation

```python
# scripts/remediation-library/generic_api_key_remediation.py
def remediate_generic_key(file_path, line_number, pattern):
    """Remove generic API key"""
    with open(file_path, 'r') as f:
        lines = f.readlines()
    
    if line_number <= len(lines):
        # Comment out the line
        lines[line_number - 1] = f"# REMOVED: {lines[line_number - 1]}"
        
        with open(file_path, 'w') as f:
            f.writelines(lines)
        
        print(f"✓ Commented out secret in {file_path}:{line_number}")
        return True
    
    return False
```

#### Pattern C: Mark False Positive

```python
# Mark finding as false positive in GitLab
def mark_false_positive(vulnerability_id, gitlab_token, gitlab_url, project_id):
    """Mark GitLab vulnerability as false positive"""
    headers = {'PRIVATE-TOKEN': gitlab_token}
    
    url = f"{gitlab_url}/api/v4/projects/{project_id}/vulnerabilities/{vulnerability_id}/dismiss"
    data = {
        'dismissal_reason': 'used_in_tests',
        'comment': 'Documentation example or test fixture'
    }
    
    response = requests.post(url, headers=headers, json=data)
    
    if response.status_code == 200:
        print(f"✓ Marked vulnerability {vulnerability_id} as false positive")
        return True
    
    return False
```

### 4. Security Posture Reporting

Generate consolidated security reports:

```python
# scripts/generate_posture_report.py
def generate_posture_report(projects, gitlab_token, gitlab_url):
    """Generate security posture report across projects"""
    report = {
        'generated_at': datetime.now().isoformat(),
        'projects': [],
        'summary': {
            'total_findings': 0,
            'by_severity': {'critical': 0, 'high': 0, 'medium': 0, 'low': 0},
            'by_state': {'detected': 0, 'dismissed': 0, 'resolved': 0}
        }
    }
    
    for project in projects:
        findings = scan_gitleaks_findings(
            project['id'],
            gitlab_token,
            gitlab_url
        )
        
        project_report = {
            'name': project['name'],
            'findings_count': len(findings),
            'by_severity': {}
        }
        
        for finding in findings:
            severity = finding['severity']
            project_report['by_severity'][severity] = \
                project_report['by_severity'].get(severity, 0) + 1
            
            report['summary']['by_severity'][severity] += 1
            report['summary']['total_findings'] += 1
        
        report['projects'].append(project_report)
    
    # Save report
    output_file = Path('temp') / f'security-posture-{datetime.now().strftime("%Y%m%d-%H%M%S")}.json'
    with open(output_file, 'w') as f:
        json.dump(report, f, indent=2)
    
    print(f"✓ Security posture report saved to: {output_file}")
    return report
```

### 5. Executive Compliance Report

Generate executive-level reports:

```python
# Generate markdown report for executives
def generate_executive_report(findings, project_name):
    """Generate executive compliance report"""
    report = f"""# Gitleaks Security Compliance Report

**Project:** {project_name}
**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

## Executive Summary

Total Findings: {len(findings)}

### Risk Assessment
"""
    
    # Calculate risk score
    risk_score = sum(
        {'critical': 10, 'high': 7, 'medium': 4, 'low': 1}[f['severity']]
        for f in findings
    )
    
    risk_level = 'LOW' if risk_score < 10 else \
                 'MEDIUM' if risk_score < 50 else \
                 'HIGH' if risk_score < 100 else 'CRITICAL'
    
    report += f"**Risk Level:** {risk_level} (Score: {risk_score})\n\n"
    
    # Findings by severity
    report += "### Findings by Severity\n\n"
    by_severity = {}
    for f in findings:
        by_severity[f['severity']] = by_severity.get(f['severity'], 0) + 1
    
    for severity in ['critical', 'high', 'medium', 'low']:
        count = by_severity.get(severity, 0)
        report += f"- **{severity.upper()}:** {count}\n"
    
    # Top findings
    report += "\n### Top Critical Findings\n\n"
    critical = [f for f in findings if f['severity'] in ['critical', 'high']][:5]
    
    for i, finding in enumerate(critical, 1):
        report += f"{i}. {finding['title']}\n"
        report += f"   - File: {finding['location']['file']}\n"
        report += f"   - Severity: {finding['severity']}\n\n"
    
    # Recommendations
    report += "## Recommendations\n\n"
    report += "1. Rotate all exposed credentials immediately\n"
    report += "2. Remove secrets from version control history\n"
    report += "3. Implement pre-commit hooks to prevent future exposures\n"
    report += "4. Review access logs for potential unauthorized access\n"
    
    # Save report
    output_file = Path('temp') / f'gitleaks-executive-report-{datetime.now().strftime("%Y%m%d-%H%M%S")}.md'
    with open(output_file, 'w') as f:
        f.write(report)
    
    print(f"✓ Executive report saved to: {output_file}")
    return output_file
```

## Workflow Integration

### Complete Remediation Workflow

```bash
#!/bin/bash
# Complete Gitleaks remediation workflow

PROJECT_ID="$1"
GITLAB_TOKEN="$2"
GITLAB_URL="${3:-https://gitlab.com}"

# Step 1: Configure project
python3 ~/.kiro/skills/gitlab-security-scanning/scripts/configure_projects.py --project-id "$PROJECT_ID" --gitlab-url "$GITLAB_URL"

# Step 2: Scan for findings
python3 ~/.kiro/skills/gitlab-security-scanning/scripts/scan_findings.py --project-id "$PROJECT_ID" --token "$GITLAB_TOKEN"

# Step 3: Auto-remediate
python3 ~/.kiro/skills/gitlab-security-scanning/scripts/auto_remediate.py --project-id "$PROJECT_ID" --token "$GITLAB_TOKEN"

# Step 4: Mark false positives (interactive)
python3 ~/.kiro/skills/gitlab-security-scanning/scripts/mark_false_positives.py --project-id "$PROJECT_ID" --token "$GITLAB_TOKEN"

# Step 5: Generate reports
python3 ~/.kiro/skills/gitlab-security-scanning/scripts/generate_posture_report.py --token "$GITLAB_TOKEN"
python3 ~/.kiro/skills/gitlab-security-scanning/scripts/generate_executive_report.py --project-id "$PROJECT_ID" --token "$GITLAB_TOKEN"

echo "✓ Remediation workflow complete"
```

## Best Practices

### 1. Token Management

- Store GitLab tokens in `~/.gdit-sdaf-secrets/gitlab-tokens.json`
- Never commit tokens to version control
- Use environment variables for CI/CD
- Rotate tokens regularly

### 2. Remediation Safety

- Always review findings before auto-remediation
- Use dry-run mode first
- Commit changes with descriptive messages
- Document false positives

### 3. False Positive Handling

Mark as false positive when:
- Documentation examples
- Test fixtures
- Public API keys (non-sensitive)
- Already rotated credentials

### 3a. Dismissing Findings — Two APIs

GitLab has TWO separate finding systems. You MUST use the correct API for each:

**Project-level vulnerabilities** (default branch, visible in Vulnerability Report):
- Have numeric vulnerability IDs (e.g., 53703)
- Query: `GET /api/v4/projects/{id}/vulnerabilities?state=detected&severity=critical`
- Dismiss: `POST /api/v4/vulnerabilities/{id}/dismiss`
- Body: `{"dismissal_reason": "mitigating_control", "comment": "..."}`
- Reasons: `false_positive`, `used_in_tests`, `acceptable_risk`, `mitigating_control`

**Pipeline-level findings** (branch pipelines, visible in "needs triage" filter):
- Have UUIDs (e.g., `09585d9a-7e8c-5f23-9873-d51b0535686c`)
- Query: `GET /api/v4/projects/{id}/vulnerability_findings?pipeline_id={pid}&severity=critical`
- Dismiss: `POST /api/graphql` with mutation:
  ```graphql
  mutation {
    securityFindingDismiss(input: {
      uuid: "<uuid>",
      comment: "...",
      dismissalReason: MITIGATING_CONTROL
    }) { securityFinding { uuid state } errors }
  }
  ```
- Reasons are UPPER_CASE enums: `FALSE_POSITIVE`, `ACCEPTABLE_RISK`, `MITIGATING_CONTROL`

**CRITICAL**: When dismissing findings from a scan:
1. Always query pipeline-level findings with the specific pipeline ID to get UUIDs
2. Dismiss via GraphQL using those UUIDs — this is what clears "needs triage" in the UI
3. Project-level REST dismiss alone does NOT clear pipeline-level findings
4. GitLab does NOT auto-resolve findings on rescan — all must be manually dismissed
5. Always query pipeline findings AFTER dismissal to verify state changed

**Workflow for dismissing scan findings:**
```
1. Run scan → note pipeline ID and finding IDs
2. GET /vulnerability_findings?pipeline_id={pid}&severity=critical → get UUIDs for detected findings
3. For each UUID: POST /api/graphql securityFindingDismiss mutation
4. Verify: re-query pipeline findings to confirm state=DISMISSED
```

### 4. Compliance Reporting

- Generate reports regularly (weekly/monthly)
- Track trends over time
- Share executive reports with stakeholders
- Maintain audit trail

## Anti-Patterns to Avoid

❌ **Don't** remediate without reviewing findings first
❌ **Don't** skip rotating exposed credentials
❌ **Don't** ignore findings in test files
❌ **Don't** commit remediation without verification
❌ **Don't** share GitLab tokens insecurely

## Integration with the GDIT framework Platform

This skill integrates with the GDIT framework's specification-driven development:

- **Requirements**: Security findings become tracked requirements
- **Tasks**: Remediation work tracked with time estimates
- **Validation**: Automated checks provide evidence
- **Audit**: Full audit trails for compliance

## File Organization

```
.kiro/skills/gitlab-security-scanning/
├── SKILL.md                    # This file
├── MENU.yaml                   # Interactive menu
├── scripts/                    # Remediation scripts
│   ├── configure_projects.py
│   ├── scan_findings.py
│   ├── auto_remediate.py
│   ├── mark_false_positives.py
│   ├── generate_posture_report.py
│   └── remediation-library/
│       ├── aws_access_key_remediation.py
│       ├── github_token_remediation.py
│       ├── generic_api_key_remediation.py
│       └── private_key_remediation.py
├── references/                 # Documentation
│   └── REMEDIATION-PATTERNS.md
└── assets/                     # Templates

~/.gdit-sdaf-secrets/              # Git-ignored secrets
├── gitlab-tokens.json
└── gitlab-projects.json

temp/                          # Git-ignored reports
├── security-posture-*.json
└── gitleaks-executive-report-*.md
```

## References

See [references/REMEDIATION-PATTERNS.md](references/REMEDIATION-PATTERNS.md) for detailed remediation patterns.

## Support

For issues or questions:
- Review original extension: `/home/tom.moore/dev/extensions/gitleaks-compliance/`
- Check remediation library: `remediation-library/scripts/`
- Consult GitLab API documentation

## Prerequisites

This skill requires GDIT-SDAF to be set up. Run once per machine:

```
archon workflow run gdit-sdaf-setup
```

After setup, scripts are available at `~/.kiro/skills/gitlab-security-scanning/scripts/`.
