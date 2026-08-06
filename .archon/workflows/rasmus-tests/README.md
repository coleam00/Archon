# rasmus-tests

Test workflows running on Rasmus's config.

They exercise engine primitives against real GitHub issues, so they need a funded
provider and take minutes per run — that is why they are not in CI. The deterministic
counterparts that *are* in CI live in `../test-workflows/` (`e2e-joins`,
`e2e-fanout-alldone`, `e2e-fanout-allsuccess`).

| Workflow | Exercises |
| --- | --- |
| `t1-fix-issue` | structured output · `when:` · `cancel:` · `loop_group` self-heal via `$LOOP_PREV` |
| `t2-fix-issue-include` + `t2-review-block` | `include:` · `with:` → `$INPUTS` at load · namespacing |
| `t3-triage-fanout` + `t3-probe-issue` | `fan_out` over a runtime list · `max_parallel` · `parent_run_id` |
| `t4-subrun` | `workflow:` child run · `input:` forwarding · output threading |
| `t8-cascade` + `t8-slow-child` | cascade-cancel — needs a concurrent `archon workflow abandon` |

All AI nodes resolve through the `@mini` alias in `.archon/config.yaml`.
