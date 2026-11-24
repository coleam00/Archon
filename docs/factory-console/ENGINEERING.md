# Engineering rules for the factory console

What every change in this repository is held to, on top of `AGENTS.md` and
`.archon/engineering.md`. The factory's build, review and test stages read this file as the
project's policy (`.archon/packs/Wirasm.archon-software-factory.yaml`).

## The `combined` branch

Items ordered with `land_on: combined` build on Rasmus's Console stack plus the owner's curated
layer (DESIGN.md, "COMBINED direction", which wins). Their pull requests target `combined`. The
reference for anything v1 showed is `main`'s history (tag `console-v1-full`) and
`fc-runtime/baseline-v1/`; port code from `origin/main` rather than rewriting it. Rasmus's
`title` migration is part of the base; add no new migration.

## The live factory shares this machine

The factory building this repository runs Archon from another checkout, on the home
`~/.archon-fc` (SQLite). Every agent it starts inherits `ARCHON_HOME` and
`ARCHON_FACTORY_LIVE_HOME` pointing there.

- **Never start an Archon server or CLI command that writes, on that home.** The server refuses
  to start on it. To see the console: `bun run build:web && bun run dev:console --port <free port>`.
  That serves on a throwaway home (`.console-home/`, gitignored) seeded once with a read-only copy
  of the live database and of its installed packs (`plugins/`), so real items, runs and the
  pack's workflows show. `--fresh` takes a new copy. `--reopen-asks` reopens, on that copy only,
  the newest wholly answered set of asks per item and workflow, so the board and item pages have
  real asks to look at. Use it only for looking: never confirm an answer on the copy, because settling an
  item's asks there can start a real agent run.
- Pick a free port (not 3090, 3190 or 8864, which are in use); check it first.
- Stop every server and browser you start before you finish. Kill by the PID you started, never by
  process name: other factories run on this machine.
- Tests already use scratch homes (`packages/web/bunfig.toml` preload). Keep it that way.

## Scope of a change

- The v2 direction in `DESIGN.md` (top section) wins over everything here. Main is slimmed to it
  issue by issue: a change is held to these rules for what it touches, and is not returned for
  older code its own issue does not cover (DESIGN.md, "While main is being slimmed").
- No database migrations and no change to engine tables. New server code only reads.
- The engine reads only generic things: items, runs and outcomes, asks with the options their
  workflow declares, item links, the pack graph (`GET /api/packs/{pack}/graph`) and the view
  file. No new pack-specific read model in `packages/workflows`, `packages/core` or
  `packages/server`: nothing there knows rounds, returns, shadows, parked items, discoveries,
  work orders, item stories or stage groups. The web composes those.
- The view schema (`packages/workflows/src/schemas/factory-view.ts` and `factory-overview.ts`,
  found through the generic `pack-declarations.ts` reader, today via `factory-pack-files.ts`) is
  presentation only: words, grouping, order, layout. It holds
  no step lists, outcome lists, arrows, ask flags, shadow flags, settings or stage-group enum.
- Factory web code stays under `packages/web/src/experiments/console/factory/` (components, pure
  `lib/`, the page routes), and nothing outside that folder imports from it, except the three
  files that mount it: `ConsoleApp.tsx` (its routes and `factory.css`), `ProjectRail.tsx` (the
  sidebar entry) and `ProjectViewTabs.tsx` (the Factory tab). `bun run lint` enforces it
  (`scripts/check-factory-imports.ts`). Every other file under `packages/web/src` (the answer
  panel, the ask card, the project tabs apart from that one tab, every generic page and
  component, `theme.css`) stays as it is on Archon dev.
- Server code is `packages/server/src/routes/api.factory.ts`, kept to the view-file reads, and
  two generic reads with no pack words that the web cannot get from older routes:
  `GET /api/workflows/runs/records` (`api.run-records.ts`, run records without events) and
  `GET /api/forge/subjects` (`api.forge.ts`, issue titles and change merge state). The server
  asks the change host through `packages/adapters/src/forge-host.ts`, which finds plugins
  through `@archon/forge/host-plugins` as the CLI's `archon forge` does. Everything a pack's
  words name (rounds, returns, parked, stories, placement) is computed in
  `factory/lib/`.
- A new or changed server route regenerates the web API types: `bun run --cwd packages/server generate:api-types`
  (`check:api-types` fails CI otherwise). Two open changes that both add routes conflict in
  `api.generated.d.ts`; regenerate after rebasing rather than hand-merging it.
- Console token lint: arbitrary sizes need a `console-token-exception` comment with a reason;
  prefer the scale.
- The complexity ratchet (`bun run check:ratchet`) applies to touched functions and files: split a
  component rather than growing one past it.

## Proving a change

The declared validate command is the local check:

```
bun run validate --only generated-files,type-check,lint,format
bun run --cwd packages/web test
bun run --cwd packages/server test
bun run build:web
```

CI (`.github/workflows/ci.yml`) runs that set on every push, and more: the core, workflows, cli,
adapters, server and web suites on Linux (one runner per package, cli split into parts, one test
group at a time), and every test file that reads `ARCHON_TEST_PG_URL` against a Postgres it
starts. A test file that fails there is rerun once by itself and the log says `RETRIED <file>`; a
second failure fails CI. A pull request lists every file that needed a retry. A check need not
repeat any of it, and need not run whole suites on Windows, where the container and symlink tests
fail by design. A review or test check runs
the tests of the packages the change touches (`bun test <dir>` inside the package), and only when
it needs a comparison runs the same tests on the base. Running a whole package suite twice on
Windows costs most of an hour and finds nothing CI does not.

On top of that, anything a person sees is checked in a browser (DESIGN.md, Testing) and the pull
request says what was seen, at which size, with which data. A screenshot path is welcome; a claim
of "works" without having looked is not.

## Stay on the run's branch

Each stage runs in a worktree the engine created on its own branch (`archon/task-...`). The next
stage reuses that checkout and refuses to start when the worktree sits on any other branch, so the
item silently stops. Never `git checkout`, `git switch` or `git checkout -b` another branch in the
worktree, and never rename it. To push the change under another name, push the run's branch to
it (`git push origin HEAD:<name>`) and stay where you are. (2026-11-24: two check rounds never
started because builders left their worktrees on `pr176` and `factory-console/console-matches-dev`.)

## Windows

This machine is Windows. Use Git Bash syntax in bash steps; paths with forward slashes. Bun is
1.4.5. `agent-browser` is on PATH and muted.
