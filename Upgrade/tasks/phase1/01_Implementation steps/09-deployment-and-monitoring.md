# Step 09 — Deployment and monitoring

Goal
- Deploy changes safely and confirm success via metrics.

Why
- Ensure improvements persist in real environments; quick rollback if needed.

Scope (isolated)
- Pre-deploy checks, rollout, and monitoring plan

Acceptance criteria
- Deployment completes; acceptance metrics met; no critical errors in logs.

Pre-deployment
1) Full test suite green
2) Benchmarks recorded (payload, load time)
3) DB migration tested in staging; `CONCURRENTLY` handled outside transactions

Rollout steps
1) Apply DB migration (non-blocking)
2) Deploy backend (new defaults, validation, endpoints)
3) Deploy frontend (services, hooks, modal)
4) Monitor metrics: payload size, latency, error rates
5) Verify acceptance criteria

Monitoring & Observability
- Add/verify logs for: request sizes, errors with stacktraces, slow queries (EXPLAIN)
- Track client metrics via browser performance APIs

Rollback
- Indexes can remain; revert frontend/backed to previous versions if necessary
- Optional feature flag for details endpoint

Time estimate
- 30–45 minutes

