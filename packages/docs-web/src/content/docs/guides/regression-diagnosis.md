---
title: One-shot regression diagnosis
description: Inspect a pinned checkout with ordinary checks and shared investigation.
---

`archon-regress` checks one explicit revision and reports `healthy`, `regression`,
or `inconclusive`. It composes `archon-validate` and, only for a demonstrated
code-related check failure, `archon-investigate`. Both use the native `medium`
model tier. The workflow does not repair the application or publish tracker items.

Prepare a clean isolated checkout at the full commit object ID you want to inspect.
Run against that checkout with the same ID:

```bash
archon workflow run archon-regress --cwd /path/to/isolated-checkout --no-worktree \
  --input revision=<full-commit-object-id> \
  "Inspect this revision before integration because its ordinary checks may have regressed. Preserve source and tracker state. Report the checks, exact revision, and proven cause or evidence gap."
```

The caller owns checkout preparation. The workflow never switches revisions.
It refuses a different HEAD, tracked modifications, or untracked project files.
Untracked `.archon/` run scaffolding and ignored build/dependency outputs are
excluded from that revision guard. Per-node `mutates_checkout: false` also checks
that validate and investigate leave the checkout intact. This is an integrity
check, not an execution sandbox or a confidential test boundary.

An optional `--input scope=<package-or-check>` narrows validation. Healthy means
that scope's applicable ordinary checks passed. It does not certify untested
behavior or establish when a defect was introduced: there is no baseline comparison.

Configure ordinary checks in the project's scripts and contributor guidance.
Keep factory gates, `agentcheck`, provider launchers and workflow dispatch out of
normal test scripts. Validate inspects aggregate delegates and runs the ordinary
components separately if an aggregate would launch agents. If they cannot be
separated, the gate is unavailable. This workflow does not run runtime agent checks.

| Evidence | Result |
| --- | --- |
| Applicable ordinary checks executed and passed | `healthy / checks_passed` |
| No defined checks (`checks_performed: false`, `green: true`) | `inconclusive / no_checks` |
| Unavailable gate or environmental failure | `inconclusive / infrastructure` |
| Performed failing check without a classified cause | `inconclusive / unclassified_failure` |
| Investigation cannot reproduce and establish the defect | `inconclusive / unrooted` |
| Investigation reproduces and proves the product or check defect | `regression / reproduced_defect` |

Missing producer outputs or reports, malformed verdicts, and changed checkout
identity fail the workflow. They never become a healthy result. An `after` node
records final revision evidence even when an upstream node fails. An engine or
provider execution failure remains a failed run, distinct from a completed
inconclusive diagnosis.

Read `regression.json` or `regression.md` in the run artifacts for the result.
`validation.md` preserves original commands, outcomes and failure output;
`investigation.md` carries the causal evidence when investigation ran.
`regression-before.json`, `regression-checked.json` and `regression-after.json`
record revision checks. The typed workflow return includes `status`, `reason`,
`revision`, `checks_performed`, `summary`, and the discovery sidecar path.

`discoveries/regress.json` is a raw discovery array using the existing `title`,
`claim`, `evidence`, `relation`, and `source_node` contract. A proved defect is
`adjacent` work because repair is outside this detection run. The array is empty
for healthy or inconclusive diagnoses. Detection assigns no tracking IDs and
keeps no cross-run tracking state. Repeated evidence remains available for a
separate governed `archon-discoveries` publication/deduplication run.

Runtime verification is a follow-up integration with `archon-verify-runtime`
after its reviewed contract is stable. That composition must bind the same
revision, preserve scenario coverage and assertion evidence, and distinguish
product failures from unavailable infrastructure before investigation. The
current workflow deliberately has no dependency on that unavailable workflow;
its report explicitly states that runtime verification was not performed.
