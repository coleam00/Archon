# Feature: Korean Archon Landing Page

## Summary

Build a production-ready Korean marketing landing page for Archon in a currently minimal repository. The implementation should recreate the existing React + Vite scaffold patterns already established in the adjacent project worktree, then replace the placeholder English landing page with a Korean-first experience that explains Archon as an intelligent coding assistant and project orchestrator, highlights core workflows and capabilities, and ships with responsive layout, polished visual treatment, and build validation.

## User Story

As a Korean-speaking developer or technical decision-maker
I want to understand what Archon does, why it is valuable, and how its workflow operates
So that I can quickly evaluate it as a coding assistant and project orchestration product

## Problem Statement

The current branch contains only `README.md` and does not expose any product UI, product messaging, or frontend build pipeline. Users cannot learn what Archon is, assess its value, or interact with a presentable landing page, and the branch cannot currently produce a deployable marketing surface.

## Solution Statement

Create a minimal React 18 + Vite 5 app in this branch using the already-observed scaffold pattern from the adjacent worktree, then implement a single-page Korean landing page with semantic sections, data-driven repeated content blocks, centralized plain-CSS styling, and metadata updates in `index.html`. Keep the architecture intentionally small: one React entry, one page entry component, one global stylesheet, and only static content plus in-page anchors.

## Metadata

| Field            | Value                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Type             | NEW_CAPABILITY                                                                                                                                |
| Complexity       | MEDIUM                                                                                                                                        |
| Systems Affected | frontend bootstrap, page composition, metadata/SEO, global styles, build tooling                                                              |
| Dependencies     | react@^18.3.1, react-dom@^18.3.1, @types/react@^18.3.3, @types/react-dom@^18.3.0, @vitejs/plugin-react@^4.3.1, typescript@^5.5.4, vite@^5.4.2 |
| Estimated Tasks  | 7                                                                                                                                             |

---

## UX Design

### Before State

```text
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              BEFORE STATE                                    ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   Git branch root                                                             ║
║   ┌─────────────────────┐                                                     ║
║   │ README only         │                                                     ║
║   │ no package.json     │                                                     ║
║   │ no src/             │                                                     ║
║   │ no index.html       │                                                     ║
║   └─────────────────────┘                                                     ║
║                                                                               ║
║   USER_FLOW: User opens repository/branch and sees no product page.           ║
║   PAIN_POINT: No UI, no Korean content, no deployable artifact, no CTA.       ║
║   DATA_FLOW: None beyond static README text.                                  ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```text
╔═══════════════════════════════════════════════════════════════════════════════╗
║                               AFTER STATE                                    ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   index.html                                                                  ║
║        │                                                                      ║
║        ▼                                                                      ║
║   src/main.tsx ─────► src/App.tsx ─────► Korean landing sections              ║
║        │                         │                                             ║
║        │                         ├── Hero: Archon positioning + CTA           ║
║        │                         ├── Capability grid                          ║
║        │                         ├── Workflow timeline                        ║
║        │                         ├── Proof/value section                      ║
║        │                         └── Final CTA                                ║
║        ▼                                                                      ║
║   src/styles.css provides tokens, layout, responsiveness, and polish          ║
║                                                                               ║
║   USER_FLOW: User lands on page, understands product, scans workflows,        ║
║   compares value, and follows primary CTA.                                    ║
║   VALUE_ADD: Clear Korean messaging, modern presentation, mobile readiness.   ║
║   DATA_FLOW: Static content arrays in App.tsx map into repeated UI sections.  ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location         | Before                             | After                                             | User Impact                                             |
| ---------------- | ---------------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| `/`              | No app route exists in this branch | Korean landing page renders immediately           | Users can understand Archon without reading source code |
| `index.html`     | No HTML entry in branch            | Korean `lang`, title, description, favicon wiring | Better SEO/accessibility and correct document language  |
| `src/App.tsx`    | No page component in branch        | Product narrative, workflow sections, CTA anchors | Users can scan value, capabilities, and workflows       |
| `src/styles.css` | No styles in branch                | Responsive, tokenized landing-page design         | Page feels polished on desktop and mobile               |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File                                                                                                      | Lines | Why Read This                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------ |
| P0       | `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/App.tsx`    | 1-85  | Existing landing-page section structure and array-driven rendering pattern to mirror |
| P0       | `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/styles.css` | 1-208 | Existing tokenized CSS, grid layout, and breakpoint pattern to preserve              |
| P1       | `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/main.tsx`   | 1-10  | React bootstrap pattern and global stylesheet import                                 |
| P1       | `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/index.html`     | 1-20  | HTML shell and metadata placement                                                    |
| P1       | `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/package.json`   | 1-22  | Dependency versions and script conventions                                           |
| P2       | `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-c0ecfe02/README.md`      | 1-3   | Confirms current branch is effectively empty and requires scaffold creation          |

**External Documentation:**

| Source                                                                                             | Section                                | Why Needed                                                                                                 |
| -------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [React 18.3 docs](https://18.react.dev/learn/rendering-lists#keeping-list-items-in-order-with-key) | `Keeping list items in order with key` | Repeated capability/workflow cards should keep stable keys when rendered from arrays                       |
| [React 18 docs](https://18.react.dev/reference/react/StrictMode)                                   | `StrictMode`                           | The bootstrap mirrors `React.StrictMode`; avoid effect-driven code that behaves differently in development |
| [Vite 5 docs](https://v5.vite.dev/guide/assets#the-public-directory)                               | `The public Directory`                 | Any favicon or static brand assets should be placed where Vite serves them without imports                 |
| [Vite 5 docs](https://v5.vite.dev/guide/build#public-base-path)                                    | `Public Base Path`                     | Prevent broken asset paths if the landing page is deployed under a nested base path                        |

---

## Patterns to Mirror

**NAMING_CONVENTION:**

```tsx
// SOURCE: /.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/App.tsx:1-13
// COPY THIS PATTERN:
const highlights = [
  "Fast static deployment with a tiny toolchain",
  "Clear sections for product positioning and conversion",
  "Responsive layout ready for deeper content work",
];

const metrics = [
  { value: "1 day", label: "to customize for a real offer" },
  { value: "3 blocks", label: "covering proof, pitch, and CTA" },
  { value: "0 guesswork", label: "about the app entry and build path" },
];

export default function App() {
```

**ERROR_HANDLING:**

```text
// SOURCE: /.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/App.tsx:13-85
// COPY THIS PATTERN:
The existing page is purely static JSX with no async work, no thrown errors,
and no client-side error state. Keep the landing page static and avoid adding
custom error abstractions unless a real runtime dependency is introduced.
```

**LOGGING_PATTERN:**

```text
// SOURCE: /.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/main.tsx:1-10
// COPY THIS PATTERN:
There is no console logging or logger utility in the current frontend scaffold.
Do not introduce runtime logging for a static marketing page.
```

**TEST_STRUCTURE:**

```json
// SOURCE: /.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/package.json:6-10
// COPY THIS PATTERN:
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "preview": "vite preview"
}
```

---

## Primitives Inventory

| Primitive                              | File:Lines                                     | Complete? | Role in Feature                                                                       |
| -------------------------------------- | ---------------------------------------------- | --------- | ------------------------------------------------------------------------------------- |
| Vite HTML entry shell                  | `thread-0fb99647/index.html:1-20`              | Partial   | Recreate in current branch and localize metadata                                      |
| React bootstrap with global CSS        | `thread-0fb99647/src/main.tsx:1-10`            | Yes       | Keep identical entry pattern                                                          |
| Monolithic landing-page root component | `thread-0fb99647/src/App.tsx:13-85`            | Partial   | Extend from placeholder English page to full Korean marketing page                    |
| Array-driven repeated content blocks   | `thread-0fb99647/src/App.tsx:1-11,37-44,63-66` | Yes       | Use for capabilities, workflow steps, and proof points                                |
| Global CSS token layer                 | `thread-0fb99647/src/styles.css:1-13`          | Partial   | Reuse tokenized styling approach with a stronger brand system                         |
| Shared glass/surface card treatment    | `thread-0fb99647/src/styles.css:56-65`         | Partial   | Reuse for section containers and stat cards                                           |
| Single responsive breakpoint           | `thread-0fb99647/src/styles.css:187-208`       | Partial   | Preserve mobile-first adaptation, likely with one additional narrow-screen refinement |

## Architecture Decisions

APPROACH_CHOSEN: Recreate the small Vite/React scaffold in the current branch and implement the landing page as a static single-page React app with data arrays, semantic sections, in-page anchor links, and one centralized stylesheet.

RATIONALE: The only concrete frontend pattern in this project is the adjacent scaffold worktree. It uses `index.html` + `src/main.tsx` + `src/App.tsx` + `src/styles.css`, plain CSS, and array-driven repeated sections. Matching that structure minimizes risk and avoids inventing routing, state management, CMS integration, or a component library that the codebase does not already have.

ALTERNATIVES_REJECTED:

- Introduce Next.js or another framework: rejected because the repository and existing scaffold already establish Vite + React, and adding SSR/routing would be unnecessary scope.
- Add Tailwind or CSS-in-JS: rejected because the existing pattern is plain global CSS with design tokens and section classes.
- Add i18n infrastructure: rejected because the requested output is one Korean page, not a multilingual product experience.
- Split immediately into many child components: rejected because the current pattern is one page component and the page can remain understandable if content arrays are organized cleanly.

NOT_BUILDING (explicit scope limits):

- No language switcher or locale routing.
- No pricing calculator, signup form backend, or analytics integration.
- No CMS or markdown content pipeline.
- No animation library or video background dependency.

---

## Files to Change

| File                 | Action         | Justification                                                                        |
| -------------------- | -------------- | ------------------------------------------------------------------------------------ |
| `package.json`       | CREATE         | Establish Vite/React dependency and script baseline in current branch                |
| `tsconfig.json`      | CREATE         | Mirror project reference pattern from scaffold                                       |
| `tsconfig.app.json`  | CREATE         | Enable strict TypeScript React compilation                                           |
| `vite.config.ts`     | CREATE         | Mirror minimal React plugin setup                                                    |
| `index.html`         | CREATE         | Add HTML entry shell, Korean metadata, root element                                  |
| `src/main.tsx`       | CREATE         | Bootstrap React app and global CSS                                                   |
| `src/App.tsx`        | CREATE         | Implement Korean landing page content and section structure                          |
| `src/styles.css`     | CREATE         | Implement tokenized responsive design system and layout                              |
| `public/favicon.svg` | CREATE or COPY | Preserve favicon path expected by `index.html`                                       |
| `README.md`          | UPDATE         | Replace placeholder repo description with run/build notes once implementation exists |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- No user authentication, dashboard, or product application shell.
- No external API calls; all landing-page content remains static.
- No automated unit test suite unless the repo later adds a test runner.
- No full design-system abstraction beyond what the landing page itself needs.

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: CREATE `package.json`, `tsconfig.json`, `tsconfig.app.json`, `vite.config.ts`

- **ACTION**: CREATE new files
- **IMPLEMENT**: Recreate the minimal Vite + React + TypeScript scaffold currently visible in `thread-0fb99647`
- **MIRROR**: `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/package.json:1-22`, `vite.config.ts:1-5`, `tsconfig.json:1-8`, `tsconfig.app.json:1-17`
- **IMPORTS**: `defineConfig` from `vite`, `react` from `@vitejs/plugin-react`
- **GOTCHA**: Keep dependency versions aligned with the discovered scaffold to avoid unnecessary version drift
- **VALIDATE**: `npm install`

### Task 2: CREATE `index.html` and `public/favicon.svg`

- **ACTION**: CREATE new files
- **IMPLEMENT**: Add Vite HTML shell with `#root`, Korean `lang`, localized `title`, localized meta description, and favicon reference
- **MIRROR**: `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/index.html:1-20`
- **IMPORTS**: None
- **GOTCHA**: If any future deployment uses a nested base path, asset references must remain compatible with Vite base-path rewriting
- **VALIDATE**: `npm run build`

### Task 3: CREATE `src/main.tsx`

- **ACTION**: CREATE new file
- **IMPLEMENT**: Bootstrap `App` through `ReactDOM.createRoot`, keep `React.StrictMode`, and import `./styles.css`
- **MIRROR**: `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/main.tsx:1-10`
- **IMPORTS**: `react`, `react-dom/client`, `./App`, `./styles.css`
- **GOTCHA**: Avoid side-effectful startup code; StrictMode in development can surface duplicate effects
- **VALIDATE**: `npm run build`

### Task 4: CREATE `src/App.tsx`

- **ACTION**: CREATE new file
- **IMPLEMENT**: Build a single-page Korean landing page using local arrays and `.map()` for repeated blocks. Include at minimum: hero, positioning/value statement, capability grid, workflow explanation, operator benefits/proof section, and final CTA.
- **MIRROR**: `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/App.tsx:1-85`
- **IMPORTS**: None beyond React JSX runtime defaults
- **GOTCHA**: Keys in mapped lists must be stable and semantic; do not use raw array index if a stable label/slug exists
- **VALIDATE**: `npm run build`

### Task 5: CREATE `src/styles.css`

- **ACTION**: CREATE new file
- **IMPLEMENT**: Define root design tokens, background treatment, section shells, typography, responsive grid/flex layouts, CTA styles, and mobile breakpoints for all landing sections
- **MIRROR**: `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/src/styles.css:1-208`
- **IMPORTS**: None
- **GOTCHA**: Preserve legible Korean typography and line-height; avoid over-condensed headline sizes that work in English but break with Korean copy
- **VALIDATE**: `npm run build`

### Task 6: UPDATE `README.md`

- **ACTION**: UPDATE existing file
- **IMPLEMENT**: Replace the placeholder description with actual project summary, requirements, and run/build instructions matching the created scaffold
- **MIRROR**: `/.archon/workspaces/NewTurn2017/archon-test-landingpage/worktrees/archon/thread-0fb99647/README.md:1-28`
- **IMPORTS**: None
- **GOTCHA**: Document only commands that actually exist in `package.json`
- **VALIDATE**: `cat README.md`

### Task 7: Validate desktop/mobile behavior and production output

- **ACTION**: VERIFY
- **IMPLEMENT**: Run build, preview locally, and inspect desktop/mobile layouts to confirm spacing, section order, CTA visibility, and Korean text wrapping
- **MIRROR**: Build flow implied by `thread-0fb99647/package.json:6-10`
- **IMPORTS**: None
- **GOTCHA**: Mobile issues are most likely around long Korean headings and card stacks; validate at narrow widths before sign-off
- **VALIDATE**: `npm run build && npm run preview -- --host 0.0.0.0`

---

## Testing Strategy

### Build and Smoke Tests to Perform

| Test Target              | Test Cases                                                         | Validates                                                          |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `npm run build`          | TypeScript compile + Vite production bundle                        | No type errors, import path issues, or invalid HTML/CSS references |
| Local preview in browser | Hero render, anchor links, CTA visibility, Korean copy readability | Real user experience matches intended layout                       |
| Responsive manual check  | Desktop, tablet, narrow mobile widths                              | Grid collapse, text wrapping, spacing, and CTA stacking            |

### Edge Cases Checklist

- [ ] Long Korean headlines do not overflow or create orphaned characters in critical sections
- [ ] All mapped lists use stable keys
- [ ] CTA links target existing section IDs
- [ ] Layout remains usable at `320px` width
- [ ] `lang="ko"` and Korean metadata are present in HTML
- [ ] Favicon path resolves in development and preview

---

## Validation Commands

### Level 1: BOOTSTRAP

```bash
npm install
```

**EXPECT**: Dependencies install successfully with no missing manifest/config files

### Level 2: STATIC_ANALYSIS_AND_BUILD

```bash
npm run build
```

**EXPECT**: Exit 0, TypeScript passes, Vite emits production bundle

### Level 3: RUNTIME_SMOKE

```bash
npm run preview -- --host 0.0.0.0
```

**EXPECT**: Built site serves locally and can be checked at desktop/mobile viewport sizes

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

## Completion Checklist

- [ ] All scaffold files created in dependency order
- [ ] Content implementation completed before style polish adjustments
- [ ] Build validation passed after each major file group
- [ ] README updated to reflect actual runnable project
- [ ] Final manual responsive review completed

---

## Risks and Mitigations

| Risk                                                                                           | Likelihood | Impact | Mitigation                                                                          |
| ---------------------------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------- |
| Current branch has no frontend files, so implementation could drift from the intended scaffold | MED        | HIGH   | Mirror the adjacent scaffold exactly for bootstrap files before customizing content |
| Korean copy length breaks layout tuned for English placeholder text                            | HIGH       | MED    | Use generous line-height, wider content containers, and explicit mobile checks      |
| Asset paths break if deployed under a nested base path                                         | LOW        | MED    | Follow Vite base-path guidance and avoid hardcoded dynamic asset concatenation      |
| Scope grows into multilingual/i18n or product-app concerns                                     | MED        | MED    | Keep implementation static and Korean-only; defer locale infrastructure             |
| Lack of automated tests hides regressions                                                      | MED        | LOW    | Use strict TypeScript build and manual preview smoke checks as release gate         |

---

## Notes

- There is no `CLAUDE.md` in the current branch.
- There are no existing tests, lint rules, logging utilities, API integrations, or component-library abstractions in the repository.
- The current branch itself does not contain the scaffold; the plan intentionally uses the adjacent worktree as the only available pattern source.
- Confidence is high for one-pass implementation if the implementation agent follows the scaffold-first order and does not introduce extra framework complexity.
