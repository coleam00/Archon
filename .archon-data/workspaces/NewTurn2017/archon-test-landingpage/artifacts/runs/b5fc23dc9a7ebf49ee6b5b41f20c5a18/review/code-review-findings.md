# Code Review Findings: PR #1

**Reviewer**: code-review-agent
**Date**: 2026-04-11T16:05:06+00:00
**Files Reviewed**: 15

---

## Summary

The PR is a clean first-pass landing page with readable structure, sensible content grouping, and a matching test scaffold. The main concerns are a config issue that is likely to break the advertised TypeScript validation flow in a normal Node-based setup, and an accessibility regression where custom CTA styling removes the browser's default focus affordance without replacing it.

**Verdict**: REQUEST_CHANGES

---

## Findings

### Finding 1: `vite.config.ts` uses a Vitest-only `test` block without Vitest-aware typing

**Severity**: HIGH
**Category**: bug
**Location**: `vite.config.ts:1`

**Issue**:
`vite.config.ts` imports `defineConfig` from `vite` while declaring a top-level `test` property. In a strict TypeScript setup, that property is not part of Vite's base config type unless the file opts into Vitest's config types. Because `tsconfig.app.json` explicitly includes `vite.config.ts`, this can break `npm run type-check` and `npm run build` once the project is run in the Node/npm environment described in the README.

**Evidence**:

```typescript
// Current code at vite.config.ts:1
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
});
```

**Why This Matters**:
The README and package scripts advertise `type-check` and `build` as supported validation commands. If the config file itself fails type-checking, those quality gates become unreliable and the repo cannot be validated as documented.

---

#### Fix Suggestions

| Option | Approach                                                                                                  | Pros                                                                                               | Cons                                             |
| ------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| A      | Import `defineConfig` from `vitest/config` instead of `vite`                                              | Smallest fix, aligns the file type with the config shape already being used, common Vitest pattern | Couples the config file directly to Vitest       |
| B      | Keep the Vite import and add Vitest config typing via a reference directive or explicit type augmentation | Preserves the current import path                                                                  | More indirect and easier to miss in future edits |

**Recommended**: Option A

**Reasoning**:
Option A is the clearest expression of intent: this file is both a Vite config and a Vitest config. That matches the existing repo pattern where validation commands are expected to run through TypeScript (`package.json`) and the config file is explicitly included in type-checking (`tsconfig.app.json`). It is also the least surprising fix for future maintainers.

**Recommended Fix**:

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
});
```

**Codebase Pattern Reference**:

```typescript
// SOURCE: package.json:8-10 and tsconfig.app.json:15-17
"build": "tsc -b && vite build",
"type-check": "tsc -b",

"types": ["vitest/globals", "@testing-library/jest-dom"]
"include": ["src", "vite.config.ts", "eslint.config.js"]
```

This pattern shows that config files are part of the repo's typed validation path, so config typing needs to be correct rather than relying on runtime-only behavior.

---

### Finding 2: CTA links remove default browser link affordances without adding a visible focus state

**Severity**: MEDIUM
**Category**: pattern-violation
**Location**: `src/styles.css:39`

**Issue**:
The stylesheet removes default link decoration globally and gives the CTA links custom visual styles, but it does not add a `:focus-visible` state or any replacement focus indicator.

**Evidence**:

```typescript
// Current code at src/styles.css:39
a {
  color: inherit;
  text-decoration: none;
}

.primary-cta,
.secondary-cta {
  padding: 0.95rem 1.35rem;
  border-radius: 999px;
  font-weight: 700;
}
```

**Why This Matters**:
Keyboard users depend on a visible focus indicator to understand which interactive element is active. Removing the browser default without replacement creates an accessibility regression and makes the primary navigation actions harder to use.

---

#### Fix Suggestions

| Option | Approach                                                                     | Pros                                                                   | Cons                                                        |
| ------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| A      | Add explicit `:focus-visible` styles for `.primary-cta` and `.secondary-cta` | Preserves the current visual design while restoring keyboard usability | Requires maintaining one more interaction state             |
| B      | Stop globally removing link decoration and browser focus styling             | Lowest maintenance and safest accessibility baseline                   | Changes the current polished CTA appearance more noticeably |

**Recommended**: Option A

**Reasoning**:
The repo already centralizes CTA presentation in `.primary-cta` and `.secondary-cta`, so the most consistent fix is to keep the custom appearance and add a deliberate focus state next to those rules. That keeps the design intent intact while restoring an expected interaction affordance.

**Recommended Fix**:

```typescript
a {
  color: inherit;
  text-decoration: none;
}

.primary-cta:focus-visible,
.secondary-cta:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 4px;
}
```

**Codebase Pattern Reference**:

```typescript
// SOURCE: src/App.tsx:52-58 and src/styles.css:124-139
<div className="cta-row">
  <a className="primary-cta" href="#capabilities">
    핵심 기능 보기
  </a>
  <a className="secondary-cta" href="#workflow">
    작업 흐름 보기
  </a>
</div>

.primary-cta,
.secondary-cta {
  padding: 0.95rem 1.35rem;
  border-radius: 999px;
  font-weight: 700;
}
```

This pattern shows that interactive CTA behavior is already centralized in the CTA classes, so focus styling belongs alongside the existing button-like link styling.

---

## Statistics

| Severity | Count | Auto-fixable |
| -------- | ----- | ------------ |
| CRITICAL | 0     | 0            |
| HIGH     | 1     | 1            |
| MEDIUM   | 1     | 1            |
| LOW      | 0     | 0            |

---

## CLAUDE.md Compliance

| Rule                                                               | Status | Notes                                                                                                                                      |
| ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository `CLAUDE.md` present                                     | N/A    | Scope artifact explicitly reports that no `CLAUDE.md` exists at repository root                                                            |
| Import patterns match repository rules                             | N/A    | No repo-local `CLAUDE.md` rules available to enforce                                                                                       |
| Naming, error handling, testing conventions match repository rules | N/A    | No repo-local `CLAUDE.md` rules available to enforce                                                                                       |
| Primitive duplication check                                        | PASS   | Scope artifact reports no new interfaces, classes, type aliases, or utility abstractions; review found no duplicated primitives introduced |

---

## Patterns Referenced

| File                | Lines   | Pattern                                                       |
| ------------------- | ------- | ------------------------------------------------------------- |
| `package.json`      | 8-10    | Type checking and build are expected to pass through `tsc -b` |
| `tsconfig.app.json` | 15-17   | `vite.config.ts` is included in the typed project scope       |
| `src/App.tsx`       | 52-58   | CTA links are the primary interactive controls on the page    |
| `src/styles.css`    | 124-139 | CTA visual styling is centralized in shared classes           |

---

## Positive Observations

- `src/App.tsx` keeps the page structure straightforward and semantic, using headings, sections, articles, and an aside appropriately.
- The landing page content is fully static, which matches the scope guidance to avoid external-data dependencies.
- The test setup is directionally correct for a Vite + React stack, with `@testing-library/jest-dom` and a dedicated setup file already in place.
- The responsive CSS is organized cleanly and keeps the desktop-to-mobile transition easy to follow.

---

## Metadata

- **Agent**: code-review-agent
- **Timestamp**: 2026-04-11T16:05:06+00:00
- **Artifact**: `/.archon/workspaces/NewTurn2017/archon-test-landingpage/artifacts/runs/b5fc23dc9a7ebf49ee6b5b41f20c5a18/review/code-review-findings.md`
