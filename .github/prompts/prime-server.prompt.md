---
description: "Prime agent with server/backend codebase understanding"
agent: "plan"
tools:
  - codebase
  - readFile
  - textSearch
  - fileSearch
  - listDirectory
  - usages
---

# Prime Server: Load Backend Context

## Objective

Build comprehensive understanding of the server codebase by analyzing structure and key files.

## Process

1. Study the entry point (`server/src/index.ts`)
2. Study the services (`server/src/services/`)
3. Study the middleware (`server/src/middleware/`)
4. Study the database layer (`server/src/db/`)
5. Check `server/package.json` for dependencies

## Output

Produce a scannable summary of what you learned:

- **Purpose**: What the backend does
- **Tech Stack**: Framework, database, validation
- **API Routes**: Available endpoints
- **Data Model**: Core entities from `shared/types.ts`
- **Patterns**: Database patterns, error handling, validation approach

Use bullet points. Keep it concise.
