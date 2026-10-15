# fix(providers): a throwing Pi extension callback kills the whole run process instead of failing the node

## Problem

A user-owned Pi extension that throws from its own timer or watcher callback (an unhandled promise rejection) kills the whole Archon run process. The run row is left `running` with no owner. `workflow wait` reports `owner_lost`, and the operator has to abandon the run and adopt its worktree into a new one.

Observed on 2026-10-02 on `dev` at `cb6aef939`. Pi/MiniMax dogfood run `c5f2858a` was in its review lenses when the operator's `bench` Pi extension called `ctx.isIdle()` on a session context that a later node's session had replaced. Pi 1.0 threw "This extension ctx is stale after session replacement or reload", the rejection was unhandled, and Bun exited the process (detached log `~/.archon/logs/detached-run-c5f2858a….log`). The extension bug itself is handed to its owner.

## Why it matters

AGENTS.md makes Pi extensions user-owned configuration that Archon loads as Pi configures them. So Archon will run code it doesn't control inside every Pi node. One faulty callback costs the whole run, including nodes on other providers in the same process. It also leaves an orphaned `running` row instead of a failed node that carries the evidence.

## Why now

The multi-provider dogfood surfaced it on the first day of running Pi through the full `archon-ship` pipeline. Every Pi user with an extension that keeps timers is exposed.

## Desired outcome

An unhandled rejection or exception that escapes into the run process while a Pi node is running fails that node with a typed failure whose evidence names the error and stack. The run then ends normally (failed, or retried per `on_error`) instead of the process dying. Errors Archon can't attribute to a node still terminate the process loudly, as today.

## Invariants

- Archon doesn't filter, wrap or rewrite the user's extensions. They load exactly as Pi configures them.
- No error is swallowed. The original error and stack reach the node's failure evidence and the logs.
- The process-level handler doesn't turn a genuine Archon bug into a silent success.
- Run terminal states stay owned by the engine (AGENTS.md lifecycle rules).

## Acceptance

- A test with a fake Pi extension whose timer throws asynchronously during a node: the node fails with that error as evidence, the run reaches a terminal state, and the process stays up.
- A test that an error outside any running node still exits the process non-zero.
- `workflow wait` on such a run reports a terminal failure, not `owner_lost`.

Related: the provider contract work, AGENTS.md "Pi extensions are user-owned provider configuration".
