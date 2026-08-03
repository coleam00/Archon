---
description: "Learn how to build new API endpoints end-to-end"
agent: "plan"
tools:
  - codebase
  - readFile
  - textSearch
  - fileSearch
  - listDirectory
  - usages
---

# Prime Endpoint: How to Build New Endpoints

## Objective

Understand the full endpoint pattern from database to UI so you can build new endpoints correctly.

## Process

Study these files in order (this is the data flow):

1. **Types**: `shared/types.ts` - define your data contracts here first
2. **Validation**: `server/src/middleware/validation.ts` - Zod schemas for request validation
3. **Service**: `server/src/services/flags.ts` - business logic and database operations
4. **Routes**: `server/src/routes/flags.ts` - Express route handlers
5. **Error handling**: `server/src/middleware/error.ts` - custom error classes
6. **Client API**: `client/src/api/flags.ts` - fetch wrappers with types
7. **Usage**: `client/src/App.tsx` - React Query hooks for data fetching

## Output

Produce a scannable summary of what you learned:

- **Type Flow**: How types are shared between server and client
- **Validation**: How request data is validated
- **Service Pattern**: How business logic is structured
- **Route Pattern**: How routes call services and handle errors
- **Client Pattern**: How the frontend fetches and mutates data
- **React Query**: How queries and mutations are used

Use bullet points. Keep it concise.
