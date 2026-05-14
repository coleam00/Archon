---
name: ssdf-manager
description: "Manage SSDF pipeline finding overrides stored in S3. Use when the user wants to browse pipeline scan runs, review scanner findings, mark findings as false positives or accepted risks, manage the finding-overrides.json file, suppress findings in Security Hub, or view the override audit change log. Triggers on: manage overrides, finding overrides, false positive, accepted risk, ssdf manager, override findings, browse scans, scan results, suppress finding."
license: MIT
compatibility: Requires Python 3.12+, boto3>=1.34.0, AWS CLI profile with Security Hub and S3 access.
metadata:
  author: GDIT Platform Team
  version: "1.0.0"
  category: security
  tags: ssdf, security-hub, overrides, compliance, findings, pipeline
  python_version: ">=3.12"
---

# SSDF Manager

Terminal-based management of `finding-overrides.json` for SSDF release pipelines. Browse scan runs, review scanner findings, promote findings to overrides with disposition and justification, suppress in Security Hub, and maintain an immutable audit trail in CloudWatch.

## Platform Requirements

- Python 3.12+
- boto3>=1.34.0 (declared via PEP 723 inline metadata)
- AWS CLI profile with access to the pipeline's S3 artifact bucket and Security Hub

## Workflow

```
1. Select Profile & Pipeline  →  Validates AWS creds, discovers pipeline artifact bucket
2. Scan Report                →  Paginated findings table with override status, detail view, AI review
3. Manage Overrides           →  CRUD on finding-overrides.json (add/list/update/remove)
4. View Change Log            →  Queries CloudWatch audit log for override history
```

The manager should run kiro-cli from an empty working directory. The skill downloads source files to `temp/` for AI analysis and cleans up automatically on exit.

Say "load ssdf-manager skill" for the interactive menu. See `MENU.yaml` for workflow definitions.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/select-profile.py` | AWS profile selection and pipeline discovery |
| `scripts/scan-report.py` | Rich paginated scan report with detail view, AI review trigger, source download |
| `scripts/manage-overrides.py` | CRUD operations on finding-overrides.json with Security Hub suppression and audit logging |
| `scripts/view-changelog.py` | Query CloudWatch Logs for override change history |
| `scripts/generate-context.py` | Generate/update project context for AI fast-track analysis |
| `scripts/browse-scans.py` | List scan runs and scanner reports from S3 (standalone) |
| `scripts/review-findings.py` | Parse and display findings from a single scanner report (standalone) |

All scripts accept `--profile PROFILE_NAME` to override the session profile. Without it, they read from `.session.json` in the skill directory.

All scripts also accept `--pipeline PIPELINE_NAME`. When both `--profile` and `--pipeline` are provided, the script builds a session on the fly without requiring `select-profile.py` first. This enables fully non-interactive one-liners:

```
python3 ~/.kiro/skills/ssdf-manager/scripts/manage-overrides.py list --profile gov-admin --pipeline hcom-release-pipeline
python3 ~/.kiro/skills/ssdf-manager/scripts/browse-scans.py --profile gov-admin --pipeline hcom-release-pipeline
```

## Override File Schema

See `references/override-schema.md` for the complete `finding-overrides.json` schema. Key fields per entry:

- `finding_id` — deterministic hash: `${PipelineName}/sha256(tool|rule|file|line)`
- `disposition` — `false_positive` or `accepted_risk`
- `justification` — mandatory, non-empty explanation
- `expires` — ISO date, must be future; expired overrides are ignored by the pipeline

## IAM Permissions Required

The SSDF manager's AWS profile needs:

- `sts:GetCallerIdentity` — profile validation
- `s3:ListAllMyBuckets` — pipeline discovery
- `s3:ListBucket`, `s3:GetObject` — read scan reports and overrides
- `s3:PutObject` on `manifests/finding-overrides.json` — write overrides
- `securityhub:BatchUpdateFindings` — suppress findings
- `logs:CreateLogStream`, `logs:PutLogEvents` — audit logging
- `logs:StartQuery`, `logs:GetQueryResults` — view changelog

## Security

- No network endpoints created — all operations via AWS SDK with existing IAM credentials
- No credentials stored or cached beyond the AWS CLI profile reference
- All mutations logged to CloudWatch with IAM identity from `sts:GetCallerIdentity`
- CloudTrail captures every S3 and Security Hub API call automatically
- NIST 800-171 compliant: AC.L2-3.1.1, AU.L2-3.3.1, SC.L2-3.13.1

## Anti-Patterns

- Do not edit `finding-overrides.json` manually in S3 — use `manage-overrides.py` for audit trail
- Do not skip justification — pipeline requires non-empty justification
- Do not set past expiration dates — pipeline ignores expired overrides
- Do not create overrides without reviewing the finding first
- Do not include CUI, classified references, or sensitive system names in justification text — justifications are logged to CloudWatch and stored in S3

## References

See `references/user-guide.md` for the complete end-to-end workflow with examples.
See `references/override-schema.md` for the `finding-overrides.json` schema.

## Prerequisites

This skill requires GDIT-SDAF to be set up. Run once per machine:

```
archon workflow run gdit-sdaf-setup
```

After setup, scripts are available at `~/.kiro/skills/ssdf-manager/scripts/`.
