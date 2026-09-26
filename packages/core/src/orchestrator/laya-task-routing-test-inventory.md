# Laya Direct-Chat Routing Test Inventory

This inventory maps the opt-in, local Laya direct-chat routing contracts to
their current deterministic evidence. Passing unit tests do not prove model
quality, production provider quota accuracy, or readiness for active rollout.

| Contract                                                                                                                                                                                                | Evidence                                                                                                                                              | Status / remaining release evidence                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local-only classifier loads only a pinned bundle with a matching manifest digest; copied snapshot is verified before inference                                                                          | `laya-task-type-hint.test.ts`                                                                                                                         | Deterministic fixture coverage; real approved bundle and manifest still require operator review                                                        |
| CPU inference path and bounded thread count                                                                                                                                                             | `laya-task-type-hint.test.ts`; `vendor/laya-ts/providers.ts`                                                                                          | Test checks loader thread bound; static source review must confirm CPU execution provider remains explicit and no runtime model download is introduced |
| Label allowlist, probability abstention, bounded message/history, one in-flight inference, timeout, and broken-model fail-closed behavior                                                               | `laya-task-type-hint.test.ts`                                                                                                                         | Deterministic unit coverage; held-out quality/calibration remains open                                                                                 |
| Typed task labels select only configured direct-chat routes; user provider/model pins and slash commands retain precedence; route labels cannot dispatch workflows or enter the workflow-capable prompt | `orchestrator-agent.test.ts`, `prompt-builder.test.ts`, `chat-task-routing.test.ts`                                                                   | Deterministic route coverage; add/retain cases whenever route controls or dispatch entry points change                                                 |
| Direct-chat credential eligibility, primary selection, explicit cooldown/warning fallback, and unknown usage behavior                                                                                   | `chat-task-routing.test.ts`, `orchestrator-agent.test.ts`, `provider-rate-limit-state.test.ts`                                                        | Deterministic policy coverage; do not infer subscription state from spend, token counts, plan names, or OAuth identity                                 |
| Provider-admission wrapper preserves native quota readers without turning a read into a message-send slot                                                                                               | `packages/core/src/services/provider-admission.integration.test.ts`                                                                                   | Deterministic delegation and no-slot coverage for the Codex reader                                                                                     |
| Copilot account quota meter parsing, explicit credential handoff, cache scope, unknown/unlimited/exhausted interpretation                                                                               | `packages/providers/src/community/copilot/provider.test.ts`                                                                                           | Adapter contract coverage; SDK contract changes require fixture/source review and fresh provider integration evidence                                  |
| Codex rate-limit reader uses the exact OAuth profile/account/bucket and rejects mismatches or unknown native usage                                                                                      | `packages/providers/src/codex/rate-limits.test.ts`, `orchestrator-agent.test.ts`, `packages/core/src/services/provider-admission.integration.test.ts` | Local fake App Server and routing-wrapper contracts; a real provider smoke is a separate gated check                                                   |
| Package test discovery includes all new test files                                                                                                                                                      | `packages/core/package.json`, `packages/providers/package.json`, `scripts/test-inventory.test.ts`                                                     | Package `testGroups` is the executable inventory; keep it current with each added test                                                                 |

## Release Gates Beyond Deterministic Tests

1. **Static/build:** type-check core and providers; inspect the production loader,
   bundle staging scripts, and dependency tree for CPU-only ONNX execution and
   absence of hosted Hugging Face/runtime download paths. The offline exporter
   may use Transformers only in its isolated build environment.
2. **Focused tests:** run the changed core/provider test files through the
   package test runner, which isolates Bun module mocks; then run the repository
   test-inventory guard and the normal validation workflow before merge.
3. **Provider integration:** against controlled Copilot and Codex test accounts,
   confirm the configured meter/bucket semantics and that stale, malformed,
   unsupported, or account-mismatched snapshots remain unknown. Do not use a
   real account for deterministic unit fixtures.
4. **Model evaluation:** after an approved ModelScope artifact is available, run
   a separately held-out and reviewed task-intent set, with at least 100
   examples per task class and no conversation/template leakage from prompt
   development. At the configured threshold, require at least 95% precision
   among routed examples and at least 50% coverage per configured route class;
   omit routes for classes that miss either gate. Report per-class confusion,
   abstention, calibration, and suitability of the configured provider/model
   route. Include adversarial/ambiguous requests and follow-up messages. An
   accuracy score alone cannot establish safe routing.
5. **Resource and end-to-end:** measure CPU startup, per-message latency,
   throughput, and peak RSS under representative concurrency; verify provider
   session transitions, no mid-turn replay, no quota fallback on unknown usage,
   and no workflow/authorization behavior changes through a staging E2E pass.
6. **Rollout:** keep flags off by default and through offline evaluation. This
   implementation has no shadow-only mode. After each install's held-out
   evaluation and provider/resource gates pass, the first live use must be an
   explicit, narrowly scoped opt-in with configured routes and a fast disable
   path. Active fallback requires explicit operator route policy and
   provider-native exhaustion/warning evidence. Expand only after observed
   fallback correctness, error rate, latency, and quota outcomes meet agreed
   thresholds. Add shadow-only telemetry before using a shadow cohort.
