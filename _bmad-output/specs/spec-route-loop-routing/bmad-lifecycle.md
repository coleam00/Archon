# BMAD Lifecycle Context

The target flow is a story lifecycle with quality gates, not only a two-node review and fix loop.
The source flow is:

1. `SS`: `bmad-sprint-status`, identify the next story.
2. `CS`: `bmad-create-story create`, create the next story.
3. `VS`: `bmad-create-story validate`, gate story readiness.
4. `TD`: `bmad-testarch-test-design`, produce risk-based test design.
5. `AT`: `bmad-testarch-atdd`, generate red acceptance tests or checklist before dev.
6. `DS`: `bmad-dev-story`, implement while following test design and ATDD.
7. `TA`: `bmad-testarch-automate`, expand test automation when coverage is missing.
8. `CR`: `bmad-code-review`, review implementation and return to `DS` when it fails.
9. `RV`: `bmad-testarch-test-review`, review test quality for flaky risk, fixture isolation, and assertion strength.
10. `NR`: `bmad-testarch-nfr`, review reliability, maintainability, CI, or flakiness concerns when relevant.
11. `TR`: `bmad-testarch-trace`, map requirement to test evidence to gate decision.
12. Choose the next story and repeat.

The route loop feature exists to model local quality-gate failure returning to dev or fix work.
When multiple gates contribute to the decision, the workflow should use a gate aggregation node and make `route_loop.from` point at that single gate output.
The source mentions TEA but does not define it; this spec does not define TEA semantics.
