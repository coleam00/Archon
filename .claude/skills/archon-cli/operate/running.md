# Running workflows

How to discover, select and launch Archon workflows against real work, and how to watch
what you launched.

## Discover what exists

```bash
archon workflow list                 # human-readable compact descriptions and errors
archon workflow list --json          # compact descriptions + descriptionTruncated state
archon workflow list <name> --full   # exact description for one candidate
archon plugin add owner/repo     # install a workflow pack published on GitHub
```

The live list is authoritative. Bundled workflows ship under the `archon-` prefix
(e.g. `archon-ship`, `archon-review`, `archon-deliver`, `archon-investigate`,
`archon-triage`, `archon-upkeep`); user-authored workflows may
claim any name and override a bundled one in that repo.

In JSON output, `descriptionTruncated: true` means `description` is a discovery preview,
not the complete routing contract. Human output marks the same state with `[truncated]`.
Use the previews to identify plausible candidates, then run `archon workflow list <name>
--full` for each candidate before choosing or launching. Map intent from those full
descriptions — never from memory of names you have seen elsewhere. If two names plausibly
match, read both full descriptions, then say which you picked and why in one line.

## The input is the contract

Everything the run does is measured against its input — the message, the issue body, or the
document it reads. Archon governs how the work happens; it cannot supply what the user
actually wanted. This is the highest-leverage moment in the whole flow, and it is before any
money is spent.

Check the input names all six. Solution steering is a seventh, optional, and last:

1. **Problem to solve** — what is wrong today, concretely.
2. **Why it is worth solving** — the cost of leaving it.
3. **Why now** — what makes this the moment.
4. **Desired outcome** — what is observably different afterwards.
5. **Invariants** — what must stay true across any acceptable implementation.
6. **Acceptance** — how completion is checked.

**When something is missing, do not fix it silently and do not launch anyway.** Tell the user
which of the six is absent, propose concrete wording, and let them decide. They own the
contract; your job is to notice it is thin before it costs them a run.

A useful shape:

> Before I launch: this brief states the problem and the outcome, but not the invariants or
> acceptance. Without acceptance the run decides for itself when it is done. Suggest adding:
> "Acceptance: X passes, Y is covered by a test, Z is unchanged." Want me to run it with that,
> or would you rather word it yourself?

Two failure modes worth naming, because they look like diligence:

- **Naming a solution before the problem is settled.** It narrows the run to the first guess
  and hides better answers. If the user supplied one, keep it, but make sure the problem is
  stated too — a run that only knows the proposed fix cannot tell you it was the wrong fix.
- **Dropping steering the user actually holds.** Optional does not mean unwanted. If they have
  said anywhere in the conversation how they want this done — reuse a primitive, avoid a
  dependency, migrate rather than rewrite — carry it into the input as explicit steering. An
  unstated preference cannot be honoured, and the user discovers it only in the diff.
- **Silence about uncertainty.** An assumption stated in the brief is something the run can
  contradict. An assumption left out is one it will quietly inherit.

If the input is a GitHub issue, read the actual body before launching rather than trusting the
title. Recommend edits to the issue itself when it is thin — the issue is the durable contract,
and the next run against it inherits whatever you leave there.

## Invocation

```bash
# Default: isolated worktree, detached, non-blocking
archon workflow run <workflow> --branch <branch-name> "<message>" --detach

# Start from a specific base instead of the current branch
archon workflow run <workflow> --branch <name> --from <base> "<message>" --detach

# Foreground (blocks the shell)
archon workflow run <workflow> --branch <name> "<message>"

# No isolation — only when the user explicitly asks to work on the checkout directly
archon workflow run <workflow> --no-worktree "<message>"

# First run for a registered non-git folder project (runs in place; no branch flags)
archon workflow run <workflow> --folder "<message>"

# From another clone of a registered repo: the run belongs to that project
archon workflow run <workflow> --project <owner/repo> --branch <name> "<message>" --detach
```

`--project <id|name>` takes a name or ID from `archon project list`. The run uses the
project's identity, env, artifacts and logs, and never registers the clone you launch
from. Workflow source and config come from the launch directory. A worktree is cut from
the registered checkout, so a branch that exists only in your clone is not there; add
`--no-worktree` to execute in the launch directory instead. It cannot be combined with
`--folder`, `--base-branch`, `--resume` or `--dry-run`.

Rules:

1. **Detached is the default posture.** Workflows are long-running; `--detach`
   returns immediately and the run appears in `archon workflow runs`. In your
   harness, even foreground invocations belong in a background task.
2. **For git projects, pass `--branch`** unless the user chose otherwise. Derive the name
   from the domain of work — code: `fix/<topic-or-issue-N>`, `feat/<name>`,
   `review/pr-N`; ops/process runs: e.g. `ops/<queue>-<item>`,
   `upkeep/<dependency>`, `triage/<source>`. To run on
   different models for one run, see `managing-runs.md` ("Overriding models for one
   run").
   A worktree created for `--branch` stays when the run ends; `archon isolation
   cleanup --merged` removes it after its pull request merges. Without `--branch`, a
   completed run removes the worktree it created on its own generated branch when the
   checkout is clean and every commit is on a remote, keeping the branch. A kept
   checkout is named in the run's output with what removing it would lose.
   Folder projects run in place and reject `--branch`, `--from`, and `--base`.
3. **One workflow per shell.** Multiple pieces of work = separate invocations with
   separate branches; they cannot conflict because each gets its own worktree.
4. **The message is the work order.** Write it as you would brief a competent
   engineer: what outcome is wanted, where the context lives (issue number, plan
   path), and any constraint the user actually stated. See
   `../authoring/prompting-mistakes.md` before writing it.
5. **Interactive workflows need a human at their gates.** Launch them in the
   foreground. When they pause, read the rendered gate message and declared
   decisions from `archon workflow get <run-id> --json` under
   `metadata.approval`; assistant JSONL rows are AI transcripts, not the gate
   contract. Resolve the gate per `managing-runs.md`. Continuation
   actions on the paused run may use `--detach`.

## Inputs

A workflow that declares `inputs:` takes them as `--input <name>=<value>`, one flag
per input. `archon workflow list <name> --full` shows the description; the workflow's
YAML lists each input with its default and meaning. An input without a default is
required, and an undeclared name is refused.

```bash
archon workflow run archon-intake \
  --input repo_host=github.com --input repo_path=<owner>/<repo> --input number=42 --detach
```

Inputs and a message can be combined. Queue workflows such as the SDLC pack's take
inputs only; `queues.md` lists them.

## Monitoring

```bash
archon workflow attention --watch --json    # one stream: decisions and run ends, this project
archon workflow attention --watch --json --all   # the same across the install
archon workflow wait <run-id> --json        # block on one run until it ends or needs attention
archon workflow runs --json                 # recent runs for this project
archon workflow status --json               # active runs (running or paused) for this project
archon workflow get <run-id> --json         # one run: status, outcome, artifacts
archon workflow get <run-id> --verbose --json  # plus per-node detail
```

Terminal statuses: `completed`, `failed`, `cancelled`.

**Watch with one stream.** Right after your first launch, run `archon workflow
attention --watch --json` as a background task of your harness. It follows every run
in scope, including runs started later by triggers, schedules or other sessions, and
prints one JSON line per change:

- `attention`: a run needs a decision. The line carries the whole item; answer it by
  its `runId` and `occurrence` (see `managing-runs.md`).
- `resolved`: the item no longer needs attention.
- `terminal`: a run ended, with its `status` and `outcome`. Read its result.
- `owner_lost`: a run says it is running but its process is gone.

The lines before `ready` are the current open set. Keep the `cursor` of the last line
you handled; after a restart, `--after <cursor>` replays what you missed.

`workflow wait <run-id>` blocks on one run and suits one or two runs. Do not arm one
wait per run for a batch: dozens of waiting processes contend for the database, and a
single stream already wakes you per run. Never chain waits in one shell (`wait A &&
wait B` sleeps on A while B pauses unattended).

**Status is not verdict.** A `completed` run can carry a negative `outcome`. Read it
with `get --json`, find the report under `leave_behind.artifactFiles`, and use a
separate `get --verbose --json` call for node summaries. Read the report before
telling the user what the run concluded. For the bundled SDLC workflows the report
may list discoveries: findings outside the run's scope. The run records them but
files nothing; `archon-discoveries` decides and files them (see `queues.md`).

## Continuing finished work

```bash
archon workflow runs --open                                 # find the prior run id
archon workflow run docs --adopt <run-id> "Now also update the docs"  # new run on the adopted worktree/branch
archon complete fix/issue-42                                # remove worktree + local branch; keeps the remote branch
archon isolation cleanup                                    # prune stale environments (7d)
archon isolation cleanup --merged                           # prune merged ones now
```

## Resuming after failure

A failed or paused run resumes from completed nodes:

```bash
archon workflow resume <run-id>
archon workflow resume <run-id> --detach
```

Detached resume returns after engine acceptance, before completion. Your attention
stream reports the run's next pause or end. If the
60-second acceptance confirmation fails, inspect the run before retrying: the
child may still continue.

The ambient sequential session cursor is not reconstructed by a cold resume.
Explicit `context: { resume: node-id }` ancestry is restored from the completed
source's saved handle, and a paused loop with `fresh_context: false` continues its
pre-pause session when the provider supports it. Use durable artifacts for every
handoff that must survive regardless of provider session availability.
