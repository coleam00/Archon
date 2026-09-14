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
one retry with fresh agent context and another setup/start cycle. Native
`LOOP_PREV` carries the checker's rejection reason through `prepare-attempt` into
the retry command as report feedback, never as a prior product observation. It is
empty on the first attempt. Each assertion's `evidence` array names engine-captured
calls as `{ "pass": "attempt-uuid", "call_id": "id" }`; add `"attachment": 0`
for an image attachment. The pass is the matching `passes[].producer.attempt` from
the capture manifest, so provider call IDs may repeat across reasks and retries.
Read these IDs from the attempt's `captures/manifest.json`. Arbitrary text files
and textual screenshot claims cannot satisfy capture provenance. The second
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

The checker validates exact coverage, field structure, receipt ownership and
hashes, full output availability, attachments and target identity. It does not
parse observation prose or prove application behavior from captured output. The agent owns the expected/observed
comparison and per-assertion outcome. A complete observed product failure is
`failed` and is never retried. Missing instructions or unavailable measurements
are `inconclusive`. If any assertion is inconclusive, the overall result is too.
All reports and evidence remain in run artifacts for review.

The returned fields are `verified`, `verdict`, `candidate`, `checkout`, `summary`
and `evidence`. Evidence carries exact report/capture paths and hashes, producer
run/node/iteration/attempt, scenario path/hash and hashes of the checker, workflow,
commands and packaged scripts. These references
travel through includes; consumers must use them instead of searching provider sessions.
Only `verified: true` authors a succeeded outcome; failed/inconclusive
author failed outcomes while the workflow lifecycle can complete normally.
Consumers must inspect the verdict, not equate lifecycle completion with success.

Tests in `packages/workflows/src/defaults/runtime-capture.test.ts` exercise the
actual checker and its standalone generated artifact. `src/tool-capture.test.ts`
covers retention failures, completeness and attachment integrity; the capture tests
in `src/dag-executor.test.ts` exercise actual agent and loop dispatch. Run through
the workflows package test script, which preserves module isolation.
Consumers validating a provider integration must also run a native provider
against a disposable target and inspect rendered inputs, tool execution, report
fidelity, and candidate binding. Dry-run fixtures cannot establish those
properties or this loop's `until_bash` decisions.

Capture is opt-in on the verification node. Each result retains at most 1 MiB,
with 16 MiB and 256 calls per authored capture directory across all provider passes.
Known injected and secret-named environment values are redacted before writing; this
is not comprehensive secret detection. Redacted/truncated/unavailable output cannot
support a verified assertion. Failed commands and empty output remain valid
observations; interrupted/unknown command outcomes cannot support verification.

Claude, Codex, Pi, Copilot and OpenCode expose returned text/JSON before Archon
display truncation. Codex stdout/stderr remain merged. Pi and OpenCode truncation
metadata remains explicit; native session files are never read. Copilot retains
native content blocks or detailed output; its potentially shortened content-only
fallback is incomplete. OpenCode attachment URLs are unavailable because they do
not carry owned bytes. Standard returned base64 image blocks from the other
providers are retained as attachments with hashes. Other binary shapes,
native screenshot paths and tools with no returned output are unsupported evidence;
request a supported tool result instead. Full means the representation returned by
the provider, not unlimited tool-internal output or proof of application behavior.

`src/check-evidence.ts` invokes the implementation in the workflows package's
`src/defaults/sdlc/runtime-evidence.ts`, beside the owning receipt schema and Zod
dependency. `bun run generate:bundled` builds `scripts/check-evidence.js` with its dependencies
so frozen workflow sources and binary installations need no monorepo imports.

`mutates_checkout: false` and prompt instructions are not a filesystem sandbox;
they do not prevent source edits or protect secrets. Scenario secrecy from a
separate builder is the caller's responsibility. This workflow grants no holdout
isolation and must not recursively invoke the SDLC pack through scenario commands.
