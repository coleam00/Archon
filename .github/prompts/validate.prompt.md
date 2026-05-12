---
description: "Run linter, type checker, and tests - report any failures"
agent: "agent"
tools:
  - runInTerminal
  - problems
  - runTests
  - readFile
---

# Validate

Run all validation checks and report results.

---

## Checks to Run

### Server (server/)

```bash
cd server

# Lint
pnpm run lint

# Type check (via build)
pnpm run build

# Tests
pnpm test
```

### Client (client/)

```bash
cd client

# Lint
pnpm run lint

# Type check (via build)
pnpm run build
```

---

## Process

1. Run server checks, capture output
2. Run client checks, capture output
3. Collect all failures
4. Report results

---

## Output

Report in this format:

```
## Validation Results

### Server
| Check | Result | Details |
|-------|--------|---------|
| Lint | ✅/❌ | {N errors or "passed"} |
| Type check | ✅/❌ | {N errors or "passed"} |
| Tests | ✅/❌ | {N passed, M failed} |

### Client
| Check | Result | Details |
|-------|--------|---------|
| Lint | ✅/❌ | {N errors or "passed"} |
| Type check | ✅/❌ | {N errors or "passed"} |

### Summary
- **Status**: ✅ ALL PASSING / ❌ {N} FAILURES
- **Action needed**: {None / list of things to fix}
```

---

## If Failures Found

List each failure with:
1. File and line number
2. Error message
3. Suggested fix (if obvious)

Example:
```
### Failures

1. **server/src/services/flags.ts:42**
   - Error: `Type 'string' is not assignable to type 'number'`
   - Fix: Check the type annotation or value

2. **client/src/components/App.tsx:15**
   - Error: `'x' is defined but never used`
   - Fix: Remove unused variable or prefix with `_`
```
