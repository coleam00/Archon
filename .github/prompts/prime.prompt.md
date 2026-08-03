---
description: "Prime agent with codebase understanding"
agent: "plan"
tools:
  - codebase
  - readFile
  - textSearch
  - fileSearch
  - listDirectory
  - usages
---

# Prime: Load Project Context

## Objective

Build comprehensive understanding of this codebase by analyzing structure and key files.

## Process

1. Study the client source (`client/src/`)
2. Study the server source (`server/src/`)
3. Study the shared types (`shared/types.ts`)
4. Check recent commits with `git log --oneline -5`

## Output

Produce a scannable summary of what you learned:

- **Project Purpose**: One sentence
- **Tech Stack**
  - Frontend: framework, UI library, state management
  - Backend: framework, database, validation
- **Data Model**: Core entities
- **Key Patterns**: Database, API, state management patterns
- **Current State**: Recent commits, current branch

Use bullet points. Keep it concise.
