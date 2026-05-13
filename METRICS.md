Adding Estimation Metrics to Archon Workflows

1. What's already instrumented (a baseline)
   Reviewing the attached workflows, Archon already has good bones for telemetry:
   • Run identity: every run has $WORKFLOW_ID and a per-run $ARTIFACTS_DIR/ for traceable artifacts.
   • Event emission already exists: archon-ralph-dag.yaml calls bun run cli workflow event emit --run-id $WORKFLOW_ID --type ralph_story_started — so there's a CLI-level event bus you can extend rather than reinvent.
   • Node-level outputs: $nodeId.output is captured, including for bash/script nodes, which means input/output shape is recoverable per node.
   • State persistence: repo-triage, maintainer-standup, and the closed-dedup nodes already write JSON state files under .archon/state/ and .archon/maintainer-standup/. Same pattern can carry estimation data.
   • Structured artifacts: most workflows write plan.md, implementation.md, validation.md, fix-report.md, etc. — these contain the qualitative narrative an estimator would want.
   • DAG metadata: depends_on, trigger_rule, when:, model:, loop.max_iterations, timeout, and idle_timeout are all in the YAML, which means the engine knows the planned shape and can compare against actuals.
   What's missing is a standardized layer that captures quantitative, comparable signals across runs in a form an estimation model can train on.
2. What estimation models actually need (research summary)
   I researched current practice in two directions: classical software estimation models (COCOMO/COCOMO II, Use Case Points, story points, function points) and modern AI-agent observability (OpenTelemetry GenAI semantic conventions, Langfuse, Arize, LangSmith, Helicone).
   From classical estimation literature
   COCOMO is a parametric software cost estimation model where parameters are derived from fitting a regression formula using data from historical projects (63 projects for COCOMO 81 and 161 projects for COCOMO II). The lesson is that estimation models need a long, normalized historical dataset of completed work paired with the actual effort it took. COCOMO uses size (KLOC) as the base, then applies cost drivers — development environment, user involvement, memory constraints, technique used — that are determined from historical data of past projects. WikipediaSlideshare
   Building a reliable effort estimation model usually requires historical data, and since information available at early stages is scarce, software size metrics are recommended as the key cost factor. The practical implication for Archon: capture both a size proxy (issue scope, PR diff size, files touched, story count) and the actual effort consumed (wall-clock time, agent iterations, retries, tokens, human gate latency) so a regression can be fit later. arxiv
   A 2017 study comparing modern alternatives (CART, nearest-neighbor, clustering, feature selection) against COCOMO concluded that for project data in COCOMO format, despite decades of work on alternate methods, the best predictions still come from the parametric method. The takeaway: don't over-engineer the model up front. Capture the raw signals well, and start with linear regression on size + a small set of cost drivers. arxiv
   From AI-agent observability practice
   AI agent observability extends traditional monitoring by incorporating AI-specific telemetry — such as token usage, agent decision paths, and tool interactions — alongside classic metrics, events, logs, and traces (MELT data). Dashboards should answer whether agents are doing their jobs, not just whether services are up — track task completion rates, evaluation scores, tool-call accuracy, drift indicators, and cost per request, broken down by agent, route, and model. MediumGroundcover
   The industry convergence is on OpenTelemetry's GenAI semantic conventions. The GenAI observability project and OpenTelemetry's emerging semantic conventions aim to unify how telemetry data is collected and reported. For Archon, that means: when you instrument, emit OTEL-compatible spans rather than a bespoke schema, so the data is portable to Langfuse/Arize/Datadog/VictoriaMetrics later without rework. OpenTelemetry
3. Specific metrics to add, organized by estimation purpose
   Here's the concrete recommendation. I've grouped metrics by what they let you predict, then mapped each to where it fits in the existing Archon model.

# Metric category Specific signals Why it matters for estimation Where it fits

1 Workflow size proxy (input) Issue body word count; PR additions/deletions; changedFiles; classifier scope (small/medium/large); story count from prd.json; sprint count from archon-adversarial-dev This is the independent variable in any regression. Without a size signal you can't normalize effort across runs. Add to scope/classify nodes that already exist (e.g. archon-fix-github-issue-experimental's classifier already emits scope). Persist alongside outcomes.
2 Wall-clock effort (output) Per-node start/end timestamps; per-workflow total duration; time-in-queue vs time-executing; idle vs active node time Wall-clock is the most trusted "actual effort" signal once the workflow is unattended. Engine-level: emit node_started/node_completed events with timestamps. Already partially there via event bus.
3 Agent iteration cost Loop iterations consumed vs max_iterations; retry counts inside a node; number of tool calls; idle_timeout exhaustions; bash command count Loops + retries are the largest source of variance. A workflow that completes in 2 ralph iterations vs 15 is 7× the cost at the same nominal scope. Loop nodes already track iteration count internally — just persist it.
4 Token & dollar cost Input tokens, output tokens, cache-read tokens, cache-write tokens per node; provider; model id; computed $ cost Direct economic estimate. Also the only signal that scales with reasoning complexity rather than wall-clock. Provider adapters know this — surface it to the event bus. Already partially captured (Pi sessions log provider and modelId in jsonl per the e2e-minimax-smoke workflow).
5 Human gate latency Approval node wait time (between gate posted and reviewer responded); rejection count per gate; rejection reasons (capture_response) Many workflows include approval: nodes. Human latency dominates wall-clock for interactive flows and must be separated from agent latency. Approval nodes already capture responses — add timestamp deltas.
6 Validation outcomes type-check pass/fail; lint pass/fail; test count + pass/fail; build pass/fail; review-agent severity counts (CRITICAL/HIGH/MEDIUM/LOW); fix attempts before green Lets you separate "successful run" from "successful but flaky run" so estimates aren't polluted by survivorship. Archon-validate node already emits a structured PASS/FAIL line. Just standardize and persist.
7 Quality outcomes (the lagging indicator) PR merged Y/N; merged within how many days; CI passed Y/N; reverted Y/N; review comment count; changes requested count; reopened-for-fixes count This is what makes the dataset useful for prediction. Without an outcome label, you can't tell good runs from bad. Daily/weekly batch job: query GitHub for PRs the workflow opened (.pr-number is already persisted) and update their final state.
8 Cost-driver classification Issue type (bug/feature/refactor/etc), area (web-ui/api/cli/db/...), confidence (high/medium/low), needs_external_research, scope (small/medium/large), e2e_testable Y/N These are exactly COCOMO's "cost drivers" and the classifiers already emit several of them. They're the categorical features in the regression. Already emitted by classify, review-classify, classify-testability, smoke-validate nodes. Just persist them.
9 Workflow shape Workflow name; node count actually executed (vs defined); branches taken (when: decisions); skipped nodes; parallelism observed A trivial PR running through archon-comprehensive-pr-review legitimately costs more than the same PR through archon-smart-pr-review. The shape matters. DAG engine knows this at runtime. Emit node_skipped/node_executed events.
10 Tool/operation counts Files read; files written; bash commands run; web fetches; project-knowledge searches; sub-agent (Task) calls A finer-grained productivity signal. Particularly useful when token counts are unavailable (deterministic nodes). Hook into the agent's tool-use stream (Claude/Codex/Pi all emit tool-use events).
11 Failure taxonomy Failure mode tag: timeout / model_error / type_check_failure / test_failure / approval_rejected / merge_conflict / human_abort Without this, all failures look the same to a regression model. With it, you can predict "this scope on this codebase tends to fail validation X% of the time" and inflate estimates accordingly. Engine-level outcome tagging at run completion.
12 Codebase context fingerprint Repo identifier; language mix; LOC of repo; CLAUDE.md hash; test framework; package manager; commit SHA at run start Effort is wildly different across codebases. A "small" issue in a 500k-LOC codebase isn't the same as in a 5k-LOC one. The fingerprint normalizes across repos. One-time per run, captured at workflow start. 4. How to wire it into Archon (concrete approach)
There's a clean implementation path that respects the existing architecture:
a) Event schema as the foundation. Archon already has bun run cli workflow event emit --run-id ... --type ... --data '{...}'. Standardize the event types and payloads using OpenTelemetry GenAI semantic conventions where possible. Define a small enum:
node_started, node_completed, node_skipped, node_failed,
loop_iteration, retry_attempted,
tool_called, model_invoked,
approval_posted, approval_resolved,
validation_run, classifier_emitted,
workflow_started, workflow_completed
Each event carries {run_id, node_id, ts, ...payload}. The CLI already supports this — just formalize the payload schema and have the engine emit them automatically rather than asking each workflow author to remember.
b) Per-run metrics file. At workflow completion, write $ARTIFACTS_DIR/metrics.json summarizing the run. This becomes the durable record. Schema:
json
{
"schema_version": 1,
"run_id": "...",
"workflow": "archon-fix-github-issue",
"started_at": "2026-05-09T12:00:00Z",
"completed_at": "2026-05-09T12:47:13Z",
"wall_clock_ms": 2833000,
"outcome": "success|partial|failed",
"failure_mode": null,
"input": {
"size_proxy": { "issue_words": 412, "pr_additions": 187, "pr_deletions": 23, "changed_files": 5 },
"classification": { "type": "bug", "area": "core", "scope": "small", "confidence": "high" }
},
"execution": {
"nodes_defined": 24,
"nodes_executed": 18,
"nodes_skipped": 6,
"loop_iterations": { "implement": 4 },
"retries": { "validate": 1 }
},
"cost": {
"tokens_in": 142337,
"tokens_out": 18204,
"tokens_cache_read": 89102,
"usd": 1.83,
"by_node": [ { "id": "implement", "model": "opus", "tokens_in": 84000, "usd": 1.21 } ]
},
"human": {
"approval_gates": 1,
"approval_wait_ms": 1340000,
"rejections": 0
},
"quality": {
"validation_passed": true,
"review_findings": { "CRITICAL": 0, "HIGH": 1, "MEDIUM": 3, "LOW": 5 },
"fixes_applied": 9
},
"outcome_followup": {
"pr_number": 1428,
"pr_merged": null,
"pr_merged_at": null,
"ci_passed": null
},
"codebase_fingerprint": {
"repo": "coleam00/Archon",
"commit": "abc1234",
"loc": 78421,
"claude_md_hash": "..."
}
}
c) Daily reconciliation job. A scheduled workflow (similar to maintainer-standup in shape) sweeps metrics.json files older than 24h, queries GitHub for PR/issue final states using the .pr-number and .pr-url artifacts that already exist, and back-fills outcome_followup and any review comment counts. This closes the loop on lagging quality metrics.
d) Aggregation store. The per-run metrics.json files should land in a single append-only location for analysis. Two options:
• Lightweight: Append each run's record as one JSON line to .archon/metrics/runs.jsonl, one file per month. Trivial to query with jq, fits the "live in the repo, gitignored" pattern Archon already uses for .archon/maintainer-standup/state.json.
• Scaled: Ship to OpenTelemetry/OTLP-compatible store (Langfuse, VictoriaMetrics, Datadog). Reuses the same emit pipeline.
Start with the JSONL file. OpenTelemetry-based platforms can ingest the same signals later without re-instrumenting. Medium
e) Calibration with a holdout. Once you have ~50–100 completed runs of a given workflow, fit a simple model:
estimated_wall_clock = α + β₁·size_proxy + β₂·scope_dummy + β₃·area_dummy + ...
estimated_usd = α' + β'₁·size_proxy + ...
estimated_iterations = α" + β"₁·size_proxy + ...
Reserve 20% of runs as a holdout to compute MMRE (Mean Magnitude of Relative Error) — the standard validation metric in COCOMO-style work, since no cost model gives the exact estimate. Persist the fit so future runs can produce a prospective estimate at the classifier node ("this looks like 8 minutes of wall-clock and ~$0.40 with 60% confidence based on 73 similar past runs"). arxiv 5. Implementation phasing
A pragmatic order of operations:

1. Engine instrumentation (no workflow changes required). Make the engine emit node_started/node_completed/workflow_completed events with timing, token, and outcome data automatically. This alone gives you 80% of the value with zero per-workflow editing.
2. Per-run metrics.json writer. Engine writes the summary at workflow completion using the events it already emits. One implementation, every workflow benefits.
3. Outcome reconciliation workflow. A new archon-metrics-reconcile daily workflow that updates lagging fields. Mirrors maintainer-standup's shape — it's already a known pattern.
4. Classifier persistence. Where workflows already classify (issue type/scope/area/confidence), make sure those land in metrics.json. Most classifier nodes already produce structured output.
5. Estimation node. Once enough data exists, add an optional estimate node that workflows can opt into early in the DAG. Reads metrics.jsonl, fits/loads a model, posts an estimate as a comment or output.
6. OTEL export (later). When the JSONL approach starts straining, add an OTLP exporter so the same events flow to a real observability backend.
7. A few caveats worth flagging
   • Don't conflate cost with quality. A run that finishes quickly might have produced bad code that gets reverted. Always pair cost metrics with the follow-up outcome (merged/CI-passed/reverted), not just "the workflow exited zero."
   • Privacy/secrets in payloads. tokens_in is fine; raw prompts are not. The event payloads should carry counts and shapes, not bodies. Bodies can stay in artifacts under their existing access controls.
   • Watch for survivorship bias. Failed/aborted runs are where the most useful estimation signal lives ("this scope has a 30% timeout rate"). Make sure failures get a metrics.json written too, not just successes.
   • Scope drift inside a run. A workflow that started "small" and ended "large" because the agent discovered hidden complexity is a known cost driver. Capture both the initial classifier verdict and any revised verdicts emitted later.
   • Don't try to estimate the agent itself. The estimable thing is work-on-this-codebase: "how long will fixing a small bug in packages/server/src/routes take?" The agent is one cost driver, but the codebase, the issue text, and the human gates are bigger ones in most of these workflows.
   The shortest path to useful data: instrument the engine to emit standardized events, write one metrics.json per run, run a daily reconciliation job to attach final outcomes. Everything after that is an analytics question rather than an instrumentation one.
