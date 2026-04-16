# Cold-Pass Default Checklist (Universal)

**Reviewer instruction:** Walk each `[ ]` item literally. Output PASS / FAIL / N/A
with a file:line reference for every FAIL. Do not summarize. Do not skip.

The #1 heuristic: **one-sided parity.** For every producer touched in the diff,
identify its consumers. For every filter added, identify every sibling endpoint
that needs matching behavior. Multi-agent reviewers miss this because they read
files in isolation — your job is to read them together.

---

## ONE-SIDED PARITY (read/write drift)
[ ] For every function the diff modifies, which other functions call it? Does
    each call site still pass the correct arguments?
[ ] For every new parameter or field: is it threaded through every path that
    reaches the modified function, or only the one the PR author tested?
[ ] For every writer touched: find its readers. Still in sync?
[ ] For every reader touched: find its writers. Still in sync?
[ ] "Sibling endpoint" parity: if PR adds filter/field on endpoint A, do
    siblings (list, detail, count, summary, inventory) need matching behavior?

## CROSS-FILE STATE MACHINES
[ ] If the PR advances a state in one table/record, are all linked states
    advanced together? (Approval workflows, order fulfillment, multi-step
    transitions.)
[ ] Are invariants maintained across the cross-table transition, or only
    per-table?

## MIGRATION / SCHEMA HYGIENE
[ ] Migrations have explicit BEGIN/COMMIT wrappers or transaction guarantees?
[ ] UPDATE-only migrations on existing rows: do they silent no-op on fresh DBs
    where the rows don't exist yet?
[ ] Numeric prefix / filename collisions with existing migrations?
[ ] Schema changes referenced consistently across all code paths (ORM + raw
    SQL + serializers)?

## RESOURCE / FAILURE MODES
[ ] `query[0]` / `.first()` on a multi-row query without ORDER BY
    (non-deterministic on Postgres, MySQL, most engines)?
[ ] New parameter handled for empty string, None/null, special characters,
    very large input?
[ ] Bypasses existing auth, rate-limit, or validation middleware?
[ ] Error paths return the same shape as success paths? (Silent-200,
    partial-failure hidden behind 200 OK.)

## TEST COVERAGE BLIND SPOTS
[ ] Every branch added in the diff maps to at least one test assertion?
[ ] Tests exercise the REAL write path, not direct SQL insert / mock that
    skips triggers, validators, or middleware?
[ ] If the PR introduces multiple backends / modes / providers, does at least
    one test cover each?

## DOWNSTREAM CONSISTENCY
[ ] If public API shape changes, are consumers updated or version-gated?
[ ] Config, environment variables, feature flags: documented and plumbed
    through all environments?

## HARDCODED VALUES
[ ] Hardcoded identifiers (IDs, names, keys, domains) that should be
    config-driven?
[ ] Defaults that only work for the author's happy path but break other
    legitimate inputs?
