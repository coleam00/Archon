# Governed GitHub merge

`archon-merge` is independently callable. Its only node runs the colocated,
self-contained Bun script. It never invokes acceptance, tracker transitions,
deployment, or a coding agent. The workflow uses existing script, input, return,
and artifact primitives; it adds no engine schema or application dependency.

## Operator trust

Run a reviewed, trusted copy of this workflow and script under an authenticated
operator's GitHub CLI configuration. The script verifies `gh api user`; GitHub
App installation tokens are not supported by this operator identity check.
The authenticated launcher must supply `target`, `receipt`, and `policy` as
structured workflow inputs. Never let the candidate choose its own policy or
receipt. No trigger-message interpretation or repository policy default exists.

Policy and acceptance must be absolute external file paths. The script resolves
symlinks and refuses files inside the execution checkout or another Git worktree.
These checks prevent accidental repository-local trust; they do **not**
authenticate a file's author. The operator must protect the files, their parent
directories, executable search path, workflow source, and GitHub credentials from
candidate writes using OS permissions or a separate execution identity. A
worktree alone provides no security isolation. Do not run candidate code with
access to that identity. An external path writable by the candidate is not a
trusted policy, even if this path validator accepts it.

## Inputs

- `target`: positive PR number, interpreted in `policy.repository`, or an exact
  `https://github.com/owner/name/pull/123` URL. No other hosts or branch selectors.
- `receipt`: absolute path to trusted external acceptance JSON.
- `policy`: absolute path to trusted operator JSON. There is no default file.

Example policy, denied until deliberately authorized:

```json
{
  "authorized": false,
  "repository": "example/project",
  "base_branch": "release-test",
  "required_checks": ["test"],
  "hold_labels": ["hold"],
  "accept_races": false,
  "stop_file": "/srv/operator/merge.stop"
}
```

Use an OS-native absolute path for `stop_file`, or omit it. Its parent directory
must exist. Any entry at that path stops mutation; inability to inspect it also
refuses. Policy fields other than `authorized`, `accept_races`, and `stop_file`
are required. Omitted authorization and race acknowledgment are false. Unknown
fields and wrong types refuse. `accept_races` is the single explicit addition to
the minimal policy needed to acknowledge the limitations below. It is not
implied by `authorized`.

Acceptance's minimum versioned interface is:

```json
{
  "schema_version": 1,
  "repository": { "owner": "example", "name": "project" },
  "pr": 123,
  "head_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "base_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "verdict": "approve"
}
```

SHAs must be full lowercase 40-character Git SHAs. Unknown versions, other
verdicts, and malformed required fields refuse. Additional receipt evidence
fields are allowed but grant no authority. `parseAcceptance` owns the narrow
validator for the identity subset of the sibling acceptance workflow's receipt;
the parent should derive a shared type after integration. Acceptance uses an
owner/name object on the wire; policy and result use `owner/name` strings.
Repository comparisons are case-insensitive; branch, label, and check
names are exact.

## Merge decision and races

The script checks repository, PR, base branch, same-repository head, draft/open
state, mergeability, hold labels, current base ref, head ancestry, and checks.
Both the current head and base must equal the acceptance receipt; the head must
contain that exact base. A passed label is never acceptance evidence. Forks,
merge queues, and existing auto-merge requests are unsupported. Only ordinary
merge commits are supported, so readback can verify both exact parents. Repos
that permit only squash or rebase must use a different reviewed workflow.

Check reads use GitHub's paginated REST check-run and combined commit-status
objects. Every returned check must be completed with conclusion `success`, or
legacy status `success`. Pending, failed, unknown, skipped, and neutral checks
hold. Each policy-required name must be present and passing; duplicate names
cannot mask a failing result. Policy check names alone do not authenticate the
check publisher: configure GitHub required checks with the intended app identity.

The script repeats remote preflight, then rereads policy and the stop path
immediately before mutation. The mutation is exactly `gh pr merge <number>
--repo https://github.com/<repository> --merge --match-head-commit <accepted-head>`.
It requests neither admin bypass, force, auto-merge, nor branch deletion.

GitHub's ordinary merge interface atomically pins the **head**, not an expected
base or check-run revision. A base update, check rerun, hold, stop, policy
revocation, or merge-queue configuration change can occur after the last read.
Use enforced up-to-date branch protection/strict CI and forge required checks
without bypass permissions to protect base and same-head check races. This
workflow does not audit those protection settings. Setting both `authorized`
and `accept_races` to true is the authenticated operator's explicit manual
authorization accepting these remaining races, including where forge protection
is absent. Keep merge queues disabled throughout the operation: GitHub CLI can
implicitly enqueue or enable auto-merge if one becomes enabled concurrently.
The workflow does not claim a perfect base compare-and-swap or cancel remote
work it cannot prove it owns.

See the [GitHub CLI merge contract](https://cli.github.com/manual/gh_pr_merge),
[REST pull request API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request),
[check-run API](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference),
and [combined status API](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference).

## Result and recovery

The node emits one JSON object and writes the same object to
`$ARTIFACTS_DIR/merge.json` using a temporary file and rename:

```json
{
  "status": "merged",
  "repository": "example/project",
  "pr": 123,
  "head_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "base_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "summary": "Remote merge verified against the accepted base and head",
  "merge_commit": "cccccccccccccccccccccccccccccccccccccccc"
}
```

- `merged`: remote state and the merge commit's two ordered parents match the
  accepted base and head. Already-merged calls return this only for that identity,
  even if the base branch has since advanced. No mutation is needed for readback.
- `held`: operator denial, hold, stop, unsupported PR state, or unready checks.
- `revalidation_required`: changed head/base or missing base ancestry. If
  `merge_commit` is nonempty, the PR has already merged with different parents;
  reconcile manually rather than trying to merge again.
- `failed`: invalid input, failed remote read, or merge not confirmed. After a
  mutation attempt, failed readback means an **unknown remote outcome**. Inspect
  GitHub before retrying. An exit-zero command alone never means merged.

Identity fields describe the acceptance, not a new untested candidate. Before
acceptance can be validated they are empty strings and PR `0`. `merge_commit`
is empty unless remote state reports a merged PR. The script always rereads the
PR after a merge command, including nonzero exit or transport exception. If
merge-parent verification fails, it retains the reported merge commit and asks
for reconciliation. It does not retry the mutation automatically.

A local receipt-write failure preserves the remote status and merge commit in
stdout and appends a diagnostic to `summary`. Preserve the returned JSON in that
case; no local receipt is promised. Result status is workflow data: node exit zero
means a result was returned, not merge authorization or success. Callers must
gate on `status` and handle local recording diagnostics.

## Verification

`bun test ./scripts/sdlc-merge.test.ts` exercises the real decision function,
policy rereads, filesystem boundary, GitHub response adapter, subprocess entry,
readback, and local write failures. The pack fixture executes the real node with
missing external policy; the test harness checks its exact refusal. Tests never
mutate live GitHub. A real merge against a private non-default test branch remains
the integrating operator's post-review validation.
