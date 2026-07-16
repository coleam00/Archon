# Parameter Matrix (Quick Reference)

One-page lookup for Archon workflow parameters: which field works on which node type, how to pick the right parameter for a given intent, and the gotchas that don't fail loudly.

This is a **lookup reference**. For the full explanation of any field, follow the cross-references at the bottom to the detailed guides.

## Master Matrix: Parameters × Node Types

There are **eight** node types. Exactly one of `command`, `prompt`, `bash`, `script`, `loop`, `loop_group`, `approval`, or `cancel` must appear per node.

| Parameter                                    | command | prompt  | bash    | script  | loop                         | loop_group                   | approval       | cancel  |
| -------------------------------------------- | :-----: | :-----: | :-----: | :-----: | :--------------------------: | :--------------------------: | :------------: | :-----: |
| `id`                                         | yes     | yes     | yes     | yes     | yes                          | yes                          | yes            | yes     |
| `depends_on`                                 | yes     | yes     | yes     | yes     | yes                          | yes                          | yes            | yes     |
| `when`                                       | yes     | yes     | yes     | yes     | yes                          | yes                          | yes            | yes     |
| `trigger_rule`                               | yes     | yes     | yes     | yes     | yes                          | yes                          | yes            | yes     |
| `always_run` (re-run on resume)              | yes     | yes     | yes     | yes     | yes                          | yes                          | yes            | yes     |
| `output_type` (typed artifact sidecar)       | yes     | yes     | yes     | yes     | yes                          | yes                          | yes            | yes     |
| `idle_timeout`                               | yes     | yes     | ignored (use `timeout`) | ignored (use `timeout`) | yes (per-iter) | yes (per body AI node) | yes | yes |
| `timeout` (total, not idle)                  | —       | —       | yes     | yes     | —                            | — (on body bash/script nodes) | —             | —       |
| `model` / `provider`                         | yes     | yes     | ignored | ignored | **yes — forwarded to every iteration** | **yes — default for body AI nodes** | ignored | ignored |
| `context: fresh` \| `shared`                 | yes     | yes     | ignored | ignored | ignored (use `loop.fresh_context`) | ignored (use `fresh_context`) | ignored  | ignored |
| `output_format`                              | yes     | yes     | ignored | ignored | ignored                      | ignored (works on body nodes) | ignored       | ignored |
| `allowed_tools` / `denied_tools`             | yes     | yes     | ignored | ignored | ignored                      | ignored (works on body nodes) | ignored       | ignored |
| `hooks` / `mcp` / `skills` / `agents`        | yes     | yes     | ignored | ignored | ignored                      | ignored (work on body nodes) | ignored        | ignored |
| `retry`                                      | yes (default: 2× transient) | yes (default: 2× transient) | explicit block only (#2088)¹ | explicit block only (#2088)¹ | **hard error** | **hard error**  | ignored² | ignored |
| `persist_session`                            | yes     | yes     | ignored | ignored | ignored                      | ignored (and not on body nodes) | ignored     | ignored |
| `effort` / `thinking` / `fallbackModel` / `betas` / `sandbox` / `maxBudgetUsd` / `systemPrompt` | yes | yes | ignored | ignored | ignored | ignored (work on body nodes) | ignored | ignored |
| `bash` / `script` / `runtime` / `deps`       | —       | —       | `bash` required | `script` + `runtime` required | —            | — (on body nodes) | —          | —       |
| `loop` (nested config)                       | —       | —       | —       | —       | **required**                 | —                            | —              | —       |
| `loop_group` (nested config with `nodes:`)   | —       | —       | —       | —       | —                            | **required**                 | —              | —       |
| `approval` (nested config)                   | —       | —       | —       | —       | —                            | —                            | **required**   | —       |
| `cancel` (reason string)                     | —       | —       | —       | —       | —                            | —                            | —              | **required** |

¹ Bash/script nodes retry only with an explicit `retry:` block (no silent default retries for deterministic work). On builds before the #2088 fix, `retry:` on bash/script was accepted but never executed.
² `approval` has no retry — its rework mechanism is `on_reject: {prompt, max_attempts}`, a different thing.

**Reading the matrix:**
- **yes** — field works as expected on this node type.
- **ignored** — field is accepted by the parser but has no effect at runtime. Loader emits a warning (`<node-type>_node_ai_fields_ignored`).
- **hard error** — workflow fails to load. Only `retry` on a loop/loop_group node does this.

Most AI features work on `command` and `prompt` nodes. Loop and loop_group nodes are iteration controllers — but their `model`/`provider` ARE honored (forwarded to iterations / body defaults). A loop_group **body node** is a full node of its own type, so per-node AI fields work normally inside the body. `bash` and `script` nodes ignore AI fields with a warning. `approval` and `cancel` nodes don't invoke AI (except `approval.on_reject.prompt`).

## Parameter Selection by Intent

Organized by what you're trying to do, not by field name. Useful when you know the outcome you want but aren't sure which parameter gets you there.

| You want to...                                   | Use                                                          |
| ------------------------------------------------ | ------------------------------------------------------------ |
| Control cost per node                            | `model: haiku`, `maxBudgetUsd: 0.50`, `effort: low`          |
| Force pure reasoning (no tools)                  | `allowed_tools: []`                                          |
| Read-only analysis phase                         | `denied_tools: [Write, Edit, Bash]`                          |
| Route based on upstream output                   | Upstream `output_format: {...}` + downstream `when:`         |
| Join after mutually-exclusive routes             | `trigger_rule: none_failed_min_one_success` or `one_success` |
| Run two independent branches in parallel         | Two nodes with no shared `depends_on`                        |
| Iterate until tests pass                         | `loop: {until_bash: "bun run test", max_iterations: N}`      |
| Iterate a multi-node unit (implement → test → review per cycle) | `loop_group: {nodes: [...], until: ..., max_iterations: N}` |
| Read the previous iteration's per-node output    | `$LOOP_PREV.<nodeId>.output` (loop_group body) or `$LOOP_PREV_OUTPUT` (loop) |
| Iterate through a backlog without memory bleed   | `loop: {fresh_context: true}`, state written to `$ARTIFACTS_DIR` |
| Iterate with human feedback between iterations   | `loop: {interactive: true, gate_message: "..."}` + workflow `interactive: true` |
| Keep AI context across RUNS of the same workflow | `persist_session: true` (node) or `persist_sessions: true` (workflow); clear with `archon workflow reset-sessions` |
| Let later runs find a node's output by type      | `output_type: plan` → engine writes `$ARTIFACTS_DIR/nodes/<id>.md` + meta |
| Re-fetch fresh state on resume                   | `always_run: true` on the fetch node                         |
| Portable model choice (no hardcoded model ids)   | `model: small` \| `medium` \| `large` (tier keywords, resolved from config) |
| Run several read-only runs on one checkout       | Workflow-level `mutates_checkout: false`                     |
| Block users without GitHub connected (multi-user)| Workflow-level `requires: [github]`                          |
| Single human approval gate                       | `approval:` node with `on_reject: {prompt, max_attempts}`    |
| Fail fast if upstream output is wrong            | `cancel:` node with `when:`                                  |
| Enforce a rule on every file edit                | `hooks.PostToolUse` with `matcher: "Write\|Edit"`            |
| Deny dangerous commands                          | `hooks.PreToolUse` with `permissionDecision: deny`           |
| Give a node domain knowledge                     | `skills: [skill-name]`                                       |
| Give a node external tools                       | `mcp: .archon/mcp/server.json`                               |
| Retry flaky API calls                            | `retry: {max_attempts: 3, delay_ms: 2000}`                   |
| Run Python in a node                             | `script:` node with `runtime: uv`, `deps: [...]`             |
| Run TypeScript in a node                         | `script:` node with `runtime: bun`                           |
| Mix providers in one workflow                    | Workflow-level `provider: claude`, per-node `provider: codex` |
| Use a non-default model for one node             | Node-level `model:` override                                 |
| Run on a 1M context window                       | `model: opus[1m]` + `betas: ['context-1m-2025-08-07']`       |
| Increase per-iteration timeout on a long loop    | `idle_timeout: 600000` on the loop node                      |
| Pass large artifacts between nodes               | Write to `$ARTIFACTS_DIR/...`, read in downstream node       |
| Pass small structured data                       | `output_format` + `$nodeId.output.field` access              |
| Block workflow on an external condition          | `bash:` polling loop or `approval:` node                     |
| Spawn parallel sub-tasks inside one node         | Inline `agents:` map (see below)                             |
| Force isolation regardless of CLI flags          | Workflow-level `worktree: {enabled: true}`                   |
| Force live checkout for read-only workflows      | Workflow-level `worktree: {enabled: false}`                  |

## Silent Failures (what gets ignored without erroring)

Things that don't fail parsing but don't do what you'd expect:

1. **`hooks` / `mcp` / `skills` / `output_format` / `allowed_tools` / `denied_tools` on a loop, loop_group, bash, script, approval, or cancel node** → silently ignored. (NOT `model`/`provider` on loop/loop_group — those work: forwarded per iteration / as body defaults.)
2. **`context: fresh` on a loop / loop_group** → ignored. Use the loop config's `fresh_context: true` instead.
3. **`output_format` on a bash or script node** → schema is accepted but bash/script output is whatever stdout says; no JSON coercion.
4. **Unknown `$nodeId.output` (whole-text) reference at runtime** → resolves to empty string + warning. But `$nodeId.output.field` is STRICT — an unresolvable field (not in the producer's schema, non-JSON schemaless output, missing key, or producer skipped) **fails the consuming node loudly**, it does not resolve empty. And load-time validation rejects refs to node ids that don't exist at all.
5. **Invalid `when:` expression syntax** → node silently skipped (fail-closed). Distinct from the strict field-ref failure above.
6. **`$LOOP_PREV.*` in a body node's `when:`** → NOT substituted (prompt fields only); the condition sees the literal text and fails to parse → node skipped.
7. **`allowed_tools` / `denied_tools` on Codex nodes** → ignored. Use Codex CLI config (`~/.codex/config.toml`).
8. **`hooks` on Codex nodes** → ignored + warning logged.
9. **`mcp` or `skills` per-node on Codex** → ignored. Configure globally in `~/.codex/config.toml` or `~/.agents/skills/`.
10. **`trigger_rule: all_success` after `when:`-gated fan-out** → branches that didn't run count as "not succeeded"; the join node will never fire. Use `none_failed_min_one_success` or `one_success`.
11. **Node-level `interactive: true` on an approval node or loop, without workflow-level `interactive: true`** → on the Web UI, gate messages never reach the user. The workflow dispatches to a background worker that can't deliver chat messages.
12. **Missing env var in MCP config** → warning logged, node continues with empty string substitution.
13. **`retry` on a loop node** → this one is a **hard parse error** (not silent). Use the loop's own `max_iterations` and `until_bash` for finish-line detection.
14. **`String.raw\`$nodeId.output\`` in a `script:` body** → silently corrupts when the substituted value contains a backtick (e.g. markdown code spans in AI output or `output_format` payloads). The template literal terminates early, producing a cryptic `Expected ";"` parse error. Use direct assignment instead: `const data = $nodeId.output;` — JSON is valid JS expression syntax and needs no wrapper.

The pattern across these: if you set an AI feature on a non-AI node, it's silently ignored. Watch loader logs for `_ignored` warnings when debugging.

## Inline `agents:` (Task-tool sub-agents)

A node can define named sub-agents that Claude invokes via the `Task` tool. Useful for map-reduce patterns: one node spawns N parallel sub-tasks with a cheap model, then a reducer summarizes.

```yaml
- id: analysis
  prompt: |
    For each area of the codebase, delegate to the appropriate sub-agent
    via the Task tool. Summarize all findings into a single report.
  agents:
    security-scanner:                     # kebab-case id
      description: "Scan for common web vulnerabilities"
      prompt: "Run OWASP top-10 style checks on the given files"
      model: haiku
      tools: [Read, Grep, Glob]           # tool whitelist for this sub-agent
      disallowedTools: [Write, Edit, Bash]
      maxTurns: 5
    test-coverage-auditor:
      description: "Report untested or weakly-tested surfaces"
      prompt: "Identify code paths without corresponding tests"
      model: haiku
      tools: [Read, Grep, Glob]
      skills: [test-coverage-patterns]    # skill injection per sub-agent
      maxTurns: 5
```

**Fields per agent:**

| Field              | Required | Description                                               |
| ------------------ | :------: | --------------------------------------------------------- |
| `description`      | yes      | Shown when Claude decides which agent to delegate to      |
| `prompt`           | yes      | System prompt the sub-agent runs under                    |
| `model`            | no       | Per-agent model override                                  |
| `tools`            | no       | Tool whitelist for the sub-agent                          |
| `disallowedTools`  | no       | Tool blacklist                                            |
| `skills`           | no       | Skills to inject into the sub-agent                       |
| `maxTurns`         | no       | Max conversation turns for the sub-agent                  |

**Naming rule:** lowercase kebab-case. No leading or trailing hyphens, no double hyphens, no digits-only ids.

**When to use `agents:` vs fan-out at the workflow level:**
- Use `agents:` when the number of sub-tasks is dynamic or decided by the orchestrator node at runtime.
- Use workflow-level fan-out (parallel nodes with `depends_on: [setup]`) when the sub-tasks are known ahead of time and each needs its own artifact.

See [archon.diy/guides/authoring-workflows/#inline-sub-agents](https://archon.diy/guides/authoring-workflows/#inline-sub-agents) for a worked end-to-end example.

## Cross-References to Detailed Guides

Use this matrix to find the right parameter. Use these references for the full explanation of how it works.

| Topic                                            | Detailed reference                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| Workflow authoring overview, node base fields    | `workflow-dag.md`                                                       |
| Loop nodes in depth (completion, session patterns) | `workflow-dag.md` § Loop Nodes                                         |
| Approval / cancel nodes                          | `workflow-dag.md` § Approval Nodes, § Cancel Nodes                      |
| Hooks (events, matchers, response shapes)        | `dag-advanced.md` § Hooks                                               |
| MCP (transports, env expansion, wildcards)       | `dag-advanced.md` § MCP                                                 |
| Skills (injection, discovery, combining with MCP) | `dag-advanced.md` § Skills                                             |
| Retry classification (FATAL / TRANSIENT / UNKNOWN) | `dag-advanced.md` § Retry Configuration                               |
| Variable reference (`$ARGUMENTS`, `$ARTIFACTS_DIR`, etc) | `variables.md`                                                   |
| CLI flags and commands                           | `cli-commands.md`                                                       |
| Command file authoring                           | `authoring-commands.md`                                                 |
| Repo initialization, `.archon/config.yaml` schema | `repo-init.md`                                                         |
| Good practices and anti-patterns                 | `good-practices.md`                                                     |
| Interactive workflow relay protocol              | `interactive-workflows.md`                                              |
| Debugging and log locations                      | `troubleshooting.md`                                                    |
| Full schema reference                            | [archon.diy/reference/configuration/](https://archon.diy/reference/configuration/) |

## Providers at a Glance

| Feature                         | Claude        | Codex                                   | Pi (community)                       | OpenCode (community) | Copilot (community) |
| ------------------------------- | :-----------: | :-------------------------------------: | :----------------------------------: | :------------------: | :-----------------: |
| `command` / `prompt` / `loop` / `loop_group` | yes | yes                               | yes                                  | yes                  | yes                 |
| `bash` / `script`               | yes (no AI — provider-independent) | yes                | yes                                  | yes                  | yes                 |
| `output_format`                 | **enforced** (SDK grammar) | **enforced** (SDK grammar) | best-effort (prompt + parse/repair + up to 3 re-asks) | **enforced** | best-effort (same re-ask loop as Pi) |
| `allowed_tools` / `denied_tools` | yes          | ignored (use Codex CLI config)          | **yes**                              | **yes**              | **yes**             |
| `hooks`                         | yes           | **ignored + warn**                      | not available                        | **yes**              | not available       |
| `mcp` (per-node)                | yes           | **yes**                                 | not available                        | **yes**              | **yes**             |
| `skills` (per-node)             | yes           | informational (auto-discovers `.agents/skills/`) | yes                          | yes                  | yes                 |
| `agents`                        | yes           | no                                      | no                                   | **yes**              | **yes**             |
| `sandbox` / `maxBudgetUsd` / `fallbackModel` | yes | no                                | no                                   | no                   | no                  |
| Model naming                    | `haiku`, `sonnet`, `opus`, `opus[1m]`   | Codex model ID (e.g. `gpt-5.6-sol`)   | `<vendor>/<model>` (e.g. `anthropic/claude-opus-4-5`, `openrouter/qwen/qwen3-coder`) | OpenCode catalog ref | Copilot model id |
| `effort` / `thinking`           | yes           | use `modelReasoningEffort` for reasoning models | via `effort:` (maps to thinking level) | no (opencode.json agent config) | yes (maps like Pi) |
| Provider session resume (`persist_session`, `context: shared` threading) | yes | yes            | yes                                  | yes                  | yes                 |

Whatever the enforcement tier, a node with `output_format` either produces schema-valid output or **fails** — validation runs for every provider, and best-effort providers re-ask up to 3 times first. Prefer tier keywords (`model: small|medium|large`) over hardcoded model ids — they resolve per-install from config.

Note: workflow `--resume` (re-run skipping completed nodes) is engine-level and provider-independent — it never restores AI session context. Cross-RUN context restoration is exclusively `persist_session` (row above).

Mixing providers in one workflow: set workflow-level `provider: claude`, then override per-node with `provider: codex` or `provider: pi`. Cross-provider `$nodeId.output` substitution works as expected.

## Ten Principles for Safe Workflow Design

1. Always use `--branch <name>` (or `worktree: {enabled: true}`) for workflows that modify the codebase.
2. Validate before running: `archon validate workflows <name>`.
3. Tier your models — prefer tier keywords: `model: small` for routing and glue, `medium` for reasoning and review, `large` only where the context is deep. Tiers resolve from install config, so the workflow stays portable.
4. Use `output_format` for every node whose output downstream `when:` reads. Never pattern-match free-form AI text.
5. On Ralph-style loops, use `loop.fresh_context: true` and treat `$ARTIFACTS_DIR` as the source of truth. Command bodies should re-read state at the top of every iteration.
6. Use interactive loops for iterative refinement with the human. Use `approval:` nodes for single-point checkpoints.
7. Read-only analysis phases use `denied_tools: [Write, Edit, Bash]`. Separation of concerns.
8. Use `hooks.PostToolUse` to enforce post-change validation (type-check, lint). Tighter feedback loop than end-of-workflow review.
9. Large artifacts go through `$ARTIFACTS_DIR`. Small structured data goes through `$nodeId.output.field`.
10. AI can scaffold a workflow. Only a human can verify it. Read the YAML before running.
