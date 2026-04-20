# Plan Context

**Generated**: 2026-04-11 15:07
**Workflow ID**: 0418384099496c28f417ca14462edd63
**Plan Source**: `/.archon/workspaces/NewTurn2017/archon-test-landingpage/artifacts/runs/0418384099496c28f417ca14462edd63/plan.md`

---

## Branch

| Field                      | Value                                |
| -------------------------- | ------------------------------------ |
| **Branch**                 | `archon/thread-dcddc656`             |
| **Derived Feature Branch** | `feature/archon-korean-landing-page` |
| **Base**                   | `main`                               |

---

## Plan Summary

**Title**: Archon Korean Landing Page

**Overview**: Build a Korean-language Archon landing page in a repository that currently has no app code by bootstrapping a minimal Next.js 16 App Router project first. The final scope is a polished, futuristic, minimalist single-page experience with concise Korean copy, metadata, responsive styling, and baseline validation.

---

## Files to Change

| File                                  | Action                           |
| ------------------------------------- | -------------------------------- |
| `package.json`                        | CREATE                           |
| `tsconfig.json`                       | CREATE                           |
| `next.config.ts` or `next.config.mjs` | CREATE if needed                 |
| `eslint.config.mjs`                   | CREATE                           |
| `next-env.d.ts`                       | CREATE                           |
| `app/layout.tsx`                      | CREATE                           |
| `app/page.tsx`                        | CREATE                           |
| `app/globals.css`                     | CREATE                           |
| `public/og-image.png`                 | CREATE if included               |
| `public/brand-mark.svg`               | CREATE                           |
| `tests/landing.spec.ts`               | CREATE if Playwright is included |
| `playwright.config.ts`                | CREATE if Playwright is included |

---

## NOT Building (Scope Limits)

**CRITICAL FOR REVIEWERS**: These items are **intentionally excluded** from scope. Do NOT flag them as bugs or missing features.

- Full multi-page marketing site or blog: out of scope because the request is for a concise landing page with minimal information architecture.
- CMS integration or localization framework: out of scope because only one Korean page is requested.
- Backend forms, analytics, or authentication: out of scope unless a CTA destination requires them.
- Complex animation libraries: out of scope; use CSS-only motion to preserve minimalism and keep dependencies light.

---

## Validation Commands

```bash
npm run lint
npm run build
npx playwright test
npm run dev
```

---

## Acceptance Criteria

- [ ] A Next.js App Router project exists in the repository and installs cleanly
- [ ] `/` renders a Korean-language Archon landing page with hero, explanation, value section, and CTA
- [ ] Visual design is minimalist, futuristic, and responsive on mobile and desktop
- [ ] Metadata is configured for title, description, and social sharing
- [ ] Validation commands pass with exit 0 for lint and build
- [ ] If Playwright is included, smoke tests pass without flaky selectors
- [ ] Information architecture stays intentionally sparse and uncluttered

---

## Patterns to Mirror

| Pattern                                | Source File                    | Lines                                       |
| -------------------------------------- | ------------------------------ | ------------------------------------------- |
| Placeholder repo state                 | `README.md`                    | `1-3`                                       |
| Next.js App Router bootstrap structure | Next.js installation docs      | `app/layout.tsx`, `app/page.tsx`, `public/` |
| Root layout font wiring shape          | Next.js font optimization docs | example shown in plan                       |
| Static metadata export shape           | Next.js metadata docs          | example shown in plan                       |
| ESLint CLI script shape                | Next.js linting docs           | example shown in plan                       |

---

## Repo Notes

- Repository owner/name inferred from `origin`: `NewTurn2017/archon-test-landingpage`
- `gh repo view` could not be used because the local GitHub CLI is unauthenticated (`HTTP 401`)
- Current worktree branch is clean and already up to date with `origin/main` (`git rev-list --left-right --count HEAD...origin/main` returned `0 0`)

---

## Next Steps

1. `archon-confirm-plan` - Verify referenced patterns and assumptions still hold
2. `archon-implement-tasks` - Execute the implementation plan
3. `archon-validate` - Run lint, build, and any chosen smoke validation
4. `archon-finalize-pr` - Prepare the PR once implementation is complete
