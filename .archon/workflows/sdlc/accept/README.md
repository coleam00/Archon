# Independent acceptance

`archon-accept` compares an exact GitHub PR with its original accepted request and
returns the object written to `$ARTIFACTS_DIR/acceptance.json`. It never merges,
changes a PR, posts findings, or changes tracker state. Runtime requirements are
Bun, Git, authenticated `gh`, and a configured Archon model. The evaluated project
does not need JavaScript, dependencies on Archon, or a specific branch name.

Launch the trusted installed workflow, with trusted installed `archon-validate`.
Do not select workflow overrides supplied by the candidate. Operator inputs:

| Input        | Contract                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`     | `https://github.com/OWNER/REPOSITORY/pull/NUMBER` or `OWNER/REPOSITORY#NUMBER`. No inferred repository or PR number. GitHub.com only.                                                    |
| `work_order` | Original accepted request text, an absolute external file path, or `file:absolute-external-path`. Text beginning with `file:` is a path. The file must resolve outside the app checkout. |
| `policy`     | Empty for generic validation; an absolute external JSON profile path; or `base:relative/path.json` to read that blob from the resolved PR base SHA. No candidate policy is loaded.       |

For composition, include `archon-accept`, bind these inputs with `with:`, and read
the include's output. `returns: receipt` exposes the complete receipt, not the
judge's proposal. Approval is `verdict == 'approve'`; workflow success alone is
not approval. The artifact directory must exist outside the application checkout.
Use one acceptance invocation per artifact directory. An existing `accept-private`
directory is refused so stale records cannot certify a new evaluation.

## Generic and strict profiles

Generic acceptance reuses `archon-validate` with explicit scope: discover commands
from a detached trusted base checkout, execute them against the exact candidate
through the bundled command recorder, then collect their real exit codes and
streams. The validator's green label alone is never sufficient. The fresh judge
receives base command definitions, actual streams, the diff, and the original
request. It must establish that the commands cover the applicable gate. No checks,
a failed/missing validation result, or insufficient evidence prevents approval.
Selection and completeness in this mode involve agent judgment. Candidate changes
to check implementations remain untrusted evidence and must be assessed for
weakening even when commands themselves came from the base.

A strict profile pins argv commands, required evidence files, and protected paths.
For example, this external JSON profile invokes an operator-owned evaluator:

```json
{
  "schema_version": 1,
  "commands": [
    {
      "id": "acceptance-gate",
      "argv": ["bun", "/operator/evaluator.ts"],
      "environment_exit_codes": [75]
    }
  ],
  "required_evidence": ["acceptance-evidence.json"],
  "protected_paths": ["governance", "checks"],
  "require_isolation": false
}
```

All five fields are required; unknown fields and versions fail closed. Commands
must have unique lowercase kebab-case IDs and nonempty argv arrays. There is no
implicit shell, interpolation, dependency install, or candidate-selected command.
An explicit shell argv is allowed when the operator intends it. Commands run in
order in the candidate checkout, each with a ten-minute timeout and no stdin.
Exit zero passes; declared nonzero environment exit codes (1 through 255), startup
failures, and timeouts are inconclusive. Other nonzero exits request changes.
`DATABASE_URL` is explicitly empty for gate processes. Gates needing databases
must create their own scratch database and clean it up. Other native process
environment and provider configuration remain operator-owned.

Required evidence paths are literal repository-relative files, not globs. They
must be nonempty and resolve inside the candidate tree. Their contents and hashes
are copied to private artifacts and supplied to the judge. Configure only evidence
safe for the evaluator to read; never put private evaluator internals in these
files. Presence alone is not proof: committed candidate reports and self-reports
remain claims. A fixed evaluator should write fresh behavioral evidence.

Protected paths match an exact path or a directory subtree, including deletions
and either side of renames. A `base:` profile automatically protects its own path.
Changes prevent execution and yield inconclusive pending independent trusted
policy reconsideration. Policy JSON is snapshotted and hashed before evaluation.
For an external profile, the operator owns its provenance and lifecycle; the pack
does not implement a policy configuration engine or invent project-specific paths.

## Trust and isolation

GitHub API data supplies the repository, PR number, and exact head/base SHAs. Git
fetches those commits into a new temporary bare repository with detached base and
candidate worktrees. No remote branch is checked out in the application's checkout.
Identity is checked after execution and again before issuing the receipt. Tracked
candidate mutations invalidate the evidence. The owned temporary tree is removed
before the receipt is issued; a cleanup failure is inconclusive and its manifest
identifies the directory for operator cleanup. A killed process can leave that
directory behind; no background orphan or ownership inference is performed.

These worktrees are **not security sandboxes**. Running candidate code can reach
the host, credentials, and same-user artifacts. A separate artifact directory and
hashes expose accidental drift; they are not an attestation against malicious
same-user code. Run on an operator-provided disposable execution environment when
the candidate is untrusted. This workflow cannot attest such a boundary, so
`require_isolation: true` always returns inconclusive before commands or judge
execution. It does not infer isolation from a worktree or an empty tool list.

The judge uses `context: fresh` and requests `allowed_tools: []`. Providers that
support tool restrictions can enforce that request. Codex currently cannot; its
native configuration remains intact, and this workflow makes no tool-enforcement
claim. There is no provider capability expansion in this pack.

Fixed policy source, argv, and logs are withheld from the judge and repair text.
The judge sees command IDs, exit status, stream digests, and explicitly selected
evidence. Generic command output is visible to the judge. Every artifact should
remain private unless the operator reviews it for publication. Nothing is posted
by this workflow. Passing tests alone cannot establish semantic acceptance.

## Receipt version 1

The exported `Receipt` type and `parseReceipt` in `scripts/accept.ts` define the
consumer boundary. The standalone bundled script has no package imports; consumers
can use the parser or implement the documented contract with conformance tests.

| Field                  | Meaning                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema_version`       | Literal `1`.                                                                                                                               |
| `repository`           | `{ owner: string, name: string }`, or null when identity could not be resolved.                                                            |
| `pr`                   | Positive safe integer, or null with unknown identity.                                                                                      |
| `head_sha`, `base_sha` | Exact lowercase 40-character commit hashes; both null with unknown identity.                                                               |
| `verdict`              | `approve`, `request_changes`, `reject`, or `inconclusive`.                                                                                 |
| `summary`              | Nonempty public-safe explanation.                                                                                                          |
| `findings`             | Array of `{ code, summary, evidence: string[] }`. Evidence entries are check IDs or public candidate references. Approval has no findings. |
| `checks`               | Execution evidence records described below; approval requires at least one, all passed for the receipt identity.                           |
| `timestamp`            | ISO timestamp at receipt issuance.                                                                                                         |
| `work_order_sha256`    | SHA-256 of the resolved original request text.                                                                                             |
| `policy_sha256`        | SHA-256 of the exact trusted policy text, or null for generic mode.                                                                        |
| `evidence_sha256`      | SHA-256 of the private `evidence.json` bytes.                                                                                              |
| `judgment_sha256`      | SHA-256 of the received structured judgment text, or null when invalid/missing.                                                            |
| `isolation`            | Literal `fresh_context_only`; never an enforced sandbox claim.                                                                             |
| `clipped`              | True if material judge evidence exceeded the 24,000-byte packet budget; forces inconclusive.                                               |

Every check contains `id`, the complete `identity` (repository, PR, head/base SHAs),
`argv` (null for private fixed commands), `command_sha256` (SHA-256 of JSON argv),
`source` (`trusted_policy` or the trusted base path plus content digest),
`exit_code` (integer or null when unrunnable/interrupted), `status` (`passed`,
`failed`, `environment`), `stdout`/`stderr` (artifact-relative private paths),
`stdout_sha256`/`stderr_sha256`, and `timestamp`. Streams are retained in full even
when empty. A passed label without this record is not evidence.

`accept-private/` retains the prepared identity, original request and full diff in
`state.json`, the exact profile when supplied, check records and streams, ordinary
check source snapshots, required evidence snapshots, full `packet.json`, the
bounded judge packet in `evidence.json`, and raw `judgment.json`. Material clipping
is explicit and always inconclusive. Finalization verifies stream hashes again.
Artifact write failures fail the workflow rather than fabricate a receipt.

A merge consumer must validate the receipt, require approve, verify the artifact
digests from a trusted run, and resolve the current PR head **and base** again.
This receipt certifies the observed identity at issuance, not a future moving PR.
Unknown identity uses nulls and cannot approve. Incomplete evidence takes precedence
over repair findings; deterministic failed checks take precedence over model
approval. Invalid or absent model output is inconclusive.

## Validation

`bun test ./.archon/workflows/sdlc/accept/tests/` runs the registered unit and CLI fixtures.
Fixtures create real temporary Git commits and use a GitHub command harness that
only permits the expected read-only API call. They execute the actual bundled
script against a non-JavaScript checkout, including red and missing evidence.
Root `bun run test` includes this registration, and root type checking follows its
imports. Live-model behavior and actual private PR acceptance are operator tests;
the deterministic fixtures do not claim to prove model quality or host isolation.
