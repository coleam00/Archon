# Code Review Checklist — Senior Developer Reference

A structured pass for reviewing a diff. Work top-to-bottom: a fail at an earlier level usually makes later levels moot.

---

## 1. Correctness — Does it do what it claims?

- [ ] The change matches the stated intent (PR description, ticket)
- [ ] Logic branches are exhaustive (every input shape handled)
- [ ] Edge cases: empty, single, max, off-by-one, negative, zero, very-large
- [ ] `null` / `undefined` / `nil` paths
- [ ] Date/time: timezone handling, DST, leap-year, epoch boundary
- [ ] Numeric: overflow, underflow, floating-point precision
- [ ] Concurrency: race conditions, deadlocks, ordering assumptions
- [ ] Error paths: every catch / except / `if err != nil` does the right thing
- [ ] Idempotency where the operation may be retried
- [ ] Transaction boundaries — partial failures leave consistent state

---

## 2. Security — What happens with hostile input?

- [ ] Input validation at trust boundaries (HTTP, queue, file, env)
- [ ] AuthN before AuthZ; AuthZ on every endpoint
- [ ] Parameterised queries (no string concatenation into SQL/shell/LDAP)
- [ ] Output encoding for the destination context (HTML, JSON, header, log)
- [ ] Secrets: not in code, not in logs, not in error messages
- [ ] PII handling: minimisation, encryption-at-rest, redaction in logs
- [ ] Crypto: standard library only, no homegrown algorithms
- [ ] Random: `secrets`/`crypto.randomBytes` for security-sensitive randomness, not `Math.random`
- [ ] Dependencies: any new dep audited for CVEs and maintenance health
- [ ] CSRF tokens on state-changing requests
- [ ] Rate limiting / abuse protection on public endpoints
- [ ] File uploads: type whitelist, size limit, content scanning, no execution

---

## 3. Design — Is it in the right shape?

- [ ] Single responsibility — function/class does one thing
- [ ] Dependency direction — domain doesn't import infrastructure
- [ ] Interface lives where it's used, not where it's implemented
- [ ] Cohesion high, coupling low
- [ ] No duplicated logic that should be extracted (and no premature extraction)
- [ ] Layer boundaries respected (no DB calls from controllers, etc.)
- [ ] Public API surface is minimal — internals not exposed
- [ ] Backwards compatibility considered for consumers
- [ ] No global mutable state introduced
- [ ] Configuration externalised (no hardcoded URLs/keys/limits in business logic)

---

## 4. Readability — Will the next person understand?

- [ ] Names: descriptive, consistent with codebase, no abbreviations beyond convention
- [ ] Functions short enough to hold in your head (~30 lines guideline, not rule)
- [ ] Nesting shallow — extract or invert conditions to flatten
- [ ] Comments explain *why*, not *what*. None of: `// increment counter`
- [ ] No commented-out code
- [ ] No `TODO` without an issue link
- [ ] No magic numbers — named constants
- [ ] Imports organised; unused imports removed
- [ ] Formatting consistent with the rest of the file
- [ ] Diff readable: one logical change per commit, no unrelated reformatting

---

## 5. Tests — Do they prove behaviour?

- [ ] Tests cover the new behaviour
- [ ] Tests cover the failure modes, not just the happy path
- [ ] Tests are deterministic (no time/random/network without injection)
- [ ] Test names describe the scenario clearly
- [ ] No mocking of code-under-test's own internals
- [ ] No assertions on implementation detail (`._privateState`, internal call counts)
- [ ] Fixtures/factories used over copy-pasted setup
- [ ] Each test asserts one thing (or one cohesive thing)
- [ ] Slow tests are categorised (unit/integration/e2e split)
- [ ] Fast feedback loop — unit tests run in milliseconds

---

## 6. Performance & Scale — Will it hold up?

Only flag where the workload warrants.

- [ ] No N+1 queries (eager-load relations, batch fetches)
- [ ] Indexes exist for new query predicates
- [ ] Allocations in hot loops minimised
- [ ] Sync I/O off the event loop / hot request path
- [ ] Pagination on list endpoints
- [ ] Streaming for large responses
- [ ] Caching: cache key correctness, invalidation strategy, stampede protection
- [ ] Bounded resource use (no unbounded queues, retries, recursion)
- [ ] Connection pools sized for workload
- [ ] Big-O acceptable for the input domain

---

## 7. Operability — Can we run this in production?

- [ ] Logs: structured, at right level, no PII, include correlation IDs
- [ ] Metrics: counters/histograms for key paths
- [ ] Traces: spans cover the work units
- [ ] Health checks reflect real readiness (not just "process is up")
- [ ] Graceful shutdown handles in-flight work
- [ ] Backwards-compatible deploy (rolling restart safe)
- [ ] DB migrations: forward-compatible, no long locks, no data backfills in DDL
- [ ] Feature flags / kill switches where appropriate
- [ ] Runbook updated for new failure modes
- [ ] Alerting threshold reviewed

---

## 8. Documentation — Is the change discoverable?

- [ ] README / docs updated if user-facing
- [ ] CHANGELOG entry if applicable
- [ ] API reference regenerated / updated
- [ ] ADR written if a notable architectural decision was made
- [ ] Inline docstrings for public surfaces
- [ ] Migration notes if breaking

---

## Output Format

Categorise findings clearly:

- **🔴 Blocking** — must fix before merge (correctness, security, data loss risk)
- **🟡 Recommended** — should fix; explain trade-off if not (design, perf, missed test)
- **🟢 Nit** — style, minor naming, optional polish

End with one of:
- **Approve** — looks good, ship it
- **Approve with comments** — small things to address but trust to merge
- **Request changes** — blocking items present
- **Comment** — questions / discussion needed before deciding

Keep it civil, specific, and rooted in evidence ("this could fail when X" not "this is bad").
