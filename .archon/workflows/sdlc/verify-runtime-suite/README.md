# Runtime control suites

`archon-verify-runtime-suite` runs a caller-owned finite manifest through the
existing `archon-verify-runtime`. All AI work uses that workflow's native
`verify-runtime` command node. The suite adds no agent or report parser.

```json
{
  "baseline": "healthy-control",
  "cases": [
    {
      "id": "healthy-control",
      "scenario": "healthy.json",
      "candidate": "calculator-healthy-control-v1",
      "expected_verdict": "verified"
    },
    {
      "id": "deliberate-negative-control",
      "scenario": "negative.json",
      "candidate": "calculator-negative-control-v1",
      "expected_verdict": "failed"
    }
  ]
}
```

Supply `manifest` as a named workflow input. The manifest admits 2–16 cases,
unique nonempty IDs, nonempty canonical candidate identities, existing scenario
files, a named baseline expecting `verified`, and at least one deliberate control
expecting `failed`. Strings must have no surrounding whitespace or NUL. Identity
interior characters remain exact, following the runtime verifier's identity
contract. Relative scenario paths resolve against the manifest's directory;
scenario commands still run in the workflow checkout. No case can opt out.

YAML schedules at most two cases concurrently using `include` plus `fan_out` and
`join: all_done`. The admitted scenario paths bind directly to the runtime's
`scenario` input. The runtime checks report/probe agreement; the suite compares
the returned probe identity with the corresponding manifest candidate. A wrong
identity can never satisfy an expectation. The existing runtime workflow alone owns the
two-attempt malformed-report budget. Each attempt retains its unique tempfile
directory under run artifacts, including evidence from earlier malformed attempts.

The typed return includes every configured case, its expected and observed target
identities, underlying runtime verdict, full runtime return or engine failure
marker, and expectation comparison:

| Comparison | Meaning |
| --- | --- |
| `matched` | Exact identity and expected `verified`/`failed` verdict |
| `escaped` | A negative control unexpectedly returned `verified` |
| `unexpected_failure` | A healthy control returned `failed` |
| `unavailable` | Inconclusive runtime assessment, missing return, or operational failure |
| `wrong_identity` | A conclusive return belongs to another candidate |

Node/provider failure cannot satisfy a negative control even if partial evidence exists.
`executed` means a typed runtime assessment was returned. `all_cases_executed`
requires one such assessment per configured case; inconclusive assessments still
cannot satisfy expectations. Missing or extra aggregate entries fail closed.

`expectations_passed` authors the suite outcome. `verdict` is `passed`, `failed`
for measured expectation violations, or `inconclusive` when any required
measurement is unavailable. `baseline_verification` and `baseline_verified`
report the selected healthy case independently, including when another control
escapes. **Suite expectations passing is not candidate verification or merge
authorization.** A caller must bind the baseline to its intended candidate and
apply its own promotion policy. The suite exposes no generic `verified` field.

Attribution names this run, fan-out node, manifest ordinal, and the relative
runtime return and agent nodes. The engine's durable `fan_out_instances` event
maps each ordinal to the instance identity and scope. Prefix the relative node
with `<snapshot step_name>__<instance identity>__cases__<instance identity>__` to
locate its events, including `verify-loop.prepare-attempt`, which records each evidence directory.
These are nodes in the parent run; there are no child run IDs. Resume uses the
engine's frozen case snapshot and completed nodes; it does not replay completed
cases. Use a new run for a changed manifest or changed scenario content.

The caller owns all case data and an environment host that outlives the suite.
The host must isolate concurrent targets and recover their resources after any
terminal path. Cancellation can stop admission and prevent the suite's typed
return; inspect engine status/events in that case. Neither this composition nor
the runtime verifier promises finally cleanup, source write protection, or
holdout secrecy. `mutates_checkout: false` declares intent, not a sandbox.

## Ordinary CLI example

The `examples` directory contains a tiny Node calculator, two runtime scenarios,
and a manifest. The negative calculator deliberately returns the wrong sum; it
is a control, not a discovered application defect. No HTTP service, Python
application, factory import, or external environment process is needed. Run from
this repository root (the scenario commands name paths relative to that root):

```bash
archon workflow run archon-verify-runtime-suite --input manifest=.archon/workflows/sdlc/verify-runtime-suite/examples/manifest.json
```

The workflow's deterministic scripts still require `uv`, as does the composed
runtime workflow. Configure the runtime's `medium` provider tier normally. A
native provider run spends model tokens; the executor tests simulate that provider
while executing the real packaged composition and deterministic nodes against
disposable HTTP targets. From `packages/workflows`, run:

```bash
bun test src/dag-executor.test.ts --test-name-pattern 'archon-verify-runtime-suite packaged contract'
```
