# Admission

`archon-admit` composes `archon-triage` for grounding and then makes an independent
admission judgment. It changes neither the checkout nor the tracker. The caller
owns labels, scheduling, autonomy, and any later execution.

Inputs are optional strings: `target` defaults to the trigger message when empty;
`policy` is trusted operator text or a path to it; `context` is relevant caller
evidence. Policy and context default to empty. Only a trusted caller may populate
`policy`; never copy an issue body into that input as policy. An unreadable policy
path or missing material evidence requires `needs-human`. No project-specific
policy file is required when available guidance settles the decision.

The returned object contains:

| Field         | Values                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| `disposition` | `accepted`, `deferred`, `rejected`, `needs-human`                      |
| `priority`    | `high`, `medium`, `low`                                                |
| `route`       | `investigate`, `plan`, `deliver`, `no_action`                          |
| `summary`     | Nonempty explanation of the decision, priority, and next step          |
| `assumptions` | String array, possibly empty                                           |
| `rules_cited` | Nonempty string array identifying decisive rules and their application |

Accepted work has an engineering route. Every other disposition has `no_action`.
Settled scope conflicts and proven already solved or stale work are rejected;
legitimate lower-priority work is deferred; unresolved material scope, invariant,
or evidence questions need a human. Triage's `no_action` alone proves none of these.

The judge starts with fresh context and explicitly reads the run's `triage.md`.
It returns structured evidence. A colocated dependency-free Bun script validates
the output and writes `admission.md` and `admission.json` under `$ARTIFACTS_DIR`.
Both contain the decision, cited rules, assumptions, evidence, and the grounding
route and summary. `triage.md` retains the full grounding. The JSON artifact adds
`evidence` (string array) and `grounding` (`route`, `summary`) to the returned fields.
Missing, blank, malformed, or inconsistent fields fail without returning admission.

Run against a work item with an isolated checkout:

```sh
archon workflow run archon-admit --branch assess/work-item \
  --input target=https://github.com/OWNER/REPOSITORY/issues/NUMBER --detach
```

Optionally supply `--input policy=/absolute/path/to/operator-policy.md`.
Admission does not implement the item. `archon-ship` remains the single
issue-to-reviewed-PR entry point after the operator or caller admits work.

Compose with `include: archon-admit` and bind `target`, `policy`, and `context` through
`with:`. Gate later work on the returned disposition as well as route. This workflow
does not launch engineering work. Like triage, it uses fixed artifact names, so run
one admission per artifact directory; use separate child runs for independent items.

Run executable fixtures from the repository root:

```sh
bun run cli workflow test archon-admit --json
bun test ./.archon/workflows/sdlc/admit/
```

Fixtures stub model judgments and triage's report guard except the missing-report
case. The real admission script executes for both accepted and refusal decisions.
Tests separately inspect artifact completeness and refusal on invalid evidence.
These checks prove wiring and deterministic enforcement, not model judgment quality
or external permission isolation. The existing engine enforces checkout integrity;
the prompts require read-only tracker access. Use provider and execution permissions
appropriate to the install. Real model and caller integration testing are separate.
