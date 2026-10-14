# Working in the SDLC pack

Conventions for this pack specifically. Project-wide judgment lives in
[`AGENTS.md`](../../../AGENTS.md); the YAML surface is governed by
[`.archon/workflow-language-constitution.md`](../../workflow-language-constitution.md).
How we decide what a workflow should be, agents first, is in
[`CONSTITUTION.md`](CONSTITUTION.md).

## Guards

A guard here must protect an action the node it lives in takes.

**Keep** a guard when it:

- verifies the effect of something this node just did — exit 0 is not proof, and a
  forge can accept a write and silently not apply it; or
- refuses to proceed on a question it asked and could not get an answer to, where
  guessing is irreversible. `archon complete` blocking a branch delete it could not
  prove safe is the shape.

**Cut** a guard when it re-asserts an invariant something else already established.
That belongs where it is established, once — not at each node that depends on it.

**The test: if this pack's fixture suite cannot exercise the guard, it is not a
guard. It is a comment — write it as one.**

That test is mechanical and settles most arguments without debating threat models.
A node the dry run cannot execute — a composed `bash:` node, for instance, which
never receives its caller's `with:` values — can only ever be stubbed, so no
fixture can show the guard working or catch it breaking.

### Why this rule exists

The pack once verified "the checkout is on the branch my PR is on" in three places:
a preflight node before review, the ready flip, and prose inside the correction
prompt for an agent to honour. Three copies, two languages, one of them dependent
on a model's diligence.

None of it was load-bearing. The engine gives a run its worktree, and the pull
request is created in that worktree, so the invariant holds by construction.
Nothing had ever gone wrong — the alarm that prompted the work was investigated
and closed invalid. And the copies did not even cover the steps that would have
suffered most from a drifted checkout: `impl` writes code to that checkout without
checking, and `validate` runs the project's tests against it without checking.

The preflight alone cost 31 lines and a stub in 17 fixtures, for a node no fixture
could ever run. All three copies are gone.

CI is the project's full validation; implementers run only focused checks. Whether
CI is green is judgment, so one agent prompt owns it (`deliver/commands/ci.md`), run
once a round's review passes. It never judges a stale head (it pushes the
checkout's `HEAD` when the pull request is behind it), refuses a head that
conflicts with its base, marks the pull request ready (a
project whose CI skips drafts starts it then), waits however long CI takes, and
answers green, pr_caused, or other. On anything but green it puts the pull request
back to draft before it answers, so a red PR never stays ready. A red the change
caused, or a conflict with the base, goes back to the implementer in the next
round, which merges the base on a conflict, and that correction is reviewed before
CI runs again. A flake or infrastructure failure outside the change gets one re-run
of its failed jobs before the agent answers, recorded as `rerun`; any other red ends
the run not ready, and a defect outside the change becomes a discovery.

The rule is not "never defend against what has not happened" — the two Keep cases
above have not happened either, and both are worth their few lines. The question is
whether the guard is protecting *this node's own action*, or restating something
that was already true when the node started.

## Forge source

One switch selects the source for every pull-request read and write this pack
makes; issue writes go through `gh` either way (see below). CI is read by the
`ci` agent node, not through this switch.
[`.shared/forge.ts`](.shared/forge.ts) owns which one a run selected, and
[`.shared/pr.ts`](.shared/pr.ts) owns the pull-request reads and writes, returning
the same shapes from either source:

- **`gh` (default).** The GitHub CLI, acting on the recorded qualified PR. This
  needs only the authenticated `gh` the pack has always used.
- **`forge` (opt-in).** Set `ARCHON_SDLC_FORGE=forge` in the environment Archon
  runs with, for example `~/.archon/.env`. Operations then go through
  `archon forge`, which needs a forge plugin installed for the PR's host (see the
  forge reference in the docs) and the `ARCHON_CLI_COMMAND` host command that the
  CLI and server publish at startup.

The source is never picked from what happens to be installed. When `forge` is
selected and cannot answer (no host command, no plugin for the host, a failed
operation), the node refuses; none of them falls back to `gh`. Any other value of `ARCHON_SDLC_FORGE` refuses too. The
forge source is for host execution: a container execution receives neither
`ARCHON_SDLC_FORGE` nor `ARCHON_CLI_COMMAND`, so a containerized run uses `gh`.

## Public writes belong to a script

An agent judges and authors; the node after it performs the one public write and
proves it landed. `publish-pr` pushes the branch and opens or reuses the pull
request, and `publish-review` upserts the one marked review comment. Triage's
labels go through `gh` whichever source the run selected, because the forge
contract has no label operation for issues yet. No node files discoveries: the
outcome relays them to the operator. Each acts on the values the agent
before it declared in its typed output, which the engine certified, writes through
the selected source, and fails unless the result reads back — so "the write
failed" and "the write may have landed" stay different outcomes, in the pack as in
the forge contract. Three agents write directly with `gh`: the structure pass's
implementer pushes its own commit to the pull request's branch, and CI pushes a
head that was left behind before it judges anything, ending `other` if it cannot;
`update-pr-body` edits the description, because judging which claims are stale and
rewriting them is the whole job; and `ci` marks the pull request ready and back to
draft around its CI wait. No script reads an
agent-written file to find out what to write.

Which remote holds a repository is decided by its configured URL, never by the
remote's name (`.shared/remote.ts`), so a fork checkout whose `origin` is the fork
and whose `upstream` is the canonical repository fetches the base and pushes the
head where they belong.

That split is also what keeps the source switch out of the prompts. A prompt that
branched on `ARCHON_SDLC_FORGE` would be an invented protocol; `forge.ts` reads it
and the agents never see it.

## Deterministic scripts

Every `script:` node here is TypeScript on Bun, under its own component's
`scripts/` directory. Logic more than one of them needs lives once in
[`.shared/`](.shared), imported by relative path with the extension written
(`../../.shared/report.ts`). That directory is reserved for modules: nothing in it
is a workflow or a named script target, and a node that names one fails at load.

The repository validates them where they live. `.archon/workflows/tsconfig.json`
is the owning configuration — `bun run type-check` compiles that project. Lint
covers every TypeScript file under `.archon/workflows/`, so it needs no globs of its
own. A script placed outside the type-check globs fails `pack-scripts-validation.test.ts`
rather than going quietly unchecked.

Three rules, each protecting something a script cannot get back on its own:

- **Read every binding as a literal `process.env.INPUTS_<NAME>`.** The engine scans
  each script's own source at load and refuses a workflow whose script reads a
  binding no `with:` clause provides. It matches that literal form only, and it never
  follows imports — so a helper that built the key from a name would hide every read
  in the pack from that check, and a renamed binding would surface as a wrong result
  at the end of a paid run instead of a refusal before it started. Pass the value to
  `.shared/io.ts`, never the name.
- **Never call `process.exit()`.** Bun leaves without draining stdout — a 500 KB
  write to a pipe arrives as 131072 bytes, silently. Set `process.exitCode` and
  return; `.shared/io.ts` is the only place that should need to know this.
- **Nothing the target project provides is available.** No `package.json`, no
  `node_modules`, no `tsconfig.json`, no npm dependency. Relative imports within
  the pack and the standard library are the whole surface, which is what keeps
  these workflows runnable against a project in any language.

A vocabulary a node declares in YAML has exactly one owner. A script that routes on
one imports it from `.shared/verdict.ts`; a script that merely consumes another
node's certified value does not restate the list at all.

## Evidence never carries credentials

The engine retains what every exec node prints, so a node's output is the record
whether it set out to keep one or not. Never print a value that can contain a
secret: read it where it is normalized and pass on the normalized form. A remote
URL is the common one — `https://<token>@host/repo` is a perfectly ordinary origin
— so `.shared/remote.ts` reads remote URLs only to normalize them to `host` and
`owner/repo`, and only the remote's name and that identity reach a command line or
a message. Failure messages are the same
surface: interpolating the raw value into one leaks it just as effectively.

That retention is also why a node does not need its own log. The ready flip once
wrote one by hand — every command it ran, echoed into an artifact — which is what
the transcript now holds for free.

## The engineering-conventions sidecar

A repository may declare its architecture in an `architecture.md`, its
engineering conventions in an `engineering.md`, and its product direction in a
direction document, at the root, in a config directory such as `.archon/`, or
wherever its steering files point. The steering files themselves (`AGENTS.md` or
its equivalent) reach every node through the provider's own context, so no
prompt tells a node to read them. Each prompt that judges reads the sidecar
documents its judgment needs, in one shared sentence; the direction document
only where the node decides or judges scope. They are the project's
own values, so a taste finding cites one of them or is left out, and an owner
declines a finding by the same standard. Each read is conditional on the file
existing, so the pack stays portable: a repository without one loses nothing. A
new pack prompt that writes or judges code carries the same sentence.

A project's policy for a decision the pack makes, such as what triage accepts, is
one more sidecar document, found in the same places. The pack ships a default for
each policy document a prompt names, and the project's own document replaces it.
A policy document may be only a pointer to documents the project already has, and
the agent reads what it points to. A prompt names only the policy documents its
decision needs, and agents interpret them; anything that must be exact, such as
label names, stays typed configuration.

## A node's streams are the operator's channel

Retention is not the only reader. Anything a node writes to stderr is sent to the
operator as the run happens, even when the node succeeds — and that copy is not
redacted. So a node speaks for itself: capture what the commands inside it print,
and let only your own authored messages reach the streams. Re-emit a command's
output when it failed and its words are the diagnostic; drop it when it is just a
tool narrating itself. Capture a value's stderr separately rather than merging it,
too — a `gh` update notice merged into a read becomes the value.

## Composition validation

[archon-validate](validate/README.md) accepts an explicit composition request to run
the same project gate on two pinned parts and their composed tree. Its `interaction`
result remains red; delivery holds it rather than treating it as inherited or
environmental. The report retains revision, tree and check evidence for an existing
merger to consume. It does not install a queue or authorize a merge.
