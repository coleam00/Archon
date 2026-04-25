---
description: Review secrets, permissions, auth, and data exposure changes
argument-hint: <PR number, branch, or security-sensitive change>
---

# Security Secrets And Permissions Review

**Input**: $ARGUMENTS

---

## Mission

Review secrets handling, permission boundaries, auth behavior, and data exposure.

## Process

1. Inspect changed code and configuration for credentials, environment variables, tokens, permissions, and data flows.
2. Check whether least privilege is preserved.
3. Write `$ARTIFACTS_DIR/security/secrets-permissions-review.md`.

## Artifact Format

```markdown
# Secrets And Permissions Review

## Verdict

## Secrets Handling

## Permission Boundaries

## Data Exposure

## Auditability

## Required Fixes
```

## Output

Return the verdict and artifact path.
