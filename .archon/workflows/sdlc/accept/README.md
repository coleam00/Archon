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
      "environment_exit_codes": [75],
      "timeout_seconds": 5400,
      "public_description": "Run the project unit suite against the candidate and the base."
    }
  ],
  "gate": {
    "complete": true,
    "description": "The full applicable project gate, including the baseline comparison."
  },
  "context": [
    { "id": "conventions", "source": "base:AGENTS.md" },
    { "id": "invariants", "source": "/operator/acceptance-invariants.md" }
  ],
  "required_evidence": ["acceptance-evidence.json"],
  "protected_paths": ["governance", "checks"],
  "require_isolation": false,
  "max_packet_bytes": 96000
}
```

`schema_version`, `commands`, `required_evidence`, `protected_paths`, and
`require_isolation` are required; `gate`, `context`, `max_packet_bytes`, and each
command's `timeout_seconds` are optional; unknown fields and versions fail closed.
Commands must have unique lowercase kebab-case IDs and nonempty argv arrays. There
is no implicit shell, interpolation, dependency install, or candidate-selected
command. An explicit shell argv is allowed when the operator intends it. Commands
run in order in the candidate checkout with no stdin. Exit zero passes; declared
nonzero environment exit codes (1 through 255), startup failures, and expired
deadlines are inconclusive. Other nonzero exits request changes.
`DATABASE_URL` is explicitly empty for gate processes. Gates needing databases
must create their own scratch database and clean it up. Other native process
environment and provider configuration remain operator-owned.

### Command deadlines

A real gate that runs agent-driven journeys, holdout suites, or semantic mutations
takes far longer than a unit run, so `timeout_seconds` sets each command's deadline.
It defaults to 600 and must be an integer from 1 to 7200; zero, negative, fractional,
non-numeric, and larger values are refused with the rest of the profile. The value
comes only from the trusted profile, never from candidate code, the PR, or the work
order, and `policy_sha256` covers the exact text that determines it. Effective
deadlines reach the judge with the gate declaration, beside each command ID.

Deadlines nest, and the caller owns the ordering: a gate's own internal timeout must
be lower than its `timeout_seconds`, and the sum of the commands must fit the
collection node's own 7,200,000 ms budget. An inner gate that ends itself reports a
real failed check; a gate the recorder has to end is only an environment result, and
an expired collection node produces no receipt at all.

When a deadline expires the recorder ends that command's own process and nothing
else. That is process cleanup, not an OS isolation boundary, and this workflow claims
none: a process the command started and detached from itself is not owned here, and
nothing is ever killed by process name or pattern. This is the second reason to give a
gate an inner deadline, because a gate that ends itself also cleans up its own work.

### Judge packet budget

The judge packet carries the original request, the trusted context, the full diff,
the check records, and the selected evidence, so a small feature with its issue text
and project guidance already runs to tens of kilobytes. The budget defaults to
96,000 bytes, and `max_packet_bytes` moves it as an integer from 1 to 512,000 under
the same strict validation as a deadline. Generic acceptance has no profile and
always uses the default. Above the effective budget the workflow still fails closed:
nothing is summarized away, the judge receives only a notice that material evidence
was withheld, `clipped` is true, and the verdict is inconclusive. The full packet
stays in private artifacts for the operator.

### What the judge is told about a fixed gate

Fixed argv and streams stay private, so without an operator attestation the judge
cannot tell an authorized full gate from an arbitrary zero-exit command and is
right to return inconclusive. `gate` supplies that attestation. `complete` states
whether these commands are the whole applicable gate, `description` explains what
the gate covers, and every command then needs a `public_description`; a profile
declaring `gate` without them fails closed. The judge sees the declaration, the
command IDs and argv digests, and the actual identity and exit status, and may
establish completeness from a complete declaration whose checks all passed unless
the evidence contradicts it. A declaration never establishes a semantic
requirement, and it never overrides a deterministic failure.

`context` supplies the project acceptance context the judge cannot fetch itself:
it has no tools and cannot follow a pointer from `AGENTS.md` into a direction
document. Each entry reads `base:relative/path` from the resolved base SHA or an
absolute external operator path, must be nonempty, and reaches the judge with its
ID, source label, digest, and full text. Nothing is read from the candidate, and
the pack hardcodes no project path. Context shares the packet budget with the
diff and evidence, so select the documents acceptance actually depends on.

### Required evidence must be produced by this evaluation

Required evidence paths are literal repository-relative files, not globs, patterns,
`.git` entries, or names Windows cannot represent. Each must be absent when the
gate starts: a path that is tracked at the candidate SHA, already present in the
worktree, or reached through a symlink is refused rather than treated as output,
and the existing file is never deleted. Presence alone is not proof; a committed
report is a candidate claim, not evidence.

Each file must be JSON with `schema_version: 1`, the `evaluation_id` and full
`identity` of this evaluation, and a nonempty `evidence` string. A report bound to
another evaluation or to another head or base SHA cannot certify this candidate.
Gate processes receive that binding in their environment as `ACCEPT_EVALUATION_ID`
and `ACCEPT_IDENTITY`, alongside `ACCEPT_CANDIDATE_DIR` and `ACCEPT_BASE_DIR` so an
evaluator can run the same behavior against the candidate and the prior application
and report what it actually observed. Contents and hashes are copied to private
artifacts and supplied to the judge, so configure only evidence safe for the
evaluator to publish to a builder; never put private evaluator internals in them.

Protected paths match an exact path or a directory subtree, including deletions
and either side of renames. A `base:` profile automatically protects its own path.
Changes prevent execution and yield inconclusive pending independent trusted
policy reconsideration. Policy JSON is snapshotted and hashed before evaluation.
For an external profile, the operator owns its provenance and lifecycle; the pack
does not implement a policy configuration engine or invent project-specific paths.

## Trust and isolation

GitHub API data supplies the repository, PR number, exact head/base SHAs, and the
metadata a request can require of the PR itself: target and source branch, open
and merged and draft state, title, body, and URL. That metadata reaches the judge
as evidence for linkage and target-branch requirements, never as instructions, and
proves nothing about runtime behavior. Git fetches those commits into a new
temporary bare repository with detached base and candidate worktrees. No remote
branch is checked out in the application's checkout. Identity and that metadata
are checked after execution and again before issuing the receipt; either changing
invalidates the evaluation, as do tracked
candidate mutations. The owned temporary tree is removed
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
The judge sees command IDs, exit status, stream digests, the gate declaration,
trusted context, and explicitly selected evidence.
Generic command output is visible to the judge. Every artifact should
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
| `clipped`              | True if material judge evidence exceeded the effective packet budget; forces inconclusive.                                                 |

Every check contains `id`, the complete `identity` (repository, PR, head/base SHAs),
`argv` (null for private fixed commands), `command_sha256` (SHA-256 of JSON argv),
`source` (`trusted_policy` or the trusted base path plus content digest),
`exit_code` (integer or null when unrunnable/interrupted), `status` (`passed`,
`failed`, `environment`), `stdout`/`stderr` (artifact-relative private paths),
`stdout_sha256`/`stderr_sha256`, and `timestamp`. Streams are retained in full even
when empty. A passed label without this record is not evidence.

`accept-private/` retains the prepared identity, PR metadata, trusted context,
original request and full diff in
`state.json`, the exact profile when supplied, check records and streams, ordinary
check source snapshots, required evidence snapshots, full `packet.json`, the
bounded judge packet in `evidence.json`, and raw `judgment.json`. Material clipping
is explicit and always inconclusive. Finalization verifies stream hashes again.
Artifact write failures fail the workflow rather than fabricate a receipt.

A merge consumer must validate the receipt, require approve, verify the artifact
digests from a trusted run, and resolve the current PR head **and base** again.
This receipt certifies the observed identity at issuance, not a future moving PR.
Unknown identity uses nulls and cannot approve. Deterministic failed checks take
precedence over model approval, and unverifiable identity or evidence makes every
verdict inconclusive. Only approval requires complete verification: a refusal the
judge supports with concrete evidence stays a refusal and keeps its findings when
other acceptance verification is still outstanding, with that gap recorded beside
them as a `verification_incomplete` finding. An unsupported refusal, like any other
unestablished contract, is inconclusive, as is invalid or absent model output.

## Validation

`bun test ./.archon/workflows/sdlc/accept/tests/` runs the registered unit and CLI fixtures.
Fixtures create real temporary Git commits and use a GitHub command harness that
only permits the expected read-only API call. They execute the actual bundled
script against a non-JavaScript checkout, including red and missing evidence.
A further set installs the pack into a scratch project and drives it through the
engine's own discovery and dry run, covering the wiring a direct phase call cannot
reach: declared script inputs, the skipped validation branch, the skipped judge
branch, and the receipt the composed run returns.
Root `bun run test` includes this registration, and root type checking follows its
imports. Live-model behavior and actual private PR acceptance are operator tests;
the deterministic fixtures do not claim to prove model quality or host isolation.
