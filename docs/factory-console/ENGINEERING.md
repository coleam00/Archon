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

`combined` also carries Archon `dev` (https://github.com/coleam00/Archon, last merged at
4860e0a5f, #253), so it can go upstream. It reads the pack's dev branch (af6d0b4a, the revision
`docs/factory-console/pack-view/` is written for): the pack's dev tracks Archon `dev` and its
main the released Archon, and Archon `dev` no longer loads the pack's main (`returns.final` is
gone). `dev` is brought in as a merge
commit whose second parent is `dev`; landed as a squash or a rebase, that change drops `dev` as
a parent, and the next merge of `dev` conflicts in the same files again.
`dev`'s own engine reads arrive with it and stay (item ends, `work-order.ts`, `item-end.ts`,
observing runs);
the rules below bind what this repository adds, not what `dev` ships.

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
- The installed pack ships no factory view file yet, so on the copy the board cards show titles,
  asks and PR links but no check rounds, returns or running step. To see those, copy
  `docs/factory-console/pack-view/factory-view.json` into the copy's installed pack,
  `.console-home/plugins/packs/<owner>/<name>/<commit>/.shared/` (`pack-view/README.md`).
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
- The view file is one file a pack ships, `<pack>/.shared/factory-view.json`, with one schema
  (`packages/workflows/src/schemas/factory-view.ts`, its How it works picture in
  `factory-view-how-it-works.ts`), read through the generic `pack-declarations.ts` reader from
  the copy of the pack the graph was read from (`packages/core/src/workflows/pack-view.ts`) and
  served by `GET /api/packs/{pack}/view`. It is presentation only: words, groups, the stage
  items leave the map by, How it works, drill-down cards and story wording (no map layout: the
  Overview map is drawn from the graph), and where a console finds an item's check rounds, returns and change
  in its runs' records (`retired`, `rounds`, `returns`, `approves`, `change`, in
  `factory-view-progress.ts`; operator ruling of 2026-11-25, declare-in-view), and the stage a
  retired workflow's items stand at on the board (a `retired` entry `{ workflow, stage }`; a bare
  name places them at none, so they are set aside). The engine reads none of those; the web
  counts rounds and returns, and places those items, from generic run records with them. It holds no step lists, outcome lists, arrows, ask flags, shadow flags,
  settings or stage-group enum; it names the graph's stages, steps and outcomes, and declares
  its groups, each with the `kind` its colour comes from (`lib/view-groups.ts` `groupsOf` is the
  one place the map, Full workflow and the board take their groups from). One path reads it, `servedFactoryView` (`factory-view-read.ts`), when the file is
  read and in `bun run check:factory-view <pack dir>`: each entry is read alone with its own
  schema, then `reconcileFactoryView` (`factory-view-check.ts`) drops each entry naming what the
  graph lacks, keeps a `rounds`, `returns`, `approves` or `change` entry for a missing workflow as
  retired, and reports every in-flow stage, step and outcome without words. Every problem is a
  typed error (`kind`): the console shows them all and draws what is left, and the check exits 1
  on any. The progress declarations are checked too: a workflow is a graph stage or retired, a
  retired workflow's `stage` is one of the graph's flow (else only that placement is dropped), a
  step or loop is one the stage has, and a stage's `returns` agree with its outcomes that read
  `returned`. The Wirasm pack's file is kept at
  `docs/factory-console/pack-view/` until the owner's pack ships it.
- Factory web code stays under `packages/web/src/experiments/console/factory/` (components, pure
  `lib/`, the page routes). On `combined` it holds the curated map, How it works and the stage
  modal, the board card's layer and the board furniture (work orders, Merged, Set aside, the
  Table and the number tiles). It is mounted from Rasmus's pages, and only these files outside
  the folder import from it, tests included: `ConsoleApp.tsx` (the How it works routes and
  `factory.css`), `routes/OverviewPage.tsx` (the number tiles and the map, through
  `factory/PackMap.tsx`), Rasmus's board, `routes/BoardPage.tsx` and its test,
  `routes/board/ItemCard.tsx` and its test, and the project's Needs you tab,
  `routes/ProjectNeedsYouPage.tsx` (the board read, and the board's item key, title and option
  words) and its mounted test, `routes/ProjectNeedsYouPage.dom.test.tsx` (the folder's
  mounted-DOM helper). `ProjectRail.tsx` carries the sidebar Factory entry
  without importing the folder. No lint checks this on `combined` (`scripts/check-factory-imports.ts`
  is not ported); keep the list true when a change adds a mount point. The curated map, How it
  works and the stage modal are drawn whenever the pack ships a view file the server could
  read, with its problems listed above them (`ViewProblems.tsx`); `factory/lib/map-source.ts` is
  the one place that decides, and a pack with no file, or one that does not read, draws the map
  derived from the pack graph.
- Server code is the view-file read (`GET /api/packs/{pack}/view` in `api.packs.ts`, beside the
  graph route; the two share one graph read while it runs, `shareWhileRunning`), and two generic reads with no pack words that the web cannot get from older routes:
  `GET /api/workflows/runs/records` (`api.run-records.ts`, run records without events) and
  `GET /api/forge/subjects` (`api.forge.ts`, issue titles and change merge state).
  Speed is a requirement (DESIGN.md, COMBINED direction), so two things are kept between
  requests. The graph's workflow discovery, nearly all of its cost, is kept while the files it
  reads are unchanged (`packages/core/src/workflows/discovery-cache.ts`, keyed by a stamp of
  every file under the roots discovery reads). That is how DESIGN's "the pack graph is read
  once per pack copy and cached" is met: the rest of the graph read (bindings, trigger checks,
  settings, capacity) reads git and database state a file stamp cannot see, costs tens of
  milliseconds, and runs every request. On an install with trigger files, each file's check
  still discovers its binding's workflows uncached. A server discovers each registered
  project's workflows once just after it starts (`warmPackDiscovery`), so the first board after
  a restart reads a kept discovery.
  The board, Overview and Needs you read a project's items once, through the every-item read
  (`useBoardItems`, `K.boardOrders`): the board's columns and decision strip and the
  Overview's count filter it rather than asking `GET /api/items/window` again, because each
  window read places every item of the project on the server.
  The forge subjects route keeps its answers in a display cache file under the server's home,
  `<home>/cache/forge-subjects.json` (`forge-answer-file.ts`), so a restarted server does not
  ask the forge once per card. A home that has never served (every fresh `dev:console` copy)
  has no file, and its first load still asks the forge once per titleless issue. That file is a cache, not engine state: "new server code only
  reads" still holds for engine data. The page timings are measured with
  `bun scripts/measure-board.ts` (its header says how). The server
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
