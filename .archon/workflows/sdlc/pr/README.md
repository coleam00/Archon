# GitHub publication contract

`archon-pr` prepares a template-aware title, body and base, then publishes with
colocated Bun code. It returns `number`, `url`, `head`, `base`, `head_sha`,
`base_sha`, `repository` (owner/name), and `is_draft`. The same record is written
to `$ARTIFACTS_DIR/pr-identity.json`. Existing open same-repository PRs are reused.
Base selection remains preparation judgment, using the existing PR first and
repository guidance and ancestry otherwise. There is no assumed main base.

For an existing PR, publication also applies the prepared title and body after
the gate and push, then verifies their exact values and the unchanged PR identity.
Preparation preserves issue linkage and updates validation claims after repairs.
This prevents a successful correction from leaving the old test counts in the PR.
Only description fields are patched; base and draft state are preserved.

The optional `publication_policy` is an absolute path to operator-owned JSON
outside the candidate checkout (symlinks are resolved before checking):

```json
{
  "command": ["bun", "run", "validate"],
  "protected_paths": ["policy", ".github/workflows"]
}
```

The command is an argv array, executed directly in the candidate checkout with
the host environment. It is authorized by the operator, never derived from issue
text. Paths are literal repository-relative files or directory prefixes, not
globs. Any changed protected path or nonzero command exit refuses publication.
The policy is captured before preparation, and runs on every publication,
including existing-PR updates. Normal operation without a policy retains the
delivery green gate's inherited/environment red classification.

Publication requires a clean feature branch and committed work ahead of the
base. It pins the SHA before preparation, rechecks local and remote identity
after the fixed gate, pushes that SHA without force, and reads the PR back.
The script never commits, rebases, or merges. A failed gate cannot be waived by
model output. Origin must have a single push destination matching its GitHub
fetch repository. New descriptions use an artifact body file and must match
the title/body readback. A remote update racing the final check can still reject the normal
push; readback detects a conflicting result. GitHub does not offer a transaction
combining push and PR creation, so a failed create can leave a pushed branch.
Rerunning safely looks up the existing PR before creating one.

Composition operations `checkout` and `readback` reuse the identity boundary.
Checkout requires an explicit `target_pr` number, `work_order`, and `findings`,
and refuses a primary checkout, dirty files, fork PRs, closed PRs, or stale
fetched identity. It repairs on a fresh local branch named past every branch this
clone already has locally and on origin, so the PR's own branch stays with the
worktree that owns it. `expected_pr` pins an existing PR during publication and
is then the authority on the published head: the local branch is only a checkout,
while the push, base and identity checks follow the PR's head, so a repair never
creates a remote branch or a PR for its local name. Readback reads the expected
PR directly, permits a newly published head on the same PR, and requires the
local checkout to match it and the base identity to remain fixed.

This is GitHub-only orchestration, not a security sandbox. Operators own policy
files and execution isolation; candidate code and agent tools can access the
host's capabilities. Command failure reports retain exit status without echoing
possibly secret output; keep detailed gate evidence in operator-owned artifacts.
