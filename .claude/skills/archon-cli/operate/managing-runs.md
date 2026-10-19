---
name: archon-cli-manage-run
description: Inspect, control, and resolve Archon workflow runs: list/get/status, approve, reject, respond, cancel vs abandon, resume. Read when a run is paused, failed, or the user asks about one.
---

# Managing runs

Every run-control verb, what it actually does, and the gate semantics that are
easy to get wrong. Project listings scope by cwd; full run IDs remain globally
addressable.

## Output contract

- `--json` → one clean JSON object on stdout; logs suppressed. Use when parsing.
- No flag → human-readable text; diagnostics on stderr.

## Overriding models for one run

When the user asks to run on different models for a specific run, rebind the
tier keywords or aliases at launch — the persistent config stays untouched:

```bash
# Rebind one or more tiers / @aliases for this run only; repeat per binding
archon workflow run archon-ship --branch fix/x "..." \
  --model large=pi/minimax/minimax-m3 \
  --model small=openai/gpt-5-mini
```

Spec format: `<tier|@alias>=<provider>/<model-ref>` where `<model-ref>` is what
the named provider expects (for Pi backends that is itself a `<vendor>/<model>`
ref, e.g. `pi/minimax/minimax-m3`). An unknown tier/alias errors with the list
of defined names.

Verify before dispatching real work:

```bash
# dry-run prints each node's resolved provider/model without AI spend
archon workflow run <workflow> "test" --dry-run --model large=...   # see 'runs on:' lines
```

For reusable alternate setups, prefer a config layer instead of long flag lists
(see `../setup/setup-and-config.md`, "Alternate config layers").

## Verbs

| Goal | Command |
|---|---|
| List recent runs (this project) | `archon workflow runs --json` |
| Across all projects | `archon workflow runs --all --json` |
| Filter by status / cap rows | `archon workflow runs --status running --limit 50 --json` |
| One run's status/error | `archon workflow get <run-id> --json` |
| One run with per-node detail | `archon workflow get <run-id> --verbose --json` |
| One run with raw event rows | `archon workflow get <run-id> --verbose --events --json` |
| Active runs (this project) | `archon workflow status --json` |
| Active runs (all projects) | `archon workflow status --all --json` |
| Block until the run ends or needs attention | `archon workflow wait <run-id> --json` |
| Every run that needs someone (this project / all) | `archon workflow attention --json [--all] [--label k=v]` |
| The queue item one run stands for | `archon workflow attention <run-id> --json` |
| Every change in the queue, as it happens | `archon workflow attention --watch --json [--all] [--label k=v] [--after <cursor>]` |
| Classify an item without answering it | `archon workflow attention label <run-id> --occurrence <id> --set k=v --json` |
| Resolve a gate with any declared decision | `archon workflow respond <run-id> <decision> [text]` |
| Answer an attention wait in its form | `archon workflow answer <run-id> --occurrence <id> [--choose <id>]... [--text <t>]` |
| Approve (default vocabulary) | `archon workflow approve <run-id> [text]` |
| Reject (default vocabulary) | `archon workflow reject <run-id> "<reason>"` |
| Stop a running run (its live owner first) | `archon workflow cancel <run-id>` |
| Mark paused/failed/orphaned run cancelled | `archon workflow abandon <run-id>` |
| Resume failed/paused from completed nodes | `archon workflow resume <run-id>` |

## Answering a decision well

An attention item is a question a run cannot settle. Most are written to be answered
by whoever is on top of the runs, which is often you, not the user. Answer the ones
the user's standing direction already decides; bring the user only the ones that are
unclear, risky, or outside what they have told you.

1. Read the whole item: what is being decided, why it matters, the recommendation
   with its evidence and what would change it, the choices and what each does, and
   what happens if nobody answers. Open the evidence links before agreeing.
2. Choose one of the declared choices. When none fits and the item offers `other`,
   choose it and say what to do instead.
3. Give a reason in the text. Workflows record the answer's text with the decision,
   and some write it down as a ruling: the SDLC queues add it to the issue body as a
   dated "Current scope" section that later rounds work from. A bare choice teaches
   the next round nothing.
4. Answer detached, so the continuation does not run in your shell:

   ```bash
   archon workflow respond <run-id> <choice> "<reason>" --detach
   ```

5. Pass `--occurrence <id>` when you answer from an item you read earlier: the
   `occurrence` on its stream line, or `attention.occurrence` from `workflow wait
   --json`. If the run has moved to a different pause, the answer is refused and the
   error names the current occurrence, instead of landing on a question you never
   read.

## The approve/resume two-step

With `--json`, `approve`/`reject`/`respond` **record the decision and stop** —
this command does not execute the run (streaming output would corrupt the JSON).
The answered gate is a due continuation: a running `archon serve`, or
`archon workflow wake [--watch]`, continues it without anyone resuming by hand.
Container runs (including a container write-back gate) are the exception: the
hosts cannot continue them, so run `archon workflow resume <run-id>` yourself.
To record AND continue in this process:

```bash
archon workflow approve <run-id> "ship it"   # no --json: records + auto-resumes; background task!
```

A `wait: attention` pause (`attention.kind: "attention"`) is answered in the `form` it
reports, with one of the `options` ids it lists:

```bash
archon workflow answer <run-id> --occurrence <id> --text "done" --json            # message
archon workflow answer <run-id> --occurrence <id> --choose use-dev --json         # approval/select
archon workflow answer <run-id> --occurrence <id> --choose a --choose b --json    # multi_select
```

`approve`/`reject`/`respond <option>` are shorthand for the same answer. In the
`approval` form `reject` is an answer and does not cancel the run. Like a gate answer,
the answered wait is a due continuation. Answer only what the user actually decided; an
undeclared option is refused. A `legacy:` occurrence is a wait paused before answers
existed: it takes no answer, so `workflow resume` it once its action is done.

To work the whole queue instead of one run, `archon workflow attention --json` lists
every item that needs someone, each with its `kind`, `occurrence`, `form`, `options`,
`labels`, typed `project` and pointers to its transcript and artifacts. Answer an item
by its `runId` and `occurrence` exactly as above. Labels are the user's routing data:
`--label ci=other` selects one class, and `attention label` writes a classification
without answering. Archon never routes by them.

`workflow wait` follows one run whose id you hold. To follow every run in scope,
including runs started later by triggers, schedules or other sessions, run
`archon workflow attention --watch --json --all` as a background task. It prints one
JSON line per change: each `attention` line is an item that needs attention, carrying
the same item the list returns, so treat it as a wake and answer by its `runId` and
`occurrence`. `resolved` means it no longer does, and `terminal` means a run ended. The
lines before `ready` are the whole open set. Keep the `cursor` of the last line you
handled; after a restart, `--after <cursor>` replays what you missed. Exit `4` means the
store cannot read the stream's cursor: rerun without `--after`.

Or deliberately in two steps:

```bash
archon workflow approve <run-id> "ship it" --json   # recorded, resumable: true
archon workflow resume <run-id>                     # executes; background task
```

To let the continuation own a background process, add `--detach` to
`approve`/`reject`/`respond`/`resume`. The parent validates the run and returns an
ack with `continues: true`; the detached child records the decision and continues
without `--json`. Detached `resume` acknowledges after engine acceptance clears the
old pause, so immediately follow it with `workflow wait`. A new pause is still
reported. If acceptance is unconfirmed after 60 seconds, inspect the run before
retrying; the child may still continue.

## Deprecated interactive-loop gates: comment or no comment is a decision

Read the gate state first:

```bash
archon workflow get <run-id> --json | jq .metadata.approval.completionSignaled
```

- `true` and you approve **without** a comment → accept & complete: the node
  finalizes from its already-computed output, no re-run.
- You approve **with** a comment → another full iteration runs using your text
  as feedback.
- Reject always needs a reason. Gates with authored `decisions:` expose it as
  `$gate.output.text`; only deprecated `approval.on_reject` prompts receive
  `$REJECTION_REASON`. At an attention wait, reject is an answer
  (`decision: reject`) and the run continues.

Choose deliberately after reading what the gate produced — not by reflex.

## Cancel vs abandon

- `cancel` stops a running run. When another process owns it, that process is
  stopped and its tree confirmed gone before `cancelled` is recorded. A run the
  cancelling server executes itself, and a `workflow:` sub-run with no owner of
  its own (it runs inside its root), is marked `cancelled` and stops at its
  executor's next status check. Otherwise it refuses and changes nothing when no
  owner answers. Use this to kill real work.
- `abandon` is for paused or failed runs, or a "running" row whose owner is gone
  (crashed host). If an owner still answers on this host, it stops it first, like
  `cancel`. If none answers, it records `cancelled` and prints the host and pid the
  run recorded; when that host is another machine, check there before abandoning.

## Respond: gates beyond approve/reject

Some gates declare decisions beyond the default pair (`respond <run-id> <decision>
[text]`). Read the run's metadata to see which decisions its gates declare before
guessing one.

## Judging a finished run

Terminal ≠ good. The three JSON modes expose different data:

| Command | Read |
|---|---|
| `get <id> --json` | top-level normalized `outcome` (`succeeded`/`failed`) and `leave_behind.artifactFiles` |
| `get <id> --verbose --json` | ordered `nodes` summaries and parse warnings |
| `get <id> --verbose --events --json` | raw `events` rows |

`outcome_field` selects a boolean from the return node, but the run stores only
the normalized top-level outcome. It does not expose the authored field name
(`green`, `ready`, or `rooted`) as another top-level property. Locate the report
through `leave_behind.artifactFiles`, then read the artifact before reporting to
the user.

Report outcomes with their evidence: "completed, review verdict ready:false —
2 findings remain, report at <path>" beats "done".

## Discoveries: the SDLC pack's out-of-scope findings

A convention of the bundled SDLC workflows (`archon-ship`, `archon-deliver`,
`archon-review`, `archon-upkeep`), not of workflows in general. Their review lenses
record proven findings that fall outside the run's accepted scope as discovery records
instead of blocking findings: raw per-producer files at
`<artifacts>/discoveries/*.json` (records of `title`, `claim`, `evidence`, `relation:
unrelated | scope_conflict | note`, `source_node`), consolidated by the review into
the verdict's `discoveries` records and a readable `discoveries.md`.

The run that found them files nothing. Its terminal report lists them, and
`archon-discoveries` later decides every recorded discovery across finished runs:
file an issue with a full brief, track it on the open issue that already covers it,
drop it with a reason, or ask a maintainer. Run that drain rather than filing
discoveries by hand (see `queues.md`, "Discoveries drain").

When the user asks about one run's discoveries before a drain has run:

1. Read the report's Discoveries section and, when it names any, open
   `discoveries.md` (find it through `leave_behind.artifactFiles`).
2. On a failed run, also check the raw `discoveries/*.json` records: consolidation
   runs late, so a run that died mid-flight can hold records no report mentions.
3. Tell the user what the run found. Do not re-litigate the verdict from them:
   `unrelated` and `note` records never affected the run's readiness.

## When a run looks wrong

- Paused unexpectedly → `get --verbose`; look at the failing node's error and the
  gate metadata.
- Failed mid-flight → fix the cause if you can name it, then `resume <run-id>`
  (background task). Resume skips completed nodes.
- A "running" row with nothing alive → verify the process is truly gone, then
  `abandon`.
- Logs live under `~/.archon/workspaces/<project>/logs/`; artifacts under
  `.../artifacts/runs/<run-id>/`. `archon doctor` checks the installation itself.
