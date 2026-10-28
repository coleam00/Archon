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

## `mock.module()` merges over the real module

Bun merges a `mock.module()` factory over the real module: an export the factory leaves out keeps its real implementation. When a mocked module gains an export, every factory that does not list it starts running real code (a database, the network, the filesystem) while its tests still pass, often until a 5-second timeout.

`bun run check:mock-modules` (validate id `mock-modules`, run in CI) fails on every factory that leaves out a value export of the module it mocks, naming the file, line, specifier and missing names. Mock each missing export, or spread the real module to keep the rest real on purpose:

```ts
mock.module('../db/workflows', async () => ({
  ...(await import('../db/workflows')),
  getWorkflowRun: mockGetWorkflowRun,
}));
```

A spreading factory provides every export, including ones the module gains later; that is the author's declaration. Where test files share a process (packages other than `@archon/core`, unless the file has its own group), the `import()` can return a module an earlier file already mocked.

Factories that were incomplete when the check landed are grandfathered in `scripts/mock-module-baseline.json`. A grandfathered site may omit only the exports its module's grandfathered sites omitted then, so a new export still fails at every one of them. The baseline only shrinks: after completing a factory, run `bun run check:mock-modules --write`. `bun run check:ratchet` refuses entries the baseline gains unless a commit in the change carries `Ratchet-Allow: scripts/mock-module-baseline.json`.

What the check does not prove:

- It reads factory keys from the factory's type, so an `as` cast can misstate them.
- It checks only literal specifiers, and refuses a non-literal one.
- It refuses a module TypeScript cannot read (no type declarations, or a path that does not resolve) unless the site is grandfathered.
- A grandfathered factory can drop a key that another grandfathered site of the same module already omits.
- It says nothing about a client a test never stubbed, or about I/O outside `mock.module()`. The adapters package preloads `no-network` (it traps only `globalThis.fetch`) and `no-archon-home-writes` guards for part of that; Bun reads `bunfig.toml` only from the working directory, so those guards apply only when the tests run from `packages/adapters`. Their headers list the limits.
- It runs in validate and CI, not inside `bun test`.

## `mock.module()` Pollution

Bun's `mock.module()` is process-global and irreversible — `mock.restore()` does NOT undo it.

- Never add `afterAll(() => mock.restore())` for `mock.module()` cleanup — it has no effect
- Use `spyOn()` for internal modules that other test files import directly (e.g., `spyOn(git, 'checkout')`) — `spy.mockRestore()` DOES work for spies
- Never `mock.module()` a module path that another test file also `mock.module()`s with a different implementation
- When adding a new test file with `mock.module()` to `packages/core`, make its first line exactly `// @archon-test-isolated` so it runs in its own process. Core discovers its tests, and discovery fails on a file that calls `mock.module()` without the marker. A file that mocks through a helper needs the marker too; discovery cannot see that call
- In the other packages, give the file its own entry in `testGroups` in the package's `package.json`, or its own `bun test` step for a package still using a `&&` chain
- A package's `testConcurrency` in `package.json` runs that many `testGroups` at once, each still in its own process; leave it out to run groups one at a time
- Groups start slowest first, by the times in `scripts/test-weights.json`. CI splits slow shards into parts with `ARCHON_TEST_PART=<index>/<count>`, using the same times; `ARCHON_TEST_PART=1/2 bun run test` in a package runs that part locally. A new group with no recorded time counts as one second, so refresh the file with `bun scripts/update-test-weights.ts <run-id>` when one part of a shard finishes well after its sibling

## Worktree Port Allocation

Worktrees auto-allocate ports (3190–4089 range, hash-based on path). Same worktree always gets same port.

- Main repo defaults to 3090
- Override: `PORT=4000 bun dev`
- Same worktree always gets same port (deterministic)
- If that port is already taken — another worktree hashed to it, or any unrelated
  process holds it — the server takes the next free port in the range and logs
  `worktree_port_reallocated` with both the port it wanted and the one it got.
  The root `bun dev` launcher passes that selected port to both the server and Web
  client, so the Vite proxy and SSE streams use the endpoint the server binds. It
  returns to the hashed port once that frees up.
- `PORT` is never moved: an explicit override binds where you said, or fails.

## `bun run test` vs `bun test`

**NEVER run `bun test` from the repo root** — it discovers all test files across all packages and runs them in one process, causing ~135 mock pollution failures.

Always use `bun run test`, which runs each package's own grouped suite for isolation.

### Running one test

`bun run test <path>` runs that path.

```bash
bun run test packages/paths/src/skills.test.ts   # from the repo root
cd packages/paths && bun run test src/skills.test.ts
```

From the repo root, an argument naming a path under `packages/<name>/`, `scripts/` or
`.archon/scripts/` decides where `bun test` runs; flags and substring filters are
forwarded unchanged. Paths naming several packages run one package at a time and stop at
the first failure. An argument that names no owner fails instead of running the suite.

A package whose `scripts.test` is still a `bun test ... && bun test ...` chain rather than
`bun run ../../scripts/package-tests.ts` ignores the argument when you run it from inside
the package: `bun run` appends arguments to the script, so the whole chain runs and a wrong
path still reports a pass. Run those from the repo root, which routes the path itself.
