# Validation and composition evidence

`archon-validate` normally discovers and runs the project's checks on the current
checkout. Its `scope` input narrows that ordinary path.

When ordinary validation stops before every applicable check runs (a usage limit,
a killed process, a gate that cannot run) and no check that ran failed, it declares
`green: false` with `red_cause: incomplete`. SDLC delivery refuses that result as
unfinished rather than red; the action is to resume the run. The comparison path
never declares `incomplete`.

For an existing workflow that must test a composition, pass `comparison` as the path
to an explicitly authored JSON request. This selects a deterministic script path;
it does not call a model, merge a PR, or infer a gate from a message.

```json
{
  "original_base": "<full original comparison-base commit ID>",
  "base": "<full incoming target or prefix commit ID>",
  "head": "<full change commit ID>",
  "change": "PR 12",
  "base_changes": ["PR 11"],
  "method": "squash",
  "check": {
    "name": "project gate",
    "argv": ["bun", "run", "validate"],
    "environment": "project's named check environment"
  }
}
```

The caller resolves full commit IDs and chooses its check policy before invoking
validation. `original_base` must be an ancestor of `head`. The script reads local
Git objects; fetch them beforehand. It creates three temporary detached worktrees,
executes the same command in each, records the result, then removes only those
worktrees. The caller's checkout is not reset or switched. `merge` and `squash`
construct different candidate ancestry; `rebase` is unsupported.

The command runs at each worktree root with the same captured process environment.
Dependencies are not copied from the caller's checkout. Supply the project's own
locked install-and-check command when setup is needed. An explicit shell argv such
as `["bash", "-c", "the authored project command"]` is permitted; never assemble it
from PR prose. The command has the normal script node's permissions, not a sandbox.
Do not provide merge credentials to a gate that must not have merge authority.

`check.environment` is the caller's external environment identity, not a claim that
a database or network remained immutable. The evidence also records local OS,
architecture, Bun and Git versions. The caller must arrange comparable dependencies
and external resources; transient environmental failures can require further
investigation. No secret environment values are recorded.

## What the result proves

A unique `comparison-*` directory in the run's artifacts retains full revision and
tree IDs, merge bases, method, named incoming prefix, exact command and its digest,
exit statuses, timestamps and logs. `evidence.json` is the observation record;
`validation.md` summarizes it. The result returns a typed `evidence` artifact pointer (null on ordinary validation), so consumers never parse the summary to locate the record. These files remain after worktree cleanup.

- `interaction`: the change alone and incoming base alone passed, while their
  composition failed the same gate. The summary names the recorded changes/prefix
  and failing check, and points to the actual diagnostic log. Three results do not
  isolate one PR within a multi-PR prefix; do not invent a pair from file overlap.
- `introduced`: the composed gate failed without both separate trees passing.
  This preserves the existing conservative default, not a proof of sole blame.
- Empty cause with `green: false`: composition conflicted, records were incomplete,
  or a gate changed tracked or nonignored untracked checkout state. No Git-clean gate verdict
  can be claimed. Execution errors fail the node rather than fabricate results.
- `green: true`: the gate passed on the recorded composition. It does not prove
  the forge will accept a merge or that a later base still has this composition.

`git_clean_after` measures Git-visible state. Ignored dependencies and build outputs
are permitted so the command can install locked dependencies and run the project gate.
They are not part of the recorded Git tree; this is not a proof of a hermetic runtime.
Both composition streams and the exit status are retained even if Git refuses to
compose the revisions before any gate runs.

Ordinary validation cannot emit `interaction`: only the script-backed comparison
producer's schema admits it. SDLC delivery rejects interaction as red; it is not
added to the inherited/environment routes. Local results remain separate from
concluded CI results (#3302).

## Adoption by an existing merger

The workflow owns its response, check policy and authorization. Before using this
proof it must reread authoritative head/base, recompose against the actual base
commit, and compare the resulting identity. `.shared/composition.ts` exposes
`evidenceMatches` for exact request/candidate equality; it never fetches or merges.
This deliberately permits no content-only cache shortcut. Check histories or external
environments may require stronger caller policy even when identity matches.

A held, removed or reordered predecessor invalidates every candidate whose incoming
prefix changed. Recompute and retest that suffix; changed-file overlap cannot decide
which proof is valid. Equal predecessor trees do not preserve subsequent merge
ancestry after squash. Retain both commits and trees, not just content hashes.

Forge operations must distinguish requested conditions enforced at mutation from
preflight observations and post-write verification. Head pinning does not imply
base pinning. Readback can detect a wrong landing after mutation, not prevent it.
Unsupported requested conditions must not be silently weakened. A local-green,
forge-conflicting result is a merge refusal, not another red gate. An unknown write
outcome must be reconciled before retrying.

This component does not install a merge queue or close the stale-green prevention
work by itself. Actual merger adoption and its display/hold behavior remain under
#2596/#3376; #3211 and changes to the Sasha prototype are outside this delivery.
