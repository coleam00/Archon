# Feature: Archon Korean Landing Page

## Summary

Build a single-page Korean-language landing page for Archon in a greenfield repository by first establishing a minimal Next.js App Router baseline, then implementing a visually polished, futuristic, minimalist homepage with concise Korean copy, responsive layout, clear product positioning, and a focused call to action. Because the current repository contains no application code or dependency manifest, the implementation must treat bootstrap work as part of the feature rather than an incidental prerequisite.

## User Story

As a Korean-speaking prospective Archon user
I want to land on a clear, polished introduction page
So that I can immediately understand what Archon is, why it is useful, and what action to take next

## Problem Statement

This repository does not currently contain a Next.js application or any frontend code. A user visiting the repository cannot load a product page, understand Archon’s value, or take a next step. The implementation must create a production-buildable landing page that communicates Archon’s core message in Korean, renders well on mobile and desktop, and passes baseline project validation.

## Solution Statement

Create a minimal Next.js 16 App Router application in TypeScript with a single `/` route, root layout metadata, global styling, and one primary page composed from a small set of local sections. Use server-rendered static content only, avoid unnecessary abstractions, keep information architecture intentionally sparse, and validate with linting, production build, and a lightweight browser smoke test.

## Metadata

| Field            | Value                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Type             | NEW_CAPABILITY                                                                                                               |
| Complexity       | MEDIUM                                                                                                                       |
| Systems Affected | repository bootstrap, Next.js App Router, TypeScript config, styling layer, page metadata, static assets, validation scripts |
| Dependencies     | `next@16.2.2` docs baseline, `react`, `react-dom`, TypeScript `>=5.1.0`, ESLint CLI, optional Playwright smoke test          |
| Estimated Tasks  | 9                                                                                                                            |

---

## UX Design

### Before State

```text
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              BEFORE STATE                                    ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   Repository only                                                             ║
║   ┌─────────────┐         ┌─────────────┐         ┌──────────────────────┐   ║
║   │   README    │ ──────► │   No App    │ ──────► │ No route or UI exists│   ║
║   └─────────────┘         └─────────────┘         └──────────────────────┘   ║
║                                                                               ║
║   USER_FLOW: User opens repo or deployed target and has nothing to browse.   ║
║   PAIN_POINT: No homepage, no Archon message, no CTA, no responsive UI.      ║
║   DATA_FLOW: None; no runtime, no route tree, no static assets.              ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```text
╔═══════════════════════════════════════════════════════════════════════════════╗
║                               AFTER STATE                                    ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   Browser request                                                             ║
║   ┌─────────────┐         ┌─────────────┐         ┌──────────────────────┐   ║
║   │   GET /     │ ──────► │ app/page.tsx│ ──────► │ Korean landing page  │   ║
║   └─────────────┘         └─────────────┘         └──────────────────────┘   ║
║                                   │                                           ║
║                                   ▼                                           ║
║                         ┌────────────────────┐                                ║
║                         │ app/layout.tsx     │                                ║
║                         │ metadata + fonts   │                                ║
║                         └────────────────────┘                                ║
║                                                                               ║
║   USER_FLOW: User lands on hero, reads Archon summary, scans value points,   ║
║   reaches focused CTA, and can act without scrolling through clutter.         ║
║   VALUE_ADD: Clear positioning, high-end visual finish, mobile/desktop fit.  ║
║   DATA_FLOW: Static server-rendered content + CSS + local/public assets.     ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location          | Before          | After                                                          | User Impact                                           |
| ----------------- | --------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `/`               | No route exists | Hero-led Korean landing page exists                            | User immediately sees what Archon is                  |
| `app/layout.tsx`  | Missing         | Global metadata, `lang="ko"`, font wiring, body shell          | Better SEO/shareability and Korean locale correctness |
| `app/page.tsx`    | Missing         | Structured hero, explanation, capability/value section, CTA    | User can scan core message quickly                    |
| `app/globals.css` | Missing         | Visual system, responsive spacing, gradients, typography rules | Polished visual identity across screen sizes          |
| `public/`         | Missing         | Optional logo/graphic assets and social preview image          | Brand cues without layout clutter                     |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File             | Lines              | Why Read This                                                         |
| -------- | ---------------- | ------------------ | --------------------------------------------------------------------- |
| P0       | `README.md`      | 1-3                | Confirms repo is currently a minimal placeholder, not an existing app |
| P1       | `package.json`   | all after creation | Source of truth for scripts and dependency versions during bootstrap  |
| P2       | `app/layout.tsx` | all after creation | Root pattern for metadata, locale, and shared typography              |
| P3       | `app/page.tsx`   | all after creation | Main composition for the landing page sections                        |

**External Documentation:**

| Source                                                                                                                       | Section                    | Why Needed                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------- |
| [Next.js Installation v16.2.2](https://nextjs.org/docs/app/getting-started/installation#manual-installation)                 | Manual installation        | Bootstrap files, scripts, and TypeScript baseline for an empty repo                |
| [Next.js CSS v16.2.2](https://nextjs.org/docs/app/getting-started/css#css-modules)                                           | CSS Modules and global CSS | Decide whether to keep styling in `globals.css` only or split into section modules |
| [Next.js Font Optimization v16.2.2](https://nextjs.org/docs/app/getting-started/fonts#font-optimization)                     | `next/font` usage          | Self-hosted font loading and layout-level font application                         |
| [Next.js Metadata and OG Images v16.2.2](https://nextjs.org/docs/app/getting-started/metadata-and-og-images#static-metadata) | Static metadata            | Proper title/description/Open Graph setup for the landing page                     |

---

## Patterns to Mirror

**REPOSITORY_INTENT:**

```md
// SOURCE: README.md:1-3
// CURRENT STATE TO ACCOUNT FOR:

# archon-test-landingpage

Minimal test repository for validating Archon local workspace registration.
```

**BOOTSTRAP_PATTERN:**

```tsx
// SOURCE: Next.js Installation docs v16.2.2
// FOLLOW THIS FILE-SYSTEM PATTERN:
app/layout.tsx
app/page.tsx
public/
```

**FONT_PATTERN:**

```tsx
// SOURCE: https://nextjs.org/docs/app/getting-started/fonts#font-optimization
// MIRROR THE ROOT-LAYOUT FONT APPLICATION SHAPE:
import { Geist } from 'next/font/google';

const geist = Geist({
  subsets: ['latin'],
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={geist.className}>
      <body>{children}</body>
    </html>
  );
}
```

**METADATA_PATTERN:**

```tsx
// SOURCE: https://nextjs.org/docs/app/getting-started/metadata-and-og-images#static-metadata
// MIRROR THE STATIC METADATA EXPORT SHAPE:
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'My Blog',
  description: '...',
};
```

**VALIDATION_PATTERN:**

```json
// SOURCE: https://nextjs.org/docs/app/getting-started/installation#set-up-linting
// MIRROR SCRIPT SHAPE IN package.json:
{
  "scripts": {
    "lint": "eslint",
    "lint:fix": "eslint --fix"
  }
}
```

---

## Codebase Intelligence

| Category    | File:Lines      | Pattern Description                       | Code Snippet                    |
| ----------- | --------------- | ----------------------------------------- | ------------------------------- |
| STRUCTURE   | `README.md:1-3` | Only tracked project file in `HEAD`       | `# archon-test-landingpage`     |
| ANALOGS     | N/A             | No similar implementation exists in repo  | `None present`                  |
| TYPES       | N/A             | No TypeScript or app code exists          | `None present`                  |
| TESTS       | N/A             | No test framework or test files exist     | `None present`                  |
| INTEGRATION | N/A             | No app/router/components/config exist yet | `Greenfield bootstrap required` |

### Primitives Inventory

| Primitive                      | File:Lines      | Complete? | Role in Feature                                               |
| ------------------------------ | --------------- | --------- | ------------------------------------------------------------- |
| Repository placeholder README  | `README.md:1-3` | No        | Confirms there is no reusable application primitive to extend |
| Next.js App Router root layout | Not yet created | No        | Required to establish global metadata, locale, and typography |
| Next.js home page route        | Not yet created | No        | Required to render the landing page                           |
| Global styling layer           | Not yet created | No        | Required for brand direction, responsive layout, and motion   |
| Validation scripts             | Not yet created | No        | Required for PR-ready build verification                      |

---

## Files to Change

| File                                  | Action | Justification                                             |
| ------------------------------------- | ------ | --------------------------------------------------------- |
| `package.json`                        | CREATE | Declare runtime and validation scripts                    |
| `tsconfig.json`                       | CREATE | Enable TypeScript support for App Router                  |
| `next.config.ts` or `next.config.mjs` | CREATE | Minimal Next.js configuration only if needed              |
| `eslint.config.mjs`                   | CREATE | Establish linting with modern ESLint CLI                  |
| `next-env.d.ts`                       | CREATE | Standard Next.js TypeScript shim                          |
| `app/layout.tsx`                      | CREATE | Locale, metadata, root structure, and font setup          |
| `app/page.tsx`                        | CREATE | Korean landing page route                                 |
| `app/globals.css`                     | CREATE | Global visual system and responsive styling               |
| `public/og-image.png`                 | CREATE | Social preview asset if time allows within scope          |
| `public/brand-mark.svg`               | CREATE | Minimal visual accent or logo treatment if needed         |
| `tests/landing.spec.ts`               | CREATE | Optional Playwright smoke test for core rendering and CTA |
| `playwright.config.ts`                | CREATE | Only if smoke test is included                            |

---

## Approach Decisions

APPROACH_CHOSEN: Build a minimal App Router project directly in-repo and keep the landing page mostly in a single `app/page.tsx` plus `app/globals.css`, introducing extra components only if the page becomes difficult to scan.

RATIONALE: There is no existing architecture to extend. A small App Router setup follows official Next.js defaults, keeps implementation readable, reduces file churn, and is appropriate for a one-page marketing surface with static content.

ALTERNATIVES_REJECTED:

- Using the Pages Router: rejected because current official Next.js guidance prioritizes App Router for new work and the page needs only a simple static route.
- Introducing Tailwind on day one: rejected because the repo has no existing styling system to align with, and plain CSS keeps the bootstrap surface smaller for a single-page site.
- Splitting the page into many micro-components immediately: rejected because it adds indirection before there is proven reuse.

NOT_BUILDING (explicit scope limits):

- Full multi-page marketing site or blog: out of scope because the request is for a concise landing page with minimal information architecture.
- CMS integration or localization framework: out of scope because only one Korean page is requested.
- Backend forms, analytics, or authentication: out of scope unless a CTA destination requires them.
- Complex animation libraries: out of scope; use CSS-only motion to preserve minimalism and keep dependencies light.

---

## Strategic Architecture

### Architecture Fit

There is no prior application architecture. The correct fit is the smallest possible official Next.js App Router structure that can be built and deployed cleanly.

### Execution Order

1. Establish package manifest, scripts, and TypeScript/ESLint baseline.
2. Create App Router shell with `app/layout.tsx`, `app/page.tsx`, and `app/globals.css`.
3. Implement Korean copy, visual hierarchy, and responsive layout.
4. Add metadata and optional static assets.
5. Add smoke validation and run lint/build/test commands.

### Failure Modes

- Korean typography degrades on some devices.
  Mitigation: choose a Korean-capable font strategy early and verify at mobile and desktop widths.
- Visual concept becomes cluttered.
  Mitigation: cap sections to hero, what Archon is, value/capabilities, CTA.
- Empty repo leads to setup drift.
  Mitigation: follow official manual-installation docs closely and avoid unnecessary config.
- CTA lacks a valid target.
  Mitigation: use a clearly labeled placeholder destination only if no product URL is available; otherwise point to repo or contact channel.

### Performance

- Prefer static server-rendered content with no client components unless interaction requires them.
- Keep images sparse and optimized; use vector assets where possible.
- Avoid large animation or UI libraries.

### Security

- No user input or server actions are required for the initial page.
- If external links are added, use safe link attributes where appropriate.
- Keep metadata and public assets non-sensitive.

### Maintainability

- Keep copy constants near the page unless reuse appears.
- Use semantic HTML sections and clear class naming.
- Avoid introducing abstractions before a second page or repeated section exists.

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: CREATE `package.json`

- **ACTION**: CREATE new file
- **IMPLEMENT**: Add `next`, `react`, `react-dom`, TypeScript, type packages, ESLint, and scripts for `dev`, `build`, `start`, `lint`
- **MIRROR**: `https://nextjs.org/docs/app/getting-started/installation#manual-installation`
- **IMPORTS**: N/A
- **GOTCHA**: Do not use deprecated `next lint`; use ESLint CLI scripts
- **VALIDATE**: `npm install`

### Task 2: CREATE baseline config files

- **ACTION**: CREATE `tsconfig.json`, `next-env.d.ts`, and `eslint.config.mjs`
- **IMPLEMENT**: TypeScript support and lint setup compatible with Next.js 16
- **MIRROR**: `https://nextjs.org/docs/app/getting-started/installation#set-up-typescript` and `#set-up-linting`
- **IMPORTS**: Next.js TypeScript types, ESLint config packages
- **GOTCHA**: Keep config minimal; avoid speculative custom aliases unless needed
- **VALIDATE**: `npm run lint`

### Task 3: CREATE `app/layout.tsx`

- **ACTION**: CREATE new file
- **IMPLEMENT**: Root layout with `lang="ko"`, static metadata, font application, and body wrapper
- **MIRROR**: `https://nextjs.org/docs/app/getting-started/fonts#font-optimization`
- **IMPORTS**: `Metadata` from `next`, selected font loader from `next/font/...`, `./globals.css`
- **GOTCHA**: Ensure Korean locale is reflected in `<html lang="ko">`
- **VALIDATE**: `npm run build`

### Task 4: CREATE `app/page.tsx`

- **ACTION**: CREATE new file
- **IMPLEMENT**: Single-page Korean landing page with hero, short Archon explanation, capability/value section, and CTA
- **MIRROR**: Official `app/page.tsx` shape from installation docs, but with semantic sections and static content
- **IMPORTS**: `next/link` only if CTA uses internal navigation; otherwise minimal imports
- **GOTCHA**: Keep copy concise and section count low to preserve minimalist information architecture
- **VALIDATE**: `npm run build`

### Task 5: CREATE `app/globals.css`

- **ACTION**: CREATE new file
- **IMPLEMENT**: Visual system with background treatment, responsive grid/stack behavior, spacing scale, typographic rhythm, CTA states, and restrained motion
- **MIRROR**: `https://nextjs.org/docs/app/getting-started/css#global-css`
- **IMPORTS**: N/A
- **GOTCHA**: Favor a few strong styles over many utility-like classes; verify readability of Korean text
- **VALIDATE**: `npm run dev` and manual browser QA

### Task 6: CREATE optional static assets in `public/`

- **ACTION**: CREATE `brand-mark.svg` and optionally `og-image.png`
- **IMPLEMENT**: Minimal brand accent and sharable preview image aligned with the page aesthetic
- **MIRROR**: `https://nextjs.org/docs/app/getting-started/installation#create-the-public-folder-optional`
- **IMPORTS**: `next/image` only if raster or SVG placement benefits from it
- **GOTCHA**: Skip decorative assets if they compromise simplicity or timeline
- **VALIDATE**: `npm run build`

### Task 7: Wire metadata and social preview

- **ACTION**: UPDATE `app/layout.tsx` and asset references
- **IMPLEMENT**: Korean title, description, Open Graph fields, and preview image path if created
- **MIRROR**: `https://nextjs.org/docs/app/getting-started/metadata-and-og-images#static-metadata`
- **IMPORTS**: `Metadata` types only
- **GOTCHA**: Keep metadata copy aligned with on-page Korean messaging
- **VALIDATE**: `npm run build`

### Task 8: ADD smoke validation

- **ACTION**: CREATE Playwright files only if keeping automated browser validation in scope
- **IMPLEMENT**: One test that loads `/`, checks hero headline, CTA visibility, and mobile/desktop rendering sanity
- **MIRROR**: Use standard Playwright config shape; no internal pattern exists
- **IMPORTS**: `@playwright/test`
- **GOTCHA**: Keep assertions robust against copy refinements; test semantics, not brittle CSS details
- **VALIDATE**: `npx playwright test`

### Task 9: Final PR-readiness pass

- **ACTION**: UPDATE docs if needed and verify scripts
- **IMPLEMENT**: Ensure `README.md` or project notes mention how to run the app locally if required by team norms
- **MIRROR**: Repo intent in `README.md:1-3`
- **IMPORTS**: N/A
- **GOTCHA**: Do not over-document a tiny repo; keep the readme lightweight
- **VALIDATE**: `npm run lint && npm run build` and, if added, `npx playwright test`

---

## Testing Strategy

### Unit Tests to Write

| Test File               | Test Cases                                                                                                 | Validates                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `tests/landing.spec.ts` | Hero heading renders, CTA renders, key Korean copy renders, mobile viewport does not overflow horizontally | Core landing page is reachable and visually intact at a smoke-test level |

### Edge Cases Checklist

- [ ] Korean text remains legible on narrow mobile screens
- [ ] Hero headline wraps cleanly without awkward clipping
- [ ] CTA remains above or near the initial fold on common laptop screens
- [ ] No horizontal overflow at `320px` width
- [ ] Metadata title and description are present in the built document
- [ ] Decorative assets do not obscure copy or reduce contrast

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
npm run lint
```

**EXPECT**: Exit 0, no lint errors

### Level 2: BUILD_VALIDATION

```bash
npm run build
```

**EXPECT**: Exit 0, production build completes successfully

### Level 3: BROWSER_SMOKE

```bash
npx playwright test
```

**EXPECT**: Hero and CTA smoke checks pass on at least one desktop and one mobile viewport

### Level 4: LOCAL_VISUAL_QA

```bash
npm run dev
```

**EXPECT**: Page reads cleanly at mobile and desktop breakpoints, animations are subtle, and Korean copy remains concise

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

## Completion Checklist

- [ ] All bootstrap files created in dependency order
- [ ] Page implemented after baseline config is stable
- [ ] Styling verified at multiple viewport widths
- [ ] Validation run immediately after implementation
- [ ] PR-ready diff contains only required files for the landing page and baseline setup

---

## Risks and Mitigations

| Risk                                                              | Likelihood | Impact | Mitigation                                                                                                         |
| ----------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| Empty repository causes implementation drift or overengineering   | HIGH       | MED    | Follow official Next.js manual-installation defaults and keep config minimal                                       |
| Korean font choice is unsupported or visually weak                | MED        | MED    | Verify chosen font supports Korean before locking it in; fall back to robust Korean-capable system stack if needed |
| Minimalist brief gets diluted into a feature-heavy marketing page | MED        | HIGH   | Enforce four-section cap and reject nonessential content during implementation                                     |
| Smoke test setup adds more cost than value                        | MED        | LOW    | Keep it to one happy-path page test or drop it if lint/build plus manual QA provide enough confidence              |

---

## Notes

- The user request says to implement in an existing Next.js project, but the current repository is not a Next.js project. This plan explicitly resolves that mismatch by treating project bootstrap as part of the feature scope.
- Because no internal naming, logging, or test conventions exist, official Next.js defaults are the safest baseline. The implementation should avoid inventing framework around a single static page.
- Confidence is reduced slightly by the lack of a known CTA destination and the absence of existing brand assets; both should be clarified during implementation if available.
