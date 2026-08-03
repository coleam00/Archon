---
description: "Learn how to build components in this codebase"
agent: "plan"
tools:
  - codebase
  - readFile
  - textSearch
  - fileSearch
  - listDirectory
  - usages
---

# Prime Components: How to Build Components

## Objective

Understand the component patterns used in this codebase so you can build new components correctly.

## Process

1. Study the UI primitives in `client/src/components/ui/` (shadcn components)
2. Study `client/src/lib/utils.ts` for the `cn()` utility
3. Study feature components as examples:
   - `client/src/components/flags-table.tsx` - data display pattern
   - `client/src/components/flag-form-modal.tsx` - form with dialog pattern
   - `client/src/components/delete-confirm-dialog.tsx` - confirmation dialog pattern

## Output

Produce a scannable summary of what you learned:

- **UI Library**: Available shadcn components
- **Styling**: How Tailwind and cn() are used
- **Props Pattern**: How props interfaces are defined
- **Composition**: How feature components compose UI primitives
- **State**: How local state is managed in components

Use bullet points. Keep it concise.
