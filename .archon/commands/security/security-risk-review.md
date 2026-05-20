---
description: Review a change for security risk, required signoff, and acceptance criteria
argument-hint: <PR number, issue, implementation plan, or diff summary>
---

# Security Risk Review

**Input**: $ARGUMENTS

---

## Mission

Identify security risk before merge or release. Be evidence-driven. Do not clear risky changes without a documented reason.

## Security Review Triggers

Review is required for changes involving:

- Authentication or authorization
- Permissions or privilege boundaries
- Secrets or tokens
- Payments
- PII or customer data
- Audit logs
- Infrastructure or IaC
- Dependency or supply-chain changes
- Public APIs
- Webhooks
- File upload or download
- Admin features
- External network calls
- Any label: `security-review`, `release-risk`, `customer-data`, `auth`

## Process

1. Read product, design, development, and QA artifacts if present.
2. Inspect the diff, dependencies, config, APIs, data handling, auth paths, and infra changes.
3. Classify risk as `low`, `medium`, or `high`.
4. Write `$ARTIFACTS_DIR/security/security-review.md`.

## Artifact Format

```markdown
# Security Review

## Verdict

Clear / Needs fixes / Requires risk acceptance / Blocked

## Risk Level

Low / Medium / High

## Triggered Review Areas

## Findings

| Severity | Area | Evidence | Required Action |
|----------|------|----------|-----------------|

## Required Fixes

## Required Approvals

## Compensating Controls

## Residual Risk
```

## Output

Return the verdict, risk level, and artifact path.
