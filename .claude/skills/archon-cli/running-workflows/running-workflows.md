# Running Workflows

How to discover, select, and invoke Archon workflows against real work.

## Discover what exists

```bash
archon workflow list                 # human-readable compact descriptions and errors
archon workflow list --json          # compact descriptions + descriptionTruncated state
archon workflow list <name> --full   # exact description for one candidate
archon workflow search "pr review"  # search the marketplace (installable packs)
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

# Foreground (blocks the shell) — REQUIRED for interactive-class workflows,
# whose fresh launches refuse --detach
archon workflow run <workflow> --branch <name> "<message>"

# No isolation — only when the user explicitly asks to work on the checkout directly
archon workflow run <workflow> --no-worktree "<message>"

# First run for a registered non-git folder project (runs in place; no branch flags)
archon workflow run <workflow> --folder "<message>"
```

Rules:

1. **Detached is the default posture.** Workflows are long-running; `--detach`
   returns immediately and the run appears in `archon workflow runs`. In your
   harness, even foreground invocations belong in a background task.
2. **For git projects, pass `--branch`** unless the user chose otherwise. Derive the name
   from the domain of work — code: `fix/<topic-or-issue-N>`, `feat/<name>`,
   `review/pr-N`; ops/process runs: e.g. `ops/<queue>-<item>`,
   `upkeep/<dependency>`, `triage/<source>`. To run on
   different models for one run, see the sibling
   `../manage-run/manage-runs.md` ("Overriding models for one run").
   Folder projects run in place and reject `--branch`, `--from`, and `--base`.
3. **One workflow per shell.** Multiple pieces of work = separate invocations with
   separate branches; they cannot conflict because each gets its own worktree.
4. **The message is the work order.** Write it as you would brief a competent
   engineer: what outcome is wanted, where the context lives (issue number, plan
   path), and any constraint the user actually stated. See
   `../prompting-mistakes/prompting-mistakes.md` before writing it (this file stands alone without it).
5. **Interactive workflows need a human at their gates.** Launch them in the
   foreground. When they pause, read the rendered gate message and declared
   decisions from `archon workflow get <run-id> --json` under
   `metadata.approval`; assistant JSONL rows are AI transcripts, not the gate
   contract. Resolve the gate per `../manage-run/manage-runs.md`. Continuation
   actions on the paused run may use `--detach`.

## Monitoring

```bash
archon workflow wait <run-id> --json        # block until the run ends or needs a human decision
archon workflow runs --json                 # recent runs for this project
archon workflow status --json               # active only for this project (running/paused)
archon workflow status --all --json         # active across all projects
archon workflow get <run-id> --json         # one run: status, error, metadata
archon workflow get <run-id> --verbose --json  # + per-node detail
```

Terminal statuses: `completed`, `failed`, `cancelled`.

**Prefer `wait` over polling.** Immediately after a detached launch, arm
`archon workflow wait <run-id> --json` as a *background task of your harness*:
it blocks until the run reaches a terminal state or pauses needing a human
decision, so you are woken exactly when there is something to act on instead of
polling or forgetting the run. The wait is indefinite by default; `--timeout
<seconds>` makes the *wait* give up — it never affects the run itself, and an
indefinite wait is usually right because a killed wait silently orphans your
attention, not the run. Fall back to polling `get` only when you cannot hold a
background task open.

**Batches: one wait per run.** `wait` takes a single run id. When you launch
several runs in parallel, arm one background wait per run id — each completes
independently, so you are woken per run, in whatever order they need attention.
Never chain waits in one shell (`wait A && wait B` sleeps on A while B pauses
unattended), and never funnel a batch through a single polling loop.

**Status is not verdict.** A `completed` run can carry a normalized negative
`outcome`. Read it with `get --json`, locate the report under
`leave_behind.artifactFiles`, and use a separate `get --verbose --json` call for
node summaries. Read the report before telling the user what the run concluded.
For the bundled sdlc workflows, the report may end with a discoveries section
addressed to you — route it per `../manage-run/manage-runs.md` ("Discoveries"):
surface each finding to the user and ask where to log it. The run deliberately
files nothing itself, so a discovery dropped here is lost.

## Continuing finished work

```bash
archon workflow runs --open                                 # find the prior run id
archon workflow run docs --adopt <run-id> "Now also update the docs"  # new run on the adopted worktree/branch
archon complete fix/issue-42                                # remove worktree + branches
archon isolation cleanup                                    # prune stale environments (7d)
archon isolation cleanup --merged                           # prune merged ones now
```

## Resuming after failure

A failed or paused run resumes from completed nodes:

```bash
archon workflow resume <run-id>
archon workflow resume <run-id> --detach
```

The ambient sequential session cursor is not reconstructed by a cold resume.
Explicit `context: { resume: node-id }` ancestry is restored from the completed
source's saved handle, and a paused loop with `fresh_context: false` continues its
pre-pause session when the provider supports it. Use durable artifacts for every
handoff that must survive regardless of provider session availability.
