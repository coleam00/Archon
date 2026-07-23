# Investigation: Improve cloud deployment documentation

**Issue**: #1168 (https://github.com/coleam00/Archon/issues/1168)
**Type**: DOCUMENTATION
**Investigated**: 2026-04-21

### Assessment

| Metric | Value | Reasoning |
|---|---|---|
| Priority | LOW | The VPS guide is already substantially complete; one incorrect auth snippet causes a localized setup failure. |
| Complexity | LOW | The fix is one documentation file and one example, with no runtime integration changes. |
| Confidence | HIGH | The issue is reproducible from the unescaped `$` example and contradicted by the escaped `.env.example` guidance. |

## Problem Statement

The cloud VPS guide already provides the manual Docker Compose deployment path and instructs operators to edit the repository `.env` directly rather than run `archon setup`. However, the Docker form-auth walkthrough still shows an unescaped bcrypt hash. Docker Compose interpolates `$` characters, so following that example can silently break authentication.

## Analysis

### Root Cause / Change Rationale

The canonical form-auth walkthrough in `packages/docs-web/src/content/docs/deployment/docker.md` tells users to set `AUTH_PASSWORD_HASH=$2b$12$REPLACE_WITH_YOUR_HASH`. Compose treats `$...` as interpolation syntax. The repository `.env.example` and basic-auth examples already correctly escape each dollar sign as `$$`, but the form-auth walkthrough was not updated.

### Evidence Chain

WHY: Form authentication can fail when users follow the documented walkthrough.
↓ BECAUSE: The documented bcrypt hash contains single `$` characters.
Evidence: `packages/docs-web/src/content/docs/deployment/docker.md:349-355`.

↓ BECAUSE: Docker Compose interpolates `$` values before passing environment values to the container.
Evidence: The same page's basic-auth example at `docker.md:307-311` and `.env.example:271-274` use `$$` and warn about Compose interpolation.

↓ ROOT CAUSE: The form-auth example is missing escaped dollar signs and an explicit warning.

### Affected Files

| File | Lines | Action | Description |
|---|---:|---|---|
| `packages/docs-web/src/content/docs/deployment/docker.md` | 349-355 | UPDATE | Escape every `$` in the form-auth hash and explain why. |

## Implementation Plan

### Step 1: Correct the form-auth environment example

**File**: `packages/docs-web/src/content/docs/deployment/docker.md`

Change `AUTH_PASSWORD_HASH=$2b$12$REPLACE_WITH_YOUR_HASH` to `AUTH_PASSWORD_HASH=$$2b$$12$$REPLACE_WITH_YOUR_HASH`, followed by a sentence stating that every `$` must be written as `$$` because Docker Compose performs variable interpolation.

### Step 2: Validate documentation consistency

Confirm the updated snippet matches the escaped examples in `.env.example`, `Caddyfile.example`, and the basic-auth section. Run the docs package checks or repository validation available in this checkout.

## Patterns to Follow

Use the existing basic-auth guidance in `packages/docs-web/src/content/docs/deployment/docker.md:307-311`:

```ini
# CADDY_BASIC_AUTH=basicauth @protected { admin $$2a$$14$$... }
```

The repository `.env.example:271-274` also explicitly documents Compose escaping.

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|---|---|
| Users copy a hash with additional `$` segments | Tell users to escape every `$`, not only the prefix. |
| Duplicating the full Docker guide into cloud docs creates drift | Keep the fix narrow; retain the existing cross-link and single maintained Docker reference. |

## Validation

```bash
bun run format:check
bun run lint
```

Manual verification: grep the form-auth example and confirm it contains `$$` for every bcrypt `$` segment and an interpolation warning.

## Scope Boundaries

**IN SCOPE:** Correct the Docker form-auth documentation example and explain Compose escaping.

**OUT OF SCOPE:** Runtime auth changes, CLI setup behavior, duplicating the Docker guide into the cloud page, or unrelated deployment refactors.

## Metadata

- **Investigated by**: Claude
- **Artifact**: `.claude/PRPs/issues/issue-1168.md`
