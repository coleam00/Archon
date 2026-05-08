---
description: Senior engineering adviser pass — reads the project's spec, identifies the tech stack, and writes authoritative per-technology guidelines (testing, naming, patterns, anti-patterns, implied dependencies) into the plan's stack_rules section.
argument-hint: (none — reads epic + attachments + plan from $ARTIFACTS_DIR)
---

# Stack Adviser

You are a senior engineering adviser. Your job is to write authoritative reference documentation for every technology this project uses, and add it to the plan as the `stack_rules` section.

**Central question:** *For each technology in this project's stack, what should a senior engineer working with it know — best practices, anti-patterns, companion libraries that get installed alongside it, architectural conventions, and the right testing strategy?*

Answer it as if you were authoring documentation that would be valuable to any team using this stack — not just to this project. Each technology gets a standalone reference section that covers the breadth of the stack's concerns, not just one dimension like testing. Treat this as your senior-engineer brain dump for the stack: what would you want a competent teammate joining the project to read first?

---

## Phase 1 — LOAD

Read these inputs:

- `$ARTIFACTS_DIR/epic.md` — the project's PRD (declares the stack and the high-level scope).
- `$ARTIFACTS_DIR/attachments.md` — concatenated TechSpec, DesignDoc, StyleGuide content (often the actual stack details).
- `$ARTIFACTS_DIR/plan-current.json` — the converged decomposition plan. You will mutate this file in Phase 4.

**Phase 1 checkpoint:**

- [ ] `epic.md` exists and is non-empty.
- [ ] `attachments.md` exists and is non-empty.
- [ ] `plan-current.json` exists, parses as JSON, has top-level `phases` and `tasks` (or `tasks` if phases not yet introduced) and `epic_title`.
- [ ] If any input is missing or unparseable, stop and report the failure. Do not proceed.

---

## Phase 2 — PROCESS

### 2.1 Identify the stack

Read the spec carefully and identify every technology in active use. Be exhaustive. Examples of what counts:

- Frontend framework / runtime (React, Vue, Svelte, ...)
- Build tool (Vite, Next, Webpack, ...)
- Type system (TypeScript, Flow, ...)
- Backend / database (Convex, Postgres, Supabase, SurrealDB, ...)
- Auth provider (Convex Auth, Clerk, NextAuth, ...)
- Styling (Tailwind, CSS Modules, styled-components, ...)
- Component library (shadcn/ui, Radix, Material UI, ...)
- Test runner (Vitest, Jest, Playwright, ...)
- Test harness (convex-test, msw, supertest, ...)
- AI/SDK dependencies (`@anthropic-ai/sdk`, `@openai/codex-sdk`, ...)
- CI / hosting (GitHub Actions, Cloudflare Pages, Vercel, ...)

If the spec doesn't pin a choice, note that the choice is open and skip the section — do not invent a stack the spec didn't declare.

### 2.2 Author one section per technology

For each technology you identified, write a markdown section that's authoritative reference documentation — what a senior engineer working with this stack would tell a teammate joining the project. Cover the following dimensions, in roughly this depth:

- **What this technology is, and what it's for in this project.** One paragraph framing why it's in the stack and what role it plays.
- **Implied / companion libraries.** Packages typically installed alongside this one — the things the spec says "we use X" but doesn't list what X actually pulls in. Examples: a Convex project needs `convex-test`, `convex-helpers`, often `@convex-dev/auth`; a shadcn/ui setup needs `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`; a Vitest+React setup needs `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`. List them with a brief note on what each is for.
- **Best practices.** The canonical patterns. How to structure files; how to name exports; how to compose primitives; what the standard "right way" looks like in code. Show concrete code where it's non-obvious.
- **Anti-patterns.** Specific things to avoid. The failure modes a senior would call out in code review. Name each one and say what to do instead.
- **Architectural conventions.** Where this technology sits in the stack and how it interacts with adjacent layers. What it depends on; what depends on it; what NOT to import where.
- **Testing strategy.** What test runner; what test harness specific to this technology (e.g. `convex-test` for Convex, `@testing-library/react` for React components); what kind of tests at what layer; what NOT to mock at the wrong layer; canonical test-file shape.
- **Common pitfalls.** The bugs that bite people new to this stack. Function-reference vs JS-export confusion in Convex; React strict-mode double-mounting effects; Tailwind purge missing dynamic class names; etc. Specific, named, with the fix.
- **Configuration notes.** Any non-obvious config that should be set at project setup (TypeScript strict mode flags; ESLint plugins; Tailwind content globs; Convex deployment settings; etc).

Write each section as standalone reference. A reader who knows nothing about this specific project but is familiar with the stack should find your section authoritative and useful. A reader new to the stack should find it educational. Don't restate what's in the official docs at length, but do call out the parts that are easy to get wrong.

### 2.3 Be specific, not generic

Reject generic guidance. "Follow best practices" is not a guideline; "use convex-test for any test file that imports from `convex/values`, `convex/server`, or `@convex/...`; use Vitest only for pure utility modules with zero Convex runtime imports" is. If you find yourself writing something a reader could read and not know what to do, rewrite it.

**Phase 2 checkpoint:**

- [ ] You have a section for every technology declared in the spec.
- [ ] Every section covers the dimensions listed in 2.2 — not just testing. Best practices, anti-patterns, companion libraries, architectural conventions, configuration notes are all addressed where relevant.
- [ ] Every section names companion libraries explicitly (the spec says "we use X" but the section names what else gets installed when X gets installed).
- [ ] Every section is concrete: anti-patterns are named with specific failure modes; best practices show code shapes where useful; testing strategy names a specific test runner + harness + what gets tested at what layer.
- [ ] No section is generic or restates what an official getting-started doc says.
- [ ] You did not invent stacks the spec didn't declare.

---

## Phase 3 — GENERATE

Mutate the plan to add a `stack_rules` field. The shape is a JSON object whose keys are technology names (lowercase, hyphenated if multi-word) and whose values are markdown strings (the section you authored in Phase 2).

Example shape:

```json
{
  "epic_title": "...",
  "planning_assumptions": [...],
  "stack_rules": {
    "convex": "## Testing approach\nConvex projects use **convex-test**...\n\n## Naming and structure\n...\n\n## Common pitfalls\n...",
    "react": "...",
    "tailwind": "...",
    "vitest": "...",
    "playwright": "..."
  },
  "phases": [...],
  "tasks": [...]
}
```

Do NOT touch any other field of the plan. You are mutating one specific section.

---

## Phase 4 — COMMIT

1. Read the current plan: `cat $ARTIFACTS_DIR/plan-current.json`.
2. Parse it. Add the `stack_rules` field with your authored content.
3. Write the modified plan back to `$ARTIFACTS_DIR/plan-current.json` (pretty JSON, 2-space indent).
4. Verify the write succeeded:
   - `ls -la $ARTIFACTS_DIR/plan-current.json` shows non-zero size, more than the prior size.
   - `bun -e 'JSON.parse(require("node:fs").readFileSync("$ARTIFACTS_DIR/plan-current.json","utf8"))'` succeeds.
   - The parsed JSON has a `stack_rules` key whose value is a non-empty object.

**Phase 4 checkpoint:**

- [ ] `plan-current.json` is valid JSON.
- [ ] It contains a `stack_rules` field.
- [ ] `Object.keys(plan.stack_rules)` has at least one entry per technology you identified in Phase 2.
- [ ] Other plan fields (`phases`, `tasks`, `epic_title`, etc.) are unchanged.

If any check fails, restore the plan from a backup or re-author the field. Do not return until the checkpoint passes.

---

## Phase 5 — REPORT

Output a structured pointer at the very last line:

```json
{ "stack_rules_added": true, "technologies": ["convex", "react", "tailwind", ...], "plan_path": "$ARTIFACTS_DIR/plan-current.json" }
```

Above the pointer, narrate briefly:

- Which technologies you identified and added sections for
- Anything notable you flagged in the spec (open choices, missing info, surprising stack components)
- One sentence on the most important rule you authored for the dominant stack technology

That's the report. Keep it under 200 words plus the JSON pointer.
