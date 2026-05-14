# SSDF Manager — User Guide

## Prerequisites

- Python 3.12+
- AWS CLI configured with a profile that has access to the pipeline's S3 artifact bucket and Security Hub
- kiro-cli (or any AI assistant that supports skills)
- Empty working directory (recommended — source files are downloaded to `temp/`)

## Required IAM Permissions

Your AWS profile needs:

| Permission | Purpose |
|-----------|---------|
| `sts:GetCallerIdentity` | Profile validation |
| `s3:ListAllMyBuckets` | Pipeline discovery |
| `s3:ListBucket`, `s3:GetObject` | Read scan reports, overrides, source ZIP |
| `s3:PutObject` (on `manifests/finding-overrides.json`) | Write overrides |
| `securityhub:BatchUpdateFindings` | Suppress findings |
| `logs:CreateLogStream`, `logs:PutLogEvents` | Audit logging |
| `logs:StartQuery`, `logs:GetQueryResults` | View changelog |

## Quick Start

```
cd /tmp/ssdf-review    # empty working directory
kiro-cli chat
> load ssdf-manager skill
> 1                    # select profile & pipeline
> 2                    # scan report
```

## Full Workflow

### Step 1: Select AWS Profile & Pipeline

Sets the AWS profile and discovers which pipeline to manage.

```
> 1  (Select AWS Profile & Pipeline)
```

The script:
1. Lists available AWS profiles from `~/.aws/config` and `~/.aws/credentials`
2. Validates the selected profile via `sts:GetCallerIdentity`
3. Discovers pipeline instances by finding S3 buckets matching `*-artifacts-{account}-{region}`
4. Saves session to `~/.kiro/skills/ssdf-manager/.session.json`

Non-interactive alternative:
```
python3 scripts/select-profile.py --profile gov-admin --pipeline hcom-release-pipeline
```

### Step 2: Scan Report

The primary workflow — consolidated view of all security findings with override status.

```
> 2  (Scan Report)
```

The script:
1. Lists recent scan runs (most recent first)
2. You select a scan run by number
3. Downloads source ZIP to `temp/` for AI analysis (auto-cleaned on exit)
4. Loads all scanner reports (semgrep, kics, trivy, checkov, gitleaks) from S3
5. Loads `finding-overrides.json` from S3
6. Displays paginated table with color-coded severity and inline override status

#### Scan Report Display

```
📊 Scan Report — v1_69_13  (2026-05-01 11:54)
   Total: 165  |  Active: 162  |  Overridden: 3

   HIGH           19  (2 overridden)
   MEDIUM         75  (1 overridden)
   LOW            40

   Page 1 of 7  (findings 1-25 of 165)
┌─────┬──────────┬─────────┬──────────────────────────┬─────────────────────────┬──────────────────┐
│   # │ Severity │ Scanner │ Rule                     │ File                    │ Override         │
├─────┼──────────┼─────────┼──────────────────────────┼─────────────────────────┼──────────────────┤
│   1 │ HIGH     │ kics    │ CMK Unencrypted Storage  │ HCOM-CF-Platform-Dev... │                  │
│   2 │ HIGH     │ kics    │ CMK Unencrypted Storage  │ HCOM-CF-Platform-Dev... │ ✅ FP (exp 2027) │
│   3 │ HIGH     │ kics    │ DB Security Group Open   │ HCOM-Ops-Foundation...  │                  │
└─────┴──────────┴─────────┴──────────────────────────┴─────────────────────────┴──────────────────┘
[n]ext [p]rev [d N]etail [a N]i review [o N,N]verride [q]uit
>
```

#### Interactive Commands

| Command | Action |
|---------|--------|
| `n` | Next page |
| `p` | Previous page |
| `d 3` | Detail view for finding #3 — full rule, file path, line, description, source code context |
| `a 3` | AI review for finding #3 — AI analyzes source code and recommends classification |
| `o 1,3,5-7` | Select findings for override — outputs JSON for manage-overrides |
| `q` | Quit |

#### Detail View

Shows full finding information and source code context (when source ZIP is available):

```
🔍 Finding Detail — #3
   Scanner:     kics
   Rule:        DB Security Group Open To Large Scope
   Severity:    HIGH
   File:        infrastructure/cloudformation/HCOM-Ops-Foundation-Template.yml
   Line:        847
   Description: Security group allows unrestricted access to a database...

   Source context (HCOM-Ops-Foundation-Template.yml:847):
      842 |       SecurityGroupIngress:
      843 |         - IpProtocol: tcp
      844 |           FromPort: 5432
      845 |           ToPort: 5432
   >>> 847 |           CidrIp: 10.0.0.0/16
      848 |           Description: PostgreSQL from VPC
```

#### AI Review

When you select `a N`, the AI:
1. Reads the source file at the flagged line from `temp/source/`
2. Reads the project context (`.ssdf-context.json`) for architecture and compensating controls
3. Analyzes whether the finding is a real vulnerability or mitigated
4. Recommends: `false_positive`, `accepted_risk`, or `needs_remediation`
5. Provides a draft justification you can accept, edit, or reject

```
🤖 AI Review — Finding #3

   Recommendation: false_positive
   Justification: Security group ingress restricted to VPC CIDR 10.0.0.0/16 only.
   Scanner flagged as "open to large scope" but the CIDR is the private VPC range,
   not public internet. Compensating controls: NACL restricts database port to
   application subnet, SCP blocks public security group rules.

   Accept this classification? (y/n/edit)
```

The AI never auto-overrides — you must explicitly accept every recommendation.

### Step 3: Manage Overrides

CRUD operations on `finding-overrides.json` in S3.

```
> 3  (Manage Overrides)
```

#### List Current Overrides

```
python3 scripts/manage-overrides.py list
```

Shows all overrides with expiration status: ✅ active, ⚠️ expiring within 30 days, ❌ expired.

#### Add Overrides

After selecting findings in the scan report (`o 1,3`), pipe the JSON output:

```
python3 scripts/scan-report.py --select "1,3" | python3 scripts/manage-overrides.py add
```

The script prompts for:
- Disposition: `false_positive` or `accepted_risk`
- Justification: mandatory explanation
- Expiration: ISO date (must be future)

On submit:
1. Writes override to `finding-overrides.json` in S3
2. Suppresses finding in Security Hub (`Workflow.Status: SUPPRESSED`)
3. Logs audit event to CloudWatch

#### Update an Override

```
python3 scripts/manage-overrides.py update --index 3
```

#### Remove an Override

```
python3 scripts/manage-overrides.py remove --index 1
```

#### Dry Run

All write operations support `--dry-run` to preview without writing:

```
python3 scripts/manage-overrides.py --dry-run add
```

### Step 4: View Change Log

Query the CloudWatch audit trail for all override changes.

```
> 4  (View Change Log)
```

Shows: timestamp, event type (create/update/delete), tool, rule, file, disposition, approved by.

```
python3 scripts/view-changelog.py --days 30
```

## Project Context

On first use, the AI generates a project context file at `~/.kiro/skills/ssdf-manager/.ssdf-context.json`. This captures:

- Architecture summary (resource types, templates, encryption posture)
- Compensating controls (SCPs, NACLs, network isolation)
- Source hash for change detection

On subsequent sessions, if the source hasn't changed (same ZIP hash), the AI reuses the existing context — no re-scan needed. If the source changed, the AI regenerates the context automatically.

Force refresh: `python3 scripts/generate-context.py --source-dir temp/source/ --refresh`

## Session Cleanup

Source files downloaded to `temp/` are automatically deleted when the scan-report script exits (normal exit, Ctrl+C, or error). The `--no-cleanup` flag keeps files for debugging.

Files that persist between sessions:
- `~/.kiro/skills/ssdf-manager/.session.json` — profile and pipeline context
- `~/.kiro/skills/ssdf-manager/.ssdf-context.json` — project architecture context

## Non-Interactive Usage

All scripts accept `--profile` and `--pipeline` for fully non-interactive operation:

```bash
# List overrides
python3 scripts/manage-overrides.py list --profile gov-admin --pipeline hcom-release-pipeline

# Select findings and output JSON
python3 scripts/scan-report.py --profile gov-admin --pipeline hcom-release-pipeline --select "1,3,5"

# View changelog
python3 scripts/view-changelog.py --profile gov-admin --pipeline hcom-release-pipeline --days 7
```

## Security Notes

- All AWS API calls use your IAM profile credentials — no credentials stored or cached
- Session and context files have restricted permissions (0600 on Unix, user ACL on Windows)
- Source files in `temp/` have restricted permissions (0700 on Unix, user ACL on Windows)
- Every override change is logged to CloudWatch with your IAM identity from `sts:GetCallerIdentity`
- CloudTrail captures all S3 and Security Hub API calls automatically
- Do not include CUI or classified references in justification text
