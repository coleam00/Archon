# DX Quirks

## Bun Log Elision

When running `bun dev` from repo root, `--filter` truncates logs to `[N lines elided]`.
To see full logs: `cd packages/server && bun --watch src/index.ts` or `bun --cwd packages/server run dev`.

## mock.module() Pollution

`mock.module()` is process-global and irreversible — `mock.restore()` does NOT undo it.
Never add `afterAll(() => mock.restore())` for `mock.module()` cleanup.
Use `spyOn()` for internal modules (spy.mockRestore() DOES work).
When adding tests with `mock.module()`, ensure package.json runs it in a separate `bun test` invocation.

## Worktree Port Allocation

Worktrees auto-allocate ports (3190-4089 range, hash-based on path). Same worktree always gets same port.
Main repo defaults to 3090. Override: `PORT=4000 bun dev`.

## bun run test vs bun test

NEVER run `bun test` from repo root — it discovers all test files across packages in one process, causing ~135 mock pollution failures. Always use `bun run test` (which uses `bun --filter '*' test` for per-package isolation).
