# Workflow Good Practices and Anti-Patterns

Guidance for authoring workflows that survive first contact with a real codebase. Written for an agent or human writing their first non-trivial workflow.

## Good Practices

### 1. Use deterministic nodes for deterministic work

AI nodes are expensive, non-reproducible, and can hallucinate. Use `bash:` or `script:` for anything that has a right answer a computer can produce.

- **Run tests** with `bash: "bun run test"`, not `prompt: "run the tests and tell me if they passed"`.
- **Parse JSON** with `script:` (bun/uv), not a `prompt:` that re-derives structure from free text.
- **Read files with known paths** via `bash: "cat path/to/file"` or `Read` in an AI node where the agent actually needs to reason about the content.
- **Git state checks** (current branch, uncommitted changes, merge-base) → `bash:`.

### 2. Use `output_format` for every node whose output downstream `when:` reads

`when:` conditions do best-effort JSON parsing on `$nodeId.output` for `.field` access. If the upstream node doesn't enforce a shape, you're pattern-matching free-form AI text — fragile.

```yaml
# GOOD
- id: classify
  prompt: "Classify as BUG or FEATURE"
  output_format:                          # enforces the JSON shape
    type: object
    properties:
      type: { type: string, enum: [BUG, FEATURE] }
    required: [type]

- id: investigate
  command: investigate-bug
  depends_on: [classify]
  when: "$classify.output.type == 'BUG'"  # safe field access

# BAD
- id: classify
  prompt: "Is this a bug or a feature?"
  # no output_format; AI might reply "it looks like a bug", "BUG", or "This is a bug.\n\n..."

- id: investigate
  command: investigate-bug
  depends_on: [classify]
  when: "$classify.output == 'BUG'"       # fragile string match
```

### 3. `trigger_rule: none_failed_min_one_success` after conditional branches

After `when:`-gated branches, the downstream merge node will see one or more **skipped** dependencies. Skipped ≠ success. Default `all_success` fails.

```yaml
- id: investigate
  command: investigate-bug
  depends_on: [classify]
  when: "$classify.output.type == 'BUG'"

- id: plan
  command: plan-feature
  depends_on: [classify]
  when: "$classify.output.type == 'FEATURE'"

- id: implement
  command: implement
  depends_on: [investigate, plan]
  trigger_rule: none_failed_min_one_success   # CORRECT — exactly one ran
  # trigger_rule: all_success               ← would fail here (one dep skipped)
```

Use `one_success` when any dep succeeding is enough; `none_failed_min_one_success` when no dep should have failed AND at least one must have succeeded; `all_done` for "run cleanup regardless" patterns with `cancel:` or notification nodes.

### 4. `context: fresh` requires artifacts for state passing

A node with `context: fresh` starts with no memory of prior nodes in the same workflow. The only way state moves is via files. Default is `fresh` for parallel layers and `shared` for sequential — explicit `context: fresh` is common when you want cost isolation.

```yaml
- id: investigate
  command: investigate-bug
  # Investigator WRITES to $ARTIFACTS_DIR/investigation.md

- id: implement
  command: implement-fix
  depends_on: [investigate]
  context: fresh
  # Implementer MUST read $ARTIFACTS_DIR/investigation.md — it has no memory
  # of what the investigator found.
```

Command files should lead with "read artifacts from `$ARTIFACTS_DIR/...`" when they're downstream of a fresh node. This is the single biggest quality lever on multi-node workflows.

### 5. Cheap models for glue, strong models for substance

Classification, routing, formatting, and short summaries don't need Opus. Use `model: haiku` for these and reserve `sonnet`/`opus` for the nodes that actually produce code or long-form analysis. Combined with `allowed_tools: []` on pure-text nodes, this cuts cost dramatically.

```yaml
- id: classify
  prompt: "Classify this issue"
  model: haiku              # fast + cheap
  allowed_tools: []         # no tool overhead
  output_format: { ... }

- id: implement
  command: implement-fix
  model: sonnet             # where the thinking happens
```

### 6. Write the workflow description for routing

Archon's orchestrator routes user intent to workflows by description. Write descriptions that make routing obvious.

- Start with the imperative action: "Fix a GitHub issue end-to-end", "Generate a Remotion video composition".
- Mention triggers: "Use when the user asks to review a PR", "Use when there's a failing test run".
- Mention what it does NOT do: "Does not create a PR — use `archon-plan-to-pr` for that".

### 7. Validate before shipping

Never declare a workflow "done" without:

```bash
archon validate workflows <name>     # YAML + DAG structure + resource refs
```

This checks: YAML syntax, node ID uniqueness, no cycles, all `depends_on` exist, all `$nodeId.output` refs point to known nodes, all `command:` files exist, all `mcp:` configs parse, all `skills:` directories exist, provider/model compatibility, named script existence, runtime availability. Fix everything it reports before first run.

For brand-new workflows, also:
1. Run once against a trivial input (`archon workflow run my-workflow --branch test/sanity "hello"`)
2. Check the run log at `~/.archon/workspaces/<owner>/<repo>/logs/<run-id>.jsonl`
3. Check artifacts at `~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<run-id>/`

See `references/troubleshooting.md` for how to read those.

### 8. Design the artifact chain before writing command files

In a multi-node workflow, each node's artifact IS the specification for the next node. Before writing any command body, map out:

| Node | Reads | Writes |
|------|-------|--------|
| `investigate-issue` | GitHub issue via `gh` | `$ARTIFACTS_DIR/issues/issue-{n}.md` |
| `implement-issue` | Artifact from `investigate-issue` | Code files, tests |
| `create-pr` | Git diff | GitHub PR, `$ARTIFACTS_DIR/pr-body.md` |

If a downstream agent can't execute from just its artifact, the artifact is incomplete. This is the single most common failure mode in multi-node workflows.

### 9. Keep workflows reversible

Use `worktree.enabled: true` at the workflow level for anything that modifies the codebase. The CLI `--no-worktree` flag will hard-error, forcing users into isolation. The cost is a one-time cp of the worktree; the benefit is never having a failed workflow corrupt a live checkout.

For read-only workflows (triage, reporting, code analysis), pin `worktree.enabled: false` instead — saves the worktree setup cost.

---

## Anti-Patterns

### ❌ Asking AI to run deterministic checks

```yaml
# BAD
- id: test
  prompt: "Run bun run test and tell me if it passed"

# GOOD
- id: test
  bash: "bun run test 2>&1"

- id: react-to-tests
  prompt: "Fix any failures: $test.output"
  depends_on: [test]
  trigger_rule: all_done            # run even if tests failed
```

### ❌ Pattern-matching free-form AI output in `when:`

```yaml
# BAD — brittle
- id: decide
  prompt: "Should we proceed? Answer yes or no."
- id: do-thing
  depends_on: [decide]
  when: "$decide.output == 'yes'"    # AI says "Yes!" or "Yes, because..." — no match

# GOOD
- id: decide
  prompt: "Should we proceed?"
  output_format:
    type: object
    properties: { proceed: { type: boolean } }
    required: [proceed]
- id: do-thing
  depends_on: [decide]
  when: "$decide.output.proceed == 'true'"
```

### ❌ Commands that assume prior-node memory in a `context: fresh` chain

```markdown
<!-- BAD — implement.md -->
Fix the bug we discussed in the investigation phase.

<!-- GOOD — implement.md -->
Read the investigation at `$ARTIFACTS_DIR/issues/issue-{n}.md`.
Extract the root cause, affected files, and implementation plan.
Implement the changes exactly as specified in the plan.
```

### ❌ Long flat layers of AI nodes

Ten sibling `prompt:` nodes in one layer all depending on one upstream is a $N/run cost bomb and a latency trap. If the work is parallel and similar, use the `agents:` inline sub-agent map-reduce pattern with a cheap model per item and a single stronger reducer. See `references/dag-advanced.md` and the docs site's Inline sub-agents section.

### ❌ Hardcoding secrets in YAML or MCP configs

Use `$ENV_VAR` expansion in MCP configs and the `env:` block in `.archon/config.yaml` (or Web UI Settings → Projects → Env Vars). See `references/repo-init.md` §Per-Project Env Injection.

### ❌ `retry` on a loop node

Loop nodes manage their own iteration via `max_iterations`. Setting `retry:` on a loop is a **hard parse error** — the workflow fails to load. If a loop iteration is flaky, handle it inside the loop prompt (the AI can retry tool calls) or use `until_bash` to gate completion on a deterministic check.

### ❌ Tiny `max_iterations` on open-ended loops

A loop with `max_iterations: 3` that's supposed to implement N stories from a PRD will silently stop after 3 iterations and leave the work half-done. Think about the worst case — multi-story PRDs need 10–20, fix-iterate cycles need 5–8, refinement loops need 3–5.

### ❌ Missing `interactive: true` at workflow level for approval/loop gates on web

Web UI dispatches non-interactive workflows to a background worker that cannot deliver chat messages. Approval-gate messages and loop `gate_message` prompts will never reach the user. If the workflow has `approval:` nodes OR `loop.interactive: true`, set workflow-level `interactive: true`.

### ❌ Tool-restricted nodes without the MCP wildcard

```yaml
# BAD — no tools available, including MCP
- id: analyze
  prompt: "Use the Postgres MCP to query users"
  mcp: .archon/mcp/postgres.json
  allowed_tools: []          # OOPS — disables EVERYTHING, including MCP tools

# FIXED — Archon auto-adds mcp__<server>__* wildcards when mcp: is set,
# so this actually works out of the box. The anti-pattern is forgetting
# and manually adding Read/Write/Bash/etc. when you only want MCP.
- id: analyze
  prompt: "Use Postgres MCP to query users"
  mcp: .archon/mcp/postgres.json
  allowed_tools: []          # correct — MCP tools auto-attached
```

Caveat: this only helps Claude. Codex gets MCP config from `~/.codex/config.toml` globally, not per-node.
