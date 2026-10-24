# God mode

An ambitious, self-improving automation pack built only from primitives the engine
already gives every workflow: child runs and fan-out, durable attention waits, state
documents, structured output, and triggers. It needs nothing pack-specific from the
engine.

You give it a goal. It plans the work, runs it in parallel, proves each result,
remembers what it learned, and earns autonomy from its track record. Running on a
schedule, it studies every workflow in the project, the SDLC pack included, and
proposes improvements: it revises the prompts and policies behind recurring failures,
and writes new workflows for recurring problems. Each proposal arrives as a draft
pull request a person approved.

```
god-mode "<goal>"
  charter ─▶ (clarify once) ─▶ plan ─▶ [approve, unless autonomy is earned]
    ─▶ missions: one god-mode-mission child run per mission, in parallel, each on its own worktree
         execute ─▶ verify (acceptance commands) ─▶ judge (fresh reviewer) ─▶ attempt  ⟲ ≤3
    ─▶ tally ─▶ trust ladder        (state: god-mode/trust)
    ─▶ debrief ─▶ remember lessons  (state: god-mode/lessons)

god-mode-learn                      (scheduled, always on)
  observe every workflow's runs, attention by every label, trust, memory ─▶ reflect
    ─▶ revise existing automation | forge a new workflow | consolidate the memory | nothing

god-mode-revise "<need>"
  baseline health ─▶ revise ⟲ (allowed paths + no regressions + acceptance)
    ─▶ person approves the diff ─▶ draft pull request

god-mode-forge "<need>"
  survey ─▶ author ⟲ validate + dry run ─▶ person approves ─▶ draft pull request
```

## The workflows

| Workflow | What it does |
|---|---|
| `god-mode` | The conductor. Turns a goal into a six-part brief and independent missions, decides from the trust ladder whether a person approves the plan, fans the missions out, and records the outcomes. |
| `god-mode-mission` | One mission as its own governed run. It succeeds only when its acceptance commands exit 0 **and** an independent reviewer with fresh context approves. The implementer never grades its own work. |
| `god-mode-revise` | Changes existing automation: a workflow, prompt, script or policy document under `.archon/`. Its checks are deterministic: only allowed paths, no workflow newly invalid and no fixture newly failing compared with a snapshot taken before the edit, and every declared acceptance command passes. A person approves the full diff. |
| `god-mode-forge` | Writes a new workflow under `.archon/workflows/forged/<name>/` and iterates until `archon validate workflows` accepts it and a dry run reaches an end. A person approves the full file set. |
| `god-mode-learn` | The self-improvement loop. It reads what the engine recorded about every workflow and makes at most one evidence-backed change. |

```bash
archon workflow run god-mode "Make the CLI's error messages name the flag the user got wrong"
archon workflow run god-mode-forge --input need="Triage every new issue labelled bug into ..."
archon workflow run god-mode-revise --input need="The deliver stage keeps ending not ready because ..."
archon workflow run god-mode-learn
```

## Earned autonomy

How much god mode does without asking is computed from what its missions actually did
(`.shared/trust.ts`). No agent can set its own level, and nothing configures it.

| Level | Earned by | Plan gate | Missions without approval |
|---|---|---|---|
| `supervised` | the default, or the circuit breaker | every plan | 3 |
| `trusted` | at least 5 recent missions, 80% passed | every plan | 8 |
| `autonomous` | at least 15 recent missions, 90% passed, the last 5 in a row | none | 20 |

The ladder reads the last 20 outcomes. Two failures in the last three trip a circuit
breaker straight back to `supervised`. A plan wider than its level's cap is always
gated. Every outcome is appended to the `god-mode/trust` state document, so
`archon state log god-mode/trust` shows which run moved the ladder.

## Memory

The debrief distils up to five lessons per run into `god-mode/lessons`, and every
mission reads them before it starts. The learner periodically rewrites the memory into
fewer, sharper lessons, guarded by the revision it read, so a concurrent write fails
the rewrite rather than being lost.

## Improving the SDLC pack, and every other pack

The learner knows no pack's conventions, which is what lets it improve all of them:

- **Run outcomes** are grouped by workflow name, so an SDLC stage that keeps ending
  `failed` stands out next to everything else.
- **Recurring attention** is counted by every label key the open items carry, whatever
  pack set them: `stage` from the SDLC attention block, `build` from the build queue,
  `discoveries`, `god-mode`, or your own.
- **The fix fits the cause.**
  - A prompt or policy that keeps producing the same failure gets a `revise`, which
    changes it in place, for example sharpening an SDLC stage's command or correcting a
    pack policy document.
  - A recurring class of question that needs new automation gets a `forge`: a handler
    workflow, matching the SDLC pack's own rule that "a recurring failure class gets a
    handler".

Both go through the same draft pull request as any other change, so the SDLC pack's own
review and merge queue can pick them up. The reviser reads the target pack's README and
constitution before it edits, and a regression in any of that pack's fixtures blocks
the change.

## Publishing

Every revised or forged change is pushed and opened as a **draft** pull request only
after a person approves it, against the run's base branch. It opens through the GitHub
CLI by default; set `GOD_MODE_FORGE=forge` to open it through Archon's forge seam
(`archon forge pr.create`), which reaches any forge an installed plugin serves.
Nothing in this pack merges.

## Always on

Schedule the learner with a trigger binding. `triggers/god-mode-learn.example.json` is
a template: fill in the IDs from `archon trigger whoami`, test it with `archon trigger
fire --config <file>`, then install it with `archon trigger schedule install` (macOS) or
run the same `trigger fire` command from cron or a systemd timer. See the
[workflow triggers guide](../../../packages/docs-web/src/content/docs/guides/workflow-triggers.md).

## What it never does

- Decide that work succeeded from an agent's prose. Every verdict is a typed field that
  a script derives from exit codes and structured review output.
- Push or open a pull request without a person, or merge at all. Missions end as
  commits on their branches. Revised and forged changes pass an approval wait on the
  full diff before they are pushed as draft pull requests.
- Change its own governance: the trust ladder, these workflows, or the engine. A
  revision touching `.archon/workflows/god-mode/`, `.archon/config.yaml`, or anything
  outside `.archon/` is refused before a person ever sees it.
- Parse prose between nodes. Every hand-off is structured output.

## Engine gaps god mode runs into

Each of these is a general primitive the engine could gain, not a god-mode feature:

- **No run-tree budget.** `budget:` refuses workflows that contain `workflow:` or
  `fan_out:` (#1961), so a god-mode run is bounded by mission caps and attempt limits
  rather than by dollars.
- **Dry runs stop at child runs.** A `workflow:` node cannot be stubbed, so the
  conductor's fixtures prove routing only up to the fan-out (#2818).
- **Dry runs ignore executed verdicts.** `authoredOutcome` reads only stubbed return
  values, so a fixture cannot assert the verdict an executed script authored. The pack
  tests (`.archon/scripts/__tests__/god-mode.test.ts`) cover those decisions instead
  (#4670).
- **No native schedule on Linux.** Native trigger scheduling installs launchd jobs
  only; elsewhere the host scheduler runs `archon trigger fire`.

## Tests

- `bun run test .archon/scripts/__tests__/god-mode.test.ts`: the trust ladder, the
  attempt verdict, the tally, memory, the forge judge, the revision rules, and remote
  parsing for publishing.
- `bun run cli workflow test`: dry-run fixtures beside each workflow, with the
  deterministic scripts executing for real where the fixture says `exec-code: true`.
