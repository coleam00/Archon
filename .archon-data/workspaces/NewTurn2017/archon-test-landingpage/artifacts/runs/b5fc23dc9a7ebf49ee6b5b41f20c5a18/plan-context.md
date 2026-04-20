# Plan Context

**Generated**: 2026-04-11 15:49
**Workflow ID**: b5fc23dc9a7ebf49ee6b5b41f20c5a18
**Plan Source**: `/.archon/workspaces/NewTurn2017/archon-test-landingpage/artifacts/runs/b5fc23dc9a7ebf49ee6b5b41f20c5a18/plan.md`

---

## Branch

| Field                    | Value                                 |
| ------------------------ | ------------------------------------- |
| **Branch**               | `archon/thread-c0ecfe02`              |
| **Base**                 | `main`                                |
| **Derived Title Branch** | `feature/korean-archon-landing-page`  |
| **Repo**                 | `NewTurn2017/archon-test-landingpage` |

---

## Plan Summary

**Title**: Korean Archon Landing Page

**Overview**: Build a production-ready Korean marketing landing page for Archon in a currently minimal repository by recreating the established adjacent React + Vite scaffold, then replacing the placeholder experience with a Korean-first single-page site. The page should clearly position Archon as an intelligent coding assistant and project orchestrator, highlight capabilities and workflow, stay responsive on desktop/mobile, and ship with build validation.

---

## Files to Change

| File                 | Action         |
| -------------------- | -------------- |
| `package.json`       | CREATE         |
| `tsconfig.json`      | CREATE         |
| `tsconfig.app.json`  | CREATE         |
| `vite.config.ts`     | CREATE         |
| `index.html`         | CREATE         |
| `src/main.tsx`       | CREATE         |
| `src/App.tsx`        | CREATE         |
| `src/styles.css`     | CREATE         |
| `public/favicon.svg` | CREATE or COPY |
| `README.md`          | UPDATE         |

---

## NOT Building (Scope Limits)

**CRITICAL FOR REVIEWERS**: These items are **intentionally excluded** from scope. Do NOT flag them as bugs or missing features.

From `NOT_BUILDING (explicit scope limits)`:

- No language switcher or locale routing.
- No pricing calculator, signup form backend, or analytics integration.
- No CMS or markdown content pipeline.
- No animation library or video background dependency.

From `NOT Building (Scope Limits)`:

- No user authentication, dashboard, or product application shell.
- No external API calls; all landing-page content remains static.
- No automated unit test suite unless the repo later adds a test runner.
- No full design-system abstraction beyond what the landing page itself needs.

---

## Validation Commands

```bash
npm install
npm run build
npm run preview -- --host 0.0.0.0
```

---

## Acceptance Criteria

- [ ] Current branch gains a working React + Vite app scaffold
- [ ] `/` renders a complete Korean landing page describing Archon as an intelligent coding assistant and project orchestrator
- [ ] Page includes value proposition, key capabilities, workflow explanation, and final CTA
- [ ] `index.html` uses Korean document metadata and proper root mounting structure
- [ ] Styling is polished and responsive on desktop and mobile
- [ ] `npm run build` passes with exit 0
- [ ] Implementation mirrors observed project patterns: one page entry component, one global stylesheet, plain CSS tokens, array-driven repeated content

---

## Patterns to Mirror

| Pattern                                                        | Source File                                                                                               | Lines   |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------- |
| Array-driven page content and top-level `App` structure        | `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/App.tsx`    | 1-13    |
| Static JSX-only landing page, no async/error abstraction       | `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/App.tsx`    | 13-85   |
| React bootstrap with `StrictMode` and global stylesheet import | `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/main.tsx`   | 1-10    |
| HTML shell and metadata placement                              | `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/index.html`     | 1-20    |
| Vite scripts convention                                        | `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/package.json`   | 6-10    |
| Tokenized CSS foundation                                       | `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/styles.css` | 1-13    |
| Shared surface/card treatment                                  | `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/styles.css` | 56-65   |
| Responsive breakpoint pattern                                  | `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/styles.css` | 187-208 |

---

## Additional Extracted Context

**Mandatory reading before implementation**

- `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/App.tsx` lines 1-85
- `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/styles.css` lines 1-208
- `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/main.tsx` lines 1-10
- `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/index.html` lines 1-20
- `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/package.json` lines 1-22
- `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-c0ecfe02/README.md` lines 1-3

**Implementation shape**

- Recreate a minimal React 18 + Vite 5 scaffold in the current branch.
- Keep architecture intentionally small: one React entry, one page entry component, one global stylesheet.
- Use static Korean content with semantic sections and in-page anchors only.
- Prefer local arrays plus `.map()` for repeated capability, workflow, and proof blocks.

**Edge cases to validate**

- Long Korean headlines do not overflow or produce awkward wrapping.
- All mapped lists use stable semantic keys.
- CTA links target existing section IDs.
- Layout remains usable at `320px` width.
- `lang="ko"` and Korean metadata are present in `index.html`.
- Favicon path resolves in development and preview.

---

## Next Steps

1. `archon-confirm-plan` - Verify mirrored patterns and referenced files still exist.
2. `archon-implement-tasks` - Create the scaffold and landing page files described by the plan.
3. `archon-validate` - Run install, build, preview, and responsive verification.
4. `archon-finalize-pr` - Create the PR and mark it ready after validation.
