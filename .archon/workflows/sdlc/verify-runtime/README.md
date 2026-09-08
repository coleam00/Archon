# Runtime verification

`archon-verify-runtime` exercises a live target using an agent and returns
`verified`, `failed`, or `inconclusive`. Supply `scenario`, a path to project-owned
JSON, and optionally `candidate`, the expected target identity.

```json
{
  "assertions": [
    {
      "id": "health",
      "description": "GET http://localhost:8080/health; expect HTTP 200 and JSON true"
    }
  ],
  "environment": {
    "ownership": "external",
    "setup": "",
    "start": "",
    "teardown": "",
    "candidate_command": "curl --fail --silent http://localhost:8080/build-id"
  }
}
```

Commands are trusted project Bash commands. Setup/start/teardown are optional;
empty commands use an already running target. Start must return after readiness.
When commands provision an environment, the project owns fresh state on each
setup/start and cleanup via teardown. An external owner must also recover resources
after cancellation, node failure, or host loss. `ownership: external` acknowledges
this required contract; YAML nodes do not provide finally cleanup. Failed teardown
stops retries and returns inconclusive. Consumers must provide a lifetime owner
that tracks resources and cleans them up after every terminal path.

Each normal attempt sequences setup, start, agent verification, identity probe,
evidence checks, then teardown. The agent writes a report and tool evidence into
a newly allocated artifact directory. Missing/invalid JSON, missing coverage,
invalid fields, absent evidence, or report/probe identity disagreement trigger
one retry with fresh agent context and another setup/start cycle. The second
malformed attempt explicitly completes as inconclusive before the engine's loop
limit. `max_iterations` and the final-attempt bound share one YAML anchor.
Unrecovered provider, subprocess, or engine node errors fail the run operationally
and may skip teardown and the typed return. The engine's default transient-provider
retry still applies inside an agent node; it does not refresh the environment and
is separate from malformed-report retry. This workflow adds no broad error retry.

`candidate_command` is required and must probe the actual running target (or the
exact executable being tested). There is no Git fallback. Returned `checkout`
records local Git HEAD when available; it does not prove deployed identity.
The canonical identity is a string with leading and trailing whitespace removed,
including spaces, tabs, and LF/CRLF line endings. The checker applies this rule to
the expected `candidate` input, probe output, and report's `candidate` string;
interior characters remain exact. Non-string report identities are malformed,
without coercion. Returned `candidate` is the canonical target probe value.
A requested-candidate mismatch or failed identity probe is inconclusive, without
retry. An empty `candidate` input checks report/probe consistency only. Probe
correctness is project-owned.

The checker validates exact coverage, field structure, evidence file presence
inside the current attempt, and target identity. It does not parse observation
prose or prove truth from a nonempty file. The agent owns the expected/observed
comparison and per-assertion outcome. A complete observed product failure is
`failed` and is never retried. Missing instructions or unavailable measurements
are `inconclusive`. If any assertion is inconclusive, the overall result is too.
All reports and evidence remain in run artifacts for review.

The returned fields are `verified`, `verdict`, `candidate`, `checkout`, and
`summary`. Only `verified: true` authors a succeeded outcome; failed/inconclusive
author failed outcomes while the workflow lifecycle can complete normally.
Consumers must inspect the verdict, not equate lifecycle completion with success.

Tests in `packages/workflows/src/dag-executor.test.ts` run this YAML through the
real executor with a local HTTP process and a simulated provider. They exercise
tool requests and deterministic nodes, but do not prove live agent behavior.
Run them from `packages/workflows` with
`bun test src/dag-executor.test.ts --test-name-pattern 'archon-verify-runtime live target contract'`.
They cover LF/CRLF command output and reports, single-attempt product failures,
identity mismatches, malformed-report retries, and environment cleanup boundaries.
Consumers validating a provider integration must also run a native provider
against a disposable target and inspect rendered inputs, tool execution, report
fidelity, and candidate binding. Dry-run fixtures cannot establish those
properties or this loop's `until_bash` decisions.

`mutates_checkout: false` and prompt instructions are not a filesystem sandbox;
they do not prevent source edits or protect secrets. Scenario secrecy from a
separate builder is the caller's responsibility. This workflow grants no holdout
isolation and must not recursively invoke the SDLC pack through scenario commands.
