---
description: "Prime agent with client/frontend codebase understanding"
agent: "plan"
tools:
  - codebase
  - readFile
  - textSearch
  - fileSearch
  - listDirectory
  - usages
---

# Prime Client: Load Frontend Context

## Objective

Build comprehensive understanding of the client codebase by analyzing structure and key files.

## Process

1. Study the entry points (`client/src/main.tsx`, `client/src/App.tsx`)
2. Study the components (`client/src/components/`)
3. Study the API layer (`client/src/api/`)
4. Check `client/package.json` for dependencies

## Output

Produce a scannable summary of what you learned:

- **Purpose**: What the frontend does
- **Tech Stack**: Framework, UI library, state management
- **Components**: Key components and their responsibilities
- **Data Flow**: How data is fetched and managed
- **Patterns**: Component patterns, styling approach

Use bullet points. Keep it concise.
