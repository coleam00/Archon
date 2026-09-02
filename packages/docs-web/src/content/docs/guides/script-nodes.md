---
title: Script Nodes
description: Run TypeScript, JavaScript, or Python code as a DAG node without invoking an AI agent.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 5
---

DAG workflow nodes support a `script` field that runs a TypeScript, JavaScript,
or Python snippet as part of the workflow. No AI agent is invoked — the script
runs via the `bun` or `uv` runtime, `stdout` is captured as the node's output,
and the result is available downstream as `$nodeId.output`.

Use script nodes for deterministic work that needs a real programming language:
parsing JSON, transforming data between upstream AI nodes, calling HTTP APIs
with typed clients, or computing values that a shell one-liner would mangle.
If a plain shell command is enough, use a [`bash:` node](/guides/authoring-workflows/#node-fields)
instead.

## Quick Start

### Inline TypeScript (bun)

```yaml
nodes:
  - id: parse
    script: |
      const data = { count: 42, label: "ok" };
      console.log(JSON.stringify(data));
    runtime: bun
```

### Inline Python (uv)

```yaml
nodes:
  - id: compute
    script: |
      import json, statistics
      values = [1, 2, 3, 4, 5]
      print(json.dumps({ "mean": statistics.mean(values) }))
    runtime: uv
```

### Named script from `.archon/scripts/`

```yaml
nodes:
  - id: fetch-pages
    script: fetch-github-pages   # resolves .archon/scripts/fetch-github-pages.ts
    runtime: bun
    timeout: 60000
```

The file `.archon/scripts/fetch-github-pages.ts` is loaded and executed with
`bun --no-env-file run <path>`.

## How It Works

1. **Substitute variables.** `$ARGUMENTS`, `$WORKFLOW_ID`, `$ARTIFACTS_DIR`,
   `$BASE_BRANCH`, `$DOCS_DIR`, and upstream `$nodeId.output` references are
   substituted into the `script` text before execution.
2. **Detect inline vs named.** If the `script` value contains a newline or any
   shell metacharacter (see [Inline vs Named Scripts](#inline-vs-named-scripts)
   below), it's treated as inline code. Otherwise it's treated as a named-script
   reference.
3. **Dispatch.**
   - `runtime: bun` + inline → `bun --no-env-file -e '<code>'`
   - `runtime: bun` + named  → `bun --no-env-file run <path>`
   - `runtime: uv` + inline  → `uv run [--with dep ...] python -c '<code>'`
   - `runtime: uv` + named   → `uv run [--with dep ...] <path>`
4. **Capture.** `stdout` (with the trailing newline stripped) becomes
   `$nodeId.output`. On a successful run, `stderr` is logged as a warning and
   posted to the conversation but does **not** fail the node. A non-zero exit
   code fails the node; on failure, tails of both streams are surfaced in the
   error message (`Script node 'X' failed [exit N]: [stderr] ... [stdout] ...`),
   sharing a ~2 KB diagnostic budget — stderr keeps priority, stdout gets the
   remainder, and a label prefixes each stream only when both are populated.
   With stderr empty, the stdout tail becomes the diagnostic. The script body
   is never echoed back to users. A timeout also fails by default. Set
   `on_timeout: skip` when the result is optional and downstream nodes handle
   its absence with an `if_skipped` binding.
5. **Retain.** Regardless of outcome, capped and credential-redacted tails of
   both streams are written to the run transcript as an `exec_output` row — see
   [Retained subprocess evidence](/guides/authoring-workflows#retained-subprocess-evidence).
   That retention is evidence only; it never caps `$nodeId.output`.

## YAML Schema

```yaml
- id: node-name
  script: <inline code OR named identifier>   # required, non-empty
  runtime: bun | uv                            # required
  deps: ["httpx", "pydantic>=2"]               # optional, uv-only (see below)
  timeout: 60000                               # optional ms, default 120000
  on_timeout: skip                             # optional; default is to fail
  depends_on: [upstream]                       # optional
  when: "$upstream.output != '[]'"             # optional (upstream is a bash/script node;
                                               #  an AI producer needs output_format + a field)
  output_format:                               # optional JSON Schema; makes stdout a contract
    type: object
    properties:
      severity: { type: string }
    required: [severity]
  trigger_rule: all_success                    # optional (default)
  retry:                                       # optional; same shape as bash/AI nodes
    max_attempts: 3
    on_error: transient
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `script` | string | Yes | Inline code, or a named script in the owning workflow's `scripts/` directory (packaged workflows) or shared script directories (legacy workflows) |
| `runtime` | `'bun'` \| `'uv'` | Yes | Which runtime executes the script. Must match the file extension for named scripts |
| `deps` | string[] | No | Python dependencies to install for this run. **uv only** — ignored with a warning for `bun` |
| `timeout` | number (ms) | No | Hard kill after this many milliseconds. Default: `120000` (2 min) |
| `on_timeout` | `'skip'` | No | Complete the node as skipped after a timeout. The default is failed. The persisted skip cause is `timeout` |
| `output_format` | object | No | JSON Schema the node's stdout must satisfy. See [Declaring a result contract](#declaring-a-result-contract) |

Standard DAG fields (`id`, `depends_on`, `when`, `trigger_rule`, `retry`) all
work, and so does `output_format` — see
[Declaring a result contract](#declaring-a-result-contract). AI-specific fields
(`model`, `provider`, `context`, `allowed_tools`, `denied_tools`, `hooks`,
`mcp`, `skills`, `agents`, `effort`, `maxBudgetUsd`, `systemPrompt`,
`fallbackModel`, `betas`, `sandbox`) are accepted by the parser but emit a
loader warning and are ignored at runtime — no AI is invoked. `idle_timeout` is also accepted but ignored: script nodes
run as one-shot subprocesses, so use `timeout` (hard kill after N ms) instead.

## Inline vs Named Scripts

The executor decides mode from the `script` string itself. A value is treated
as **inline code** if it contains a newline or any shell metacharacter; otherwise
it's a **named script** lookup.

- **Metacharacters that trigger inline mode:** space, `;` `(` `)` `{` `}` `&`
  `|` `<` `>` `$` `` ` `` `"` `'`
- **Inline examples:** `"const x = 1; console.log(x)"`, multi-line blocks, any
  snippet with a space
- **Named examples:** `fetch-pages`, `analyze_metrics`, `triage-fmt` — bare
  identifiers with no whitespace or shell syntax

If you want an inline snippet that happens to be syntactically a single
identifier, add a trailing comment or newline to force inline mode.

### Named Script Resolution

Named scripts use one of two resolution modes:

- **Packaged workflow:** resolve only from the owning workflow's `scripts/` directory. Bundled package scripts use the same ownership rule and are embedded for binary distribution.
- **Legacy workflow:** resolve shared scripts from `<repoRoot>/.archon/scripts/`, then `~/.archon/scripts/`.

Workflow-local lookup is scoped to the workflow that declared the node, including through `include:` expansion. Authors still write only the bare name (`script: publish`); the ownership key is internal.

A named script is one self-contained file. Declare its dependencies inline (`deps:` for `uv`; Bun resolves imports from its own cache) rather than beside it: no imports of sibling scripts, and no `node_modules` or virtual environment next to the file. Python bytecode caching is disabled for named scripts, so a script cannot write into the capture it runs from.

When a run uses captured source, Archon rechecks the full capture against the run's pinned digest and source-resolution settings before each named-script attempt, including retries, and before lookup or subprocess dispatch. Any change to the capture refuses the node before it starts. Inline scripts are already held in the workflow definition and do not read the capture at execution time.

This is checkpoint detection, not sealing or sandboxing. A process running as the Archon user can change source after the check, and a parallel node that already started is not cancelled.

Each shared scripts directory is walked one subfolder deep (e.g. `.archon/scripts/triage/foo.ts`
resolves as `foo`). Deeper nesting is ignored. On a same-name collision the
repo-local entry wins silently — see [Global Workflows](/guides/global-workflows/)
for the shared precedence rules.

### Extension ↔ Runtime Mapping

Named scripts derive their runtime from the file extension:

| Extension | Runtime |
|-----------|---------|
| `.ts`, `.js` | `bun` |
| `.py` | `uv` |

The `runtime:` declared on the node **must match the file's extension** — the
validator rejects `runtime: uv` pointing at a `.ts` file, and vice versa. For
inline scripts, you can use any language that the chosen runtime supports.

## Dependencies (uv only)

`deps` is a pass-through to `uv run --with <dep>`, which installs packages into
a per-run ephemeral environment:

```yaml
- id: scrape
  script: |
    import httpx
    r = httpx.get("https://api.github.com/repos/anthropics/anthropic-cookbook")
    print(r.text)
  runtime: uv
  deps: ["httpx>=0.27"]
```

- **Version pinning** — any PEP 508 specifier works (`pkg==1.2.3`, `pkg>=2,<3`).
- **Bun ignores `deps`** — Bun auto-installs imported packages on first run, so
  the validator emits a warning if you set `deps` with `runtime: bun`. Remove
  the field, or switch to `uv` if you need explicit dependency management.
- **No persistent environment** — each run is isolated; there is no `requirements.txt`
  or lockfile to maintain.

## Output and Data Flow

`stdout` (trimmed of its trailing newline) becomes `$nodeId.output`. Print JSON
if you want downstream nodes to access structured fields with
`$nodeId.output.field` — the workflow engine tries to parse the output as JSON
for field access in `when:` conditions and prompt substitution.

Declare `output_format` when you want that JSON to be a contract rather than a
convention — see [Declaring a result contract](#declaring-a-result-contract).

```yaml
- id: classify
  script: |
    const input = process.argv.slice(2).join(' ');
    const severity = input.includes('crash') ? 'high' : 'low';
    console.log(JSON.stringify({ severity, length: input.length }));
  runtime: bun

- id: investigate
  command: investigate-bug
  depends_on: [classify]
  when: "$classify.output.severity == 'high'"
```

### Declaring a result contract

Without `output_format`, `$classify.output.severity` above works by convention:
the engine parses the text and hopes the key is there. Declare `output_format`
and the same result becomes a contract the node owns.

```yaml
- id: classify
  script: |
    const input = process.env.ARGUMENTS ?? '';
    console.log(JSON.stringify({
      severity: input.includes('crash') ? 'high' : 'low',
      units: [],
    }));
  runtime: bun
  output_format:
    type: object
    properties:
      severity: { type: string, enum: [low, high] }
      units: { type: array, items: { type: object } }
    required: [severity, units]
```

With a schema declared, the node:

- parses stdout as **one strict JSON document** — no code fences, no prose
  preamble, no repair pass, and no second attempt;
- validates it against the schema, and **fails the node** when it does not
  match, naming the offending JSON path and quoting the start of stdout;
- publishes the canonical JSON document as `$classify.output`, the logical
  value to downstream bindings and `fan_out.items`, and the declared property
  names to `$classify.output.<field>`;
- makes a reference to an **undeclared** field fail the consuming node instead
  of silently resolving to `''`.

That is the same contract an AI node's `output_format` carries, so a script and
an agent are interchangeable as the producer behind a `returns:` node. What that
buys a caller — through an `include:` alias, a `workflow:` sub-run, a fan-out, or
an artifact pointer — is described once in
[Authoring workflows → Result contracts](/guides/authoring-workflows/#result-contracts).

A schemaless script is unchanged: stdout stays raw text, trimmed only of its trailing
newline as before.

### Variable Substitution in Scripts

Variables are substituted into the `script` text **as raw strings, without
shell quoting** — unlike `bash:` nodes, where `$nodeId.output` values are
auto-quoted. Treat substituted values as untrusted input and parse them with
language features, not by interpolating into shell syntax.

:::caution[Avoid String.raw with `$nodeId.output`]
The pattern `` String.raw`$nodeId.output` `` looks safe but fails silently when
the substituted value contains a backtick — common in AI-generated markdown,
`output_format` payloads, or any output with inline code spans. The backtick
terminates the template literal early, producing a cryptic `Expected ";"` parse
error at runtime.

**Use direct assignment instead.** JSON is a strict subset of JavaScript
expression syntax, so the substituted value is always a valid JS literal:

```typescript
// Safe — works for any valid JSON, including content with backticks
const data = $fetch-issue.output;

// Fragile — breaks if output contains a backtick
const data = JSON.parse(String.raw`$fetch-issue.output`);  // DON'T
```
:::

For **named scripts**, variables are not passed automatically. Read them from
the environment (`process.env.USER_MESSAGE`, `os.environ['USER_MESSAGE']`)
or accept them via stdin. For **inline scripts**, substituted variables are
literally embedded into the code string at execution time.

## Environment and Isolation

:::note[Shell injection prevention]
User-controlled workflow variables like `$USER_MESSAGE` and `$ARGUMENTS` are passed to `bash:` nodes as environment variables (not inline-substituted into the shell command) to prevent shell injection. Script nodes receive these values the same way via `process.env`.
:::

Script subprocesses receive `process.env` merged with any codebase-scoped env
vars you've configured via the Web UI (Settings → Projects → Env Vars) or the
`env:` block in `.archon/config.yaml`. This is the same injection surface used
by Claude, Codex, and bash nodes.

**Target repo `.env` isolation:** the Bun subprocess is invoked with
`--no-env-file`, so variables in the target repo's `.env` do **not** leak into
the script. Archon-managed env (from `~/.archon/.env` and `<repo>/.archon/.env`)
passes through normally. `uv`-launched Python subprocesses do not auto-load
`.env` at all. See [Security Model](/reference/security/#target-repo-env-isolation)
for the full story.

## Validation

`archon validate workflows <name>` checks script nodes for:

- **Script file exists** — for named scripts, the basename must exist in the
  owning workflow's `scripts/` directory or the legacy shared search path, with
  a matching extension for the declared runtime. Missing files fail validation
  with a hint showing the expected path.
- **Runtime available on PATH** — `bun` or `uv` must be installed. Missing
  runtimes emit a warning with the official install command:
  - `curl -fsSL https://bun.sh/install | bash`
  - `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **`deps` with `runtime: bun`** — warns that `deps` is a no-op under Bun.

Runtime availability is cached per-process — the check spawns `which bun` /
`which uv` once and memoizes the result.

## Patterns

### Transform AI output before the next node

Use a script node as a deterministic adapter between two AI nodes. The script
parses the upstream classifier's JSON, filters, and forwards a clean payload:

```yaml
- id: classify
  prompt: "Classify: $ARGUMENTS"
  allowed_tools: []
  output_format:
    type: object
    properties:
      items:
        type: array
        items: { type: object }

- id: filter
  script: |
    const upstream = JSON.parse(process.env.UPSTREAM ?? '{}');
    const high = (upstream.items ?? []).filter(i => i.severity === 'high');
    console.log(JSON.stringify(high));
  runtime: bun
  depends_on: [classify]

- id: triage
  command: triage-high-severity
  depends_on: [filter]
  when: "$filter.output != '[]'"
```

*(Note: to actually populate `UPSTREAM` you'd inline-substitute
`$classify.output` into the script body. The example above illustrates the
shape.)*

### Reusable helper in `~/.archon/scripts/`

A helper you want available in every repo — say, a triage summary formatter —
lives at `~/.archon/scripts/triage-fmt.ts`:

```typescript
// ~/.archon/scripts/triage-fmt.ts
const raw = process.argv.slice(2).join(' ') || '{}';
const data = JSON.parse(raw);
const lines = data.issues?.map((i: { id: string; title: string }) =>
  `- [${i.id}] ${i.title}`
).join('\n') ?? '';
console.log(lines || 'no issues');
```

Then reference it by name from any repo's workflow:

```yaml
- id: format
  script: triage-fmt
  runtime: bun
  depends_on: [gather]
```

### Python with scientific dependencies

```yaml
- id: analyze
  script: |
    import json, sys
    import pandas as pd
    data = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
    df = pd.DataFrame(data)
    print(df.describe().to_json())
  runtime: uv
  deps: ["pandas>=2.0"]
  depends_on: [collect]
```

## What Does NOT Work

- **AI-only features** — `hooks`, `mcp`, `skills`, `allowed_tools`,
  `denied_tools`, `agents`, `model`, `provider`, `effort`,
  `maxBudgetUsd`, `systemPrompt`, `fallbackModel`, `betas`, and `sandbox` are
  all ignored at runtime. The loader emits a warning listing the ignored fields.
  (`output_format` is **not** in that set — a script owns it, see
  [Declaring a result contract](#declaring-a-result-contract).)
- **JSON repair and reasks** — a certified script's stdout must be exactly right
  the first time. There is no fence stripping and no second attempt: stdout that
  does not match the declared schema is a bug in the script.
- **Interactive prompts** — the script runs headlessly; any `stdin` read will
  see EOF immediately.
- **Runtimes other than `bun` and `uv`** — rejected at parse time.
- **Cancelling mid-execution** — script subprocesses are killed on workflow
  cancel, but there's no cooperative cancellation signal. Design scripts to
  complete quickly or fail fast.

## See Also

- [Authoring Workflows](/guides/authoring-workflows/) — full workflow reference
- [Global Workflows, Commands, and Scripts](/guides/global-workflows/) — home-scoped `~/.archon/scripts/`
- [Security Model](/reference/security/#target-repo-env-isolation) — env isolation details
- [Variables Reference](/reference/variables/) — substitution rules
