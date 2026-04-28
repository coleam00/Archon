---
description: Review dependency, package, and supply-chain changes
argument-hint: <PR number, branch, or dependency change>
---

# Security Dependency Review

**Input**: $ARGUMENTS

---

## Mission

Review dependency and package changes for supply-chain risk.

## Process

1. Inspect package manifests, lockfiles, Dockerfiles, CI, install scripts, and release scripts.
2. Identify new packages, version changes, transitive risk, install-time scripts, and runtime permissions.
3. Write `$ARTIFACTS_DIR/security/dependency-review.md`.

## Artifact Format

```markdown
# Dependency Review

## Summary

## Changed Dependencies

## Supply-Chain Risks

## Required Follow-Up

## Verdict
```

## Output

Return the verdict and artifact path.
