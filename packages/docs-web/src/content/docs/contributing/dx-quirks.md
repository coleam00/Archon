---
title: DX Quirks
description: Known development experience quirks and workarounds when working on the Archon codebase.
category: contributing
audience: [developer]
status: current
sidebar:
  order: 6
---

Development experience notes and workarounds.

## Bun Log Elision

When running `bun dev` from the repo root, Bun's `--filter` truncates logs:

```
@archon/server dev $ bun --watch src/index.ts
│ [129 lines elided]
│ [Hono] Server listening on port 3090
└─ Running...
```

**To see full logs**, run directly from the server package:

```bash
cd packages/server && bun --watch src/index.ts
```

Or:

```bash
bun --cwd packages/server run dev
```

Note: The root `bun dev` uses `--filter` to fix hot reload path issues, but this comes with log condensing.

## `mock.module()` Pollution

Bun's `mock.module()` is process-global and irreversible — `mock.restore()` does NOT undo it.

- Never add `afterAll(() => mock.restore())` for `mock.module()` cleanup — it has no effect
- Use `spyOn()` for internal modules that other test files import directly (e.g., `spyOn(git, 'checkout')`) — `spy.mockRestore()` DOES work for spies
- Never `mock.module()` a module path that another test file also `mock.module()`s with a different implementation
- When adding a new test file with `mock.module()`, ensure its package.json puts it in a separate group from any conflicting files — its own entry in `testGroups`, or its own `bun test` step for a package still using a `&&` chain

## Worktree Port Allocation

Worktrees auto-allocate ports (3190–4089 range, hash-based on path). Same worktree always gets same port.

- Main repo defaults to 3090
- Override: `PORT=4000 bun dev`
- Same worktree always gets same port (deterministic)

## `bun run test` vs `bun test`

**NEVER run `bun test` from the repo root** — it discovers all test files across all packages and runs them in one process, causing ~135 mock pollution failures.

Always use `bun run test`, which runs each package's own grouped suite for isolation.

### Running one test

`bun run test <path>` runs that path.

```bash
bun run test packages/paths/src/effort.test.ts   # from the repo root
cd packages/paths && bun run test src/effort.test.ts
```

From the repo root, an argument naming a path under `packages/<name>/`, `scripts/` or
`.archon/scripts/` decides where `bun test` runs; flags and substring filters are
forwarded unchanged. Paths naming several packages run one package at a time and stop at
the first failure. An argument that names no owner fails instead of running the suite.

A package whose `scripts.test` is still a `bun test ... && bun test ...` chain rather than
`bun run ../../scripts/package-tests.ts` ignores the argument when you run it from inside
the package: `bun run` appends arguments to the script, so the whole chain runs and a wrong
path still reports a pass. Run those from the repo root, which routes the path itself.
