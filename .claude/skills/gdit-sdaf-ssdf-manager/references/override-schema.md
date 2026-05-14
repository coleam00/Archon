# finding-overrides.json Schema

**Location**: `s3://{artifact_bucket}/manifests/finding-overrides.json`
**Consumed by**: `correlate.py` in the Security Validation buildspec
**Managed by**: `ssdf-manager` skill scripts

## Schema

```json
{
  "version": "1.0",
  "overrides": [
    {
      "finding_id": "pipeline-name/sha256hash...",
      "tool": "kics",
      "rule": "022f8938-4b17-420c-aca3-f917f290f322",
      "file": "SSDF-Release-Pipeline.yml",
      "disposition": "false_positive",
      "justification": "Security group restricted by NACL and SCP",
      "approved_by": "arn:aws-us-gov:iam::123456789012:user/tom.moore",
      "approved_date": "2026-04-30",
      "expires": "2027-04-30"
    }
  ]
}
```

## Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `finding_id` | string | yes | Deterministic hash: `${PipelineName}/sha256(tool\|rule\|file\|line)` |
| `tool` | string | yes | Scanner name: semgrep, kics, trivy, checkov, gitleaks |
| `rule` | string | yes | Scanner rule/check ID |
| `file` | string | yes | Source file path relative to repo root |
| `disposition` | string | yes | `false_positive` or `accepted_risk` |
| `justification` | string | yes | Non-empty explanation for the override decision |
| `approved_by` | string | yes | IAM ARN of the approver |
| `approved_date` | string | yes | ISO date of approval (YYYY-MM-DD) |
| `expires` | string | yes | ISO date when override expires (YYYY-MM-DD) |

## Matching Logic (correlate.py)

The pipeline matches findings against overrides using two methods:
1. Exact `finding_id` match (preferred — deterministic hash)
2. `tool` + `rule` + `file` combination (broader suppression)

## Finding ID Generation

```python
import hashlib
finding_id = f"{pipeline_name}/{hashlib.sha256(f'{tool}|{rule}|{file}|{line}'.encode()).hexdigest()}"
```

This must match the hash generation in `correlate.py` exactly.

## Expiration

- Overrides with `expires` date in the past are ignored by the pipeline
- Expired overrides remain in the file until manually removed
- The `ssdf-manager` skill displays expiration status: ✅ active, ⚠️ within 30 days, ❌ expired
