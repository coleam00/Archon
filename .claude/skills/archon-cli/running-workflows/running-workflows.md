# Running Workflows

How to discover, select, and invoke Archon workflows against real work.

## Discover what exists

```bash
archon workflow list              # human-readable, includes descriptions and errors
archon workflow list --json       # machine-readable
archon workflow search "pr review"  # search the marketplace (installable packs)
```

The live list is authoritative. Bundled workflows ship under the `archon-` prefix
(e.g. `archon-ship`, `archon-review`, `archon-deliver`, `archon-investigate`,
`archon-triage`, `archon-upkeep`, `archon-stabilize`); user-authored workflows may
claim any name and override a bundled one in that repo.

Map intent to workflow by reading the listed descriptions — never from memory of
names you have seen elsewhere. If two names plausibly match, say which you picked
and why in one line.

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
archon workflow runs --json                 # recent runs for this project
archon workflow status --json               # active only (running/paused)
archon workflow get <run-id> --json         # one run: status, error, metadata
archon workflow get <run-id> --verbose --json  # + per-node detail
```

Terminal statuses: `completed`, `failed`, `cancelled`. Poll `get` between other
work rather than sleeping in a tight loop.

**Status is not verdict.** A `completed` run can carry a normalized negative
`outcome`. Read it with `get --json`, locate the report under
`leave_behind.artifactFiles`, and use a separate `get --verbose --json` call for
node summaries. Read the report before telling the user what the run concluded.

## Continuing finished work

```bash
archon continue fix/issue-42 "Now also update the docs"     # start a new run on the existing branch
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
