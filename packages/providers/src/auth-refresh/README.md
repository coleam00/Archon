# BDC provider OAuth refresh

This module exists because of `WO-HARNESS-PROVIDER-OAUTH-REFRESH-01`.

The 2026-05-15 Cauldron auth audit found that upstream Archon classifies Claude and Codex `401` errors as `auth` and then marks them non-retryable. That is reasonable for API-key deployments, but BDC runs Cauldron on subscription OAuth auth. Access tokens expire during normal unattended use, so the provider layer must refresh from the existing credential files and retry once.

## Providers

Claude:

- Refresh endpoint: `POST https://platform.claude.com/v1/oauth/token`
- Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- Body format: JSON
- Credentials path: `~/.claude/.credentials.json`

Codex:

- Refresh endpoint: `POST https://auth.openai.com/oauth/token`
- Client ID: public OAuth client ID embedded in `codex.ts`
- Body format: `application/x-www-form-urlencoded`
- Credentials path: `~/.codex/auth.json`

Both providers use OAuth refresh-token rotation: a successful refresh returns a new refresh token and invalidates the previous one. Any verification that calls the refresh endpoint must atomically write the returned credentials back to disk.

## Safety rules

- Never log access tokens, refresh tokens, ID tokens, request bodies, raw credential file contents, or raw OAuth response bodies.
- Preserve all unrelated credential fields. For Claude, `mcpOAuth` is intentionally untouched.
- Write credentials with temp-file, fsync, rename, and chmod `0600`.
- Use the lock file (`~/.claude/.refresh.lock` or `~/.codex/.refresh.lock`) so concurrent workflows make one refresh call per window.
- Do not add API-key fallback. It is intentionally forbidden for BDC Cauldron cost control.

Behavior source of truth: `BDC_XO/docs/behavior-specs/CAULDRON_PROVIDER_OAUTH_REFRESH_BEHAVIOR.md`.

Evidence and discovered constants: `BDC_XO/docs/plans/2026-05-15-cauldron-auth-audit-and-fix-proposal.md`.
