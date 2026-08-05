---
title: Workflow Language Constitution
description: The design rules that keep Archon's workflow YAML a coordination language — the admissibility test for new YAML features, the failure smells, and how each is managed.
category: reference
audience: [developer]
status: current
sidebar:
  order: 9
---

Every workflow engine's configuration format faces the same gravitational pull: it grows until it becomes a bad programming language. Jenkins pipelines grew Groovy. GitHub Actions grew an expression language. Helm grew Turing-complete templating. Airflow grew so much Python-in-config that it eventually surrendered and became workflows-as-code. The pattern is always the same — individually reasonable feature grants, compounding into an informally-specified, untestable, half-language that is worse than code at computing and worse than configuration at declaring.

Archon's workflow YAML is deliberately held on the right side of that line. This page is the constitution that keeps it there: the rule, the admissibility test applied to every proposed YAML feature, the known failure smells, and the management lever for each.

## The rule

> **YAML coordinates. Code computes. Agents judge.**

The workflow YAML exists to express what the **engine** must see in order to govern a run: ordering, gating, retrying, joining, pausing for humans, session identity, artifact identity, and reusable structure. Everything that *computes a value or transforms data* stays out of the YAML and lives inside a node's **body** — the `bash:`/`script:` source or the `prompt:` text. The surrounding node fields (`when:`, `retry:`, `output_format:`, …) are YAML surface and stay declarative. The YAML is the wiring between nodes — nothing more.

**What this rule is about, and what it is not.** The partition governs **what may enter the YAML surface**, not what an agent may do inside a node. "Code computes, agents judge" is shorthand for *the language does not compute* — it is not a prohibition on a prompt performing computation.

A prompt that computes is a **legitimate authoring choice**, and frequently the right one. `bash:`/`script:` nodes and `prompt:` nodes are both escape hatches from the language; choosing between them is an ordinary engineering decision the workflow author owns, not a constitutional question:

- Reach for a **script node** when the rule is known, fixed, and cheap to state — parsing JSON, arithmetic, comparing versions, reshaping a list.
- Reach for a **prompt** when the author does not know the rule, or knows it will not survive contact with real inputs, and wants the model to decide. Models are capable; forcing an uncertain rule into a script only freezes a guess into code.

Neither choice touches the language, so neither is the constitution's business.

**The one narrow case that argues for determinism** — and it is a reliability argument, not a constitutional one: a check with **no judgment content** (a boolean with exactly one correct answer, like "does this file exist") whose failure has **irreversible external consequences** is better expressed as a node that cannot decline to fire. Not because a prompt cannot evaluate it, but because the cost of it not firing is unrecoverable. Cite reliability when you make that argument; do not cite this page.

This is not an aesthetic preference. The declarative surface is what makes Archon's core promises possible: load-time validation, the visual builder, resumability, audit trails, and approval gates all depend on the engine being able to *statically see* the workflow's structure. Every unit of computation that leaks into the YAML is a unit the engine can no longer validate, render, resume, or audit — and a unit that a script node would have handled better.

## The admissibility test

A proposed workflow-YAML feature (new field, new node type, new expression capability) must pass all three questions:

1. **Does the engine need to see it to govern the run?** Gates, joins, retries, sessions, artifacts, sub-structure — yes. A string transformation, a computed value, an arithmetic condition — no.
2. **Is it declarative data, or is it evaluation?** Data that the engine interprets with fixed semantics is fine. Anything that introduces *evaluation order, operator precedence, or user-defined abstraction* is language-building.
3. **Could a script node + existing wiring express it today?** If yes, the burden of proof is on the feature: it must earn its place by governance value (visibility, resumability, auditability), not by convenience.

If a feature computes rather than coordinates, it is rejected — with the pointer to the escape hatch that already covers it.

## The independence rule

A second rule, narrower than the first and about a different axis. Where "YAML coordinates, code computes" governs *what may enter the surface*, this one governs *what the engine may do to work already running*:

> **Parallel children are independent by default. Anything that couples their fates is opt-in, and must come from the author's declaration rather than be inferred.**

This is the same instinct as the isolation rule — the engine never guesses what the author must have meant — applied to lifecycle instead of storage.

It exists because a single wrong assumption can generate a whole family of wrong features. Treating a fan-out as *one job split N ways that jointly succeeds or fails* makes four decisions look obviously correct: default the join to all-or-nothing; cancel the siblings once the outcome is sealed, to stop burning tokens on a doomed join; let a winner abort the losers; infer isolation because N concurrent children must surely collide.

Under the real model — **N independent workers with different scopes, producing different outputs that aggregate** — all four are wrong, and not subtly. They destroy the thing the feature exists for. Two planners with different scopes, or ten issue-triage children over ten issues, do not depend on each other. One failing is ordinary, and its siblings' output is still the point.

Applying the rule to a proposed behaviour:

- Does it end, abort, or discard work a **sibling** produced? Then it couples them, and it needs the author to have asked for it.
- Does it configure children without linking their fates — a model, a concurrency bound, a per-item input? Then it is fine.
- Is it inferred from an unrelated property — how many children there are, what join was chosen? Then it is inference, and the answer is no.

The corollary for joins: the engine's job is to report *all terminal outcomes*, with failures represented as data. Deciding **how many successes are enough** is judgement, and belongs in a downstream script or prompt node reading the aggregate — not in a YAML enum. That is what stops a join rule growing into a policy language.

#### The one exception, and why it is not a loophole

A fan-out child that **pauses at an approval gate** is cancelled by the engine, and the node fails — regardless of `join`. That is the single place a fan-out ends a run it was not asked to end, so it has to be named here rather than left to the authoring guide.

It is not a coupling, because nothing about a *sibling* decides it. A pause is not a terminal state, and a parent run has exactly one approval slot, so a fanned-out child that pauses is waiting for something it can never be given — the cancel is what makes its own state terminal, decided entirely by that child. Its siblings run to their own terminal states either way.

The test the rule actually applies is *"does one child's outcome end another's?"*, and the answer here is no. What ends the child is the impossibility of its own situation. The distinction matters: an exception that could not be stated this precisely would be a loophole, and the reason a fan-out is autonomous is documented as the intended shape — gates belong before or after the fan-out node, not inside a child of it ([#2438](https://github.com/coleam00/Archon/issues/2438)).

## Case law

| Feature | Verdict | Why |
|---------|---------|-----|
| `approval:` nodes, `trigger_rule`, `retry:` | ✅ admitted | Pure governance — the engine must see them to pause, join, and re-run |
| `loop:` / `loop_group:` | ✅ admitted | Iteration structure the engine must own for events, gates, and cost accounting |
| `include:` (load-time inlining, [#2121](https://github.com/coleam00/Archon/issues/2121)) | ✅ admitted | Textual composition, zero new runtime semantics — the engine sees a flat DAG |
| ~~`first_success` racing join~~ ([#1764](https://github.com/coleam00/Archon/issues/1764), implemented in [#2250](https://github.com/coleam00/Archon/pull/2250)) | ❌ **rejected 2026-08-04** — reverses an earlier ✅ | Admitted originally as "a join rule — coordination", which is true of its *shape* and misses what it does: the winner aborts and cancels the losers, so one child's outcome ends its siblings'. That is the coupling [the independence rule](#the-independence-rule) forbids, and it cannot be reshaped — racing without terminating the losers is not racing. The want underneath it (several genuinely different attempts, best result forward) is real and is served by N distinct nodes with their own models converging on a collector node, which needs no mutual cancellation |
| Runtime sub-runs (`workflow:`, #2121 Phase 2) | ✅ shipped | A sub-run is a governance object (own run record, own gates, own audit trail). Slice 1: shared checkout, `input:` string, gate-aware pause/resume. Slice 2 adds opt-in per-child isolation (`isolation: worktree`) and data-driven fan-out (`fan_out:`); `with:` remains deferred and racing is rejected outright (row above) |
| Data-driven fan-out (`fan_out:`, [#2224](https://github.com/coleam00/Archon/pull/2224)) | ✅ shipped | The expansion is *data*, not structure: the target is a static workflow name and only the child COUNT comes from a runtime array, so the parent DAG the executor runs stays flat and static. Each child is a real run record with its own gates, artifacts and cost — the sub-run escape this page already names for runtime-resolved structure (see [Composition metastasis](#2-composition-metastasis-structure-features-become-functions)). `max_parallel` and `join` are coordination (concurrency bound, join rule); nothing in the block computes |
| Per-node isolation **inferred** from another field (auto-`worktree` because a node fans out, or has a concurrent sibling) | ❌ rejected | The engine never infers isolation. How many children a node spawns says nothing about whether they write — N review or research children over a shared checkout is the common case. The engine's job is to make the author's declaration hold, not to guess what they must have meant; `isolation: worktree` and `mutates_checkout: false` are where those two claims get made. (Run-level worktree-by-default is a different thing and stands: a whole run against a repo has an owner and a lifecycle.) |
| Fail-fast sibling cancellation on a failing join | ❌ rejected | One child's failure cancelled its in-flight siblings mid-run so a doomed join stopped burning tokens. Defensible under "one job split N ways"; wrong under [independence](#the-independence-rule) — the siblings' output is exactly what a partial failure is supposed to preserve. Every index now spawns and every child reaches its own terminal state before the join reduces. The trade is explicit: worst-case spend is `items.length`, not "until the first failure", which is what makes a run-tree budget ceiling ([#1961](https://github.com/coleam00/Archon/issues/1961)) load-bearing rather than theoretical |
| `join: all_success` as the **default** | ❌ rejected as a default (retained as an option) | Defaulting to all-or-nothing assumes children's fates are linked, which is the uncommon case — two researchers with different scopes, or ten triage children over ten issues, do not depend on each other. A failed child would discard its siblings' output at the join even after they ran to completion. `all_done` is the default: every terminal outcome aggregates, failures represented as data, and the downstream node decides what is enough. `all_success` stays for the genuinely dependent case, where the author says so |
| A threshold join (`succeed if ≥ K children completed`) | ❌ rejected | Judgement wearing a join rule's clothes. How many results are enough is a decision about the work, and it belongs in a script or prompt node reading the `all_done` aggregate, with `when:` gating what follows. Admitting it starts a policy language inside an enum |
| `workflow:` targets resolve at SPAWN time, not load time ([#2200](https://github.com/coleam00/Archon/issues/2200)) | ✅ admitted (deliberate) | Unlike `include:` (load-time inlining), a sub-run's target is resolved when the node runs. This asymmetry is the mechanism by which a run can author a workflow mid-flight and then execute it as a governed child run — the agent's decisions land as readable, promotable YAML rather than opaque in-conversation steps. It is *not* dynamic structure: the target is still a static name, and the child is a separate governance object with its own run record, gates, and audit trail. Adding a load-time existence check for `workflow:` targets would compile, pass every existing test, and silently destroy the capability. Locked by `describe('workflow: late resolution is a deliberate affordance')` in `packages/workflows/src/subrun.test.ts` |
| `evidence_policy` terminal-success gate ([#2230](https://github.com/coleam00/Archon/issues/2230)) | ✅ admitted (thin slice) | A run-status transition (sibling of `approval:`) — the engine gates on `evidence.json` PRESENCE only; computing/validating the evidence stays in the workflow's script/bash nodes. The full typed-schema + reality-verification surface of PR #1601 was rejected as computation |
| Arithmetic / string functions / regex in `when:` | ❌ rejected | Computation. A script node computes the decision; `when:` gates on its output |
| Parentheses & nested boolean grouping in `when:` | ❌ rejected (see policy below) | The first step of home-growing an expression language |
| Templating (Jinja-style interpolation, computed node ids) | ❌ rejected | Evaluation inside declaration — the Helm road |
| Dynamic include targets (`include: $x.output`) | ❌ rejected | Turns structure into a runtime value; the engine can no longer statically validate the graph |
| `with:` include parameters | ✅ shipped (data-only) | Identifier-keyed string values are substituted during load-time expansion; inserted `$node.output` values continue through normal runtime output substitution. `workflow.with` is not yet shipped |

## The five smells — and the management lever for each

These are the specific mechanisms by which workflow languages rot. Each is listed with how the pressure arises, how it would look in Archon, and the lever that manages it. The smells are not hypothetical — several were observed directly in the 2026-07 defaults audit.

### 1. Expression creep (`when:` wants to become CEL)

**Mechanism.** A condition language starts minimal. Users hit a case it can't express, file a reasonable issue ("just add parentheses", "just add `contains()`"), and each grant is small. But expression languages have no natural stopping point — after parens come functions, after functions comes arithmetic, and each addition makes the *next* one look smaller. The end state is an informally-specified expression language with no debugger, no unit tests, and semantics defined by one regex in one file.

**Archon today.** `when:` is deliberately tiny: six comparison operators, `&&`/`||`, *no parentheses*. That's a feature, not a gap.

**Lever — the wholesale-or-nothing policy.** `when:` never grows incrementally. Requests for more expressive conditions get one of two answers: (a) compute the decision in a script node and gate on its structured output (`when: "$decide.output.proceed == true"`) — this is almost always the right answer and works today; or (b) if genuine demand accumulates for years, adopt a *specified, tested, third-party* expression language (CEL) wholesale in a single versioned change — never home-grow one operator at a time. There is no option (c).

### 2. Composition metastasis (structure features become functions)

**Mechanism.** Reuse primitives are the most dangerous axis because they converge on function application: includes become calls, parameters become arguments, loop-carried state becomes variables — and suddenly the config format has scoping rules, evaluation order, and abstraction. This is how Helm charts became programs.

**Archon today.** `loop_group` already carries loop-state (`$LOOP_PREV`); `include:` adds textual reuse. Both are held on the declarative side deliberately: `include` is load-time expansion with zero new runtime semantics, and its shipped `with:` surface is a data-only string mapping resolved during expansion. Expressions, deep output access across the include boundary, `workflow.with`, and dynamic targets remain unsupported.

**Lever — composition must be resolvable at load time.** Any reuse feature must fully resolve before execution begins (the engine executes a flat, static DAG). Parameterization, if ever added, is data-only mapping. Anything requiring runtime resolution of *structure* is Phase-2 sub-run territory — where it becomes a governance object with its own run record, not a language feature.

### 3. Workaround pressure (copy-paste is a feature request in disguise)

**Mechanism.** When a primitive is missing, users don't stop — they work around it: copy-pasted blocks, abused fields, prompt-embedded logic. The workarounds accumulate until the pressure forces a primitive, and if the maintainer isn't watching, the primitive that ships is shaped by the workaround rather than by the constitution.

**Archon today (observed).** The defaults audit found a 9-node review block copy-pasted into five workflows and a byte-identical bash node in up to nine — precisely because composition was missing. That evidence produced `include:` (#2121), a constitutional feature. The same audit found the opposite failure too: deterministic validation suites narrated as AI prose because authors lacked a polyglot pattern — resolved not with a YAML feature but with a *pattern* (detect with AI → execute with bash → fix with AI).

**Lever — audit the workarounds, not the requests.** Periodically audit real workflows (bundled and user-reported) for repeated structure and embedded logic. Each finding gets classified: missing *coordination* primitive → design it constitutionally; missing *pattern* → document the pattern; computation that has leaked *into the YAML surface* → point to script nodes (this bucket is about the language, never about rewriting an author's prompt — see *Read "prompt-embedded logic" carefully* below). The workaround corpus, not the feature-request queue, decides what the language needs.

**Read "prompt-embedded logic" carefully.** It is a signal for *language design* — evidence that a coordination primitive or a documented pattern may be missing. It is **not** a finding against the workflow, and not a mandate to refactor authored prompts into script nodes. A prompt doing deterministic work becomes a smell when the same shape **recurs** — across workflows, or across nodes within one workflow — because recurrence is what indicates a missing primitive or an undocumented pattern. What is *not* a smell is one author choosing a prompt for one computation: that is the author exercising a legitimate choice (see *The rule*), and it is a finding about the language only when it repeats.

### 4. Schema width (the parameter matrix is a symptom)

**Mechanism.** Every per-provider capability lands as a node field; fields accumulate interactions; soon authors need a compatibility matrix to know what works where. Width is quieter than expression creep but produces the same outcome: a language nobody can hold in their head.

**Archon today.** The node schema carries ~15 AI-tuning fields (`hooks`, `mcp`, `skills`, `agents`, `sandbox`, `effort`, `thinking`, `betas`, …), several valid on only one or two providers — the agent skill literally ships a parameters-×-node-types matrix because one is needed.

**Lever — contain, alias, and warn loudly.** (a) New provider capabilities default to living inside *provider config or tier/alias presets* (`tiers:`/`aliases:` already resolve provider+model+effort as one named unit) rather than as new node fields; a node field is only warranted when per-node variance is the actual use case. (b) Capability mismatches must warn (never silently no-op) — the capability flags in each provider's `capabilities.ts` are the single source of truth, and docs derive from them rather than hand-tracking (see [#2116](https://github.com/coleam00/Archon/issues/2116)). (c) The matrix page is treated as a smoke alarm: when it stops fitting on one screen, the schema — not the docs — is the problem.

### 5. Implicit magic (behavior nobody wrote down)

**Mechanism.** Languages feel "bad" less because of size than because of *surprise*: behaviors that fire without being declared. Auto-coercions, silent fallbacks, context that appears from nowhere. Each one is added as a convenience; together they make workflows impossible to reason about from the file alone.

**Archon today.** A few deliberate implicits exist (`$CONTEXT` auto-append, parallel-layer session reset, default transient retries on AI nodes). Each is documented and each is either fail-safe or user-visible. Failed-run resume is explicit: users opt in with a CLI flag or command, or the web UI resume action. The engine's broader posture leans hard the other way: unresolvable `$node.output.field` refs *fail loudly*, structured-output misses *fail* rather than degrade, unknown providers *reject the file*, invalid fields *warn*.

**Lever — the implicit-behavior budget.** Every implicit behavior must be (a) documented in the same table (the authoring docs' behavior list), (b) individually defeatable (`always_run`, `context: fresh`, explicit retry config), and (c) justified as fail-safe. New implicit behaviors require the same admissibility scrutiny as new fields — convenience alone never qualifies. When in doubt: explicit beats implicit, loud beats silent.

**Applied case — the unregistered-cwd output fallback ([#2200](https://github.com/coleam00/Archon/issues/2200)).** A run whose codebase cannot be resolved used to write its artifacts and logs to `<cwd>/.archon/` — the ENGINE itself writing output into the user's repository, with no declaration anywhere in the workflow file. It is now an implicit behavior that fails safe: the run resolves to `~/.archon/workspaces/_cwd/<basename>/` like every other project kind, so output survives worktree teardown and is retrievable by run id. This was a **breaking change accepted without a migration** — in-repo output from older runs stays where it is and is no longer looked up. The escape hatch for authors who genuinely want output in git is unchanged and needs no engine support: an explicit `bash:` copy node from `$ARTIFACTS_DIR` into the worktree, committed normally. Note the shape of the fix — the answer to "the engine does something surprising" was to make the behavior *uniform*, not to add a YAML field to defeat it. A per-workflow `state: repo` opt-out was considered and rejected on question 3 of the admissibility test: a `bash:`/`script:` node writing a relative path expresses it today, which is exactly what every pre-`$STATE_DIR` workflow did with zero engine support.

## What this means in practice

For **contributors**: cite this page in `feat(workflows)` PRs that touch the YAML surface. A reviewer's first question is the admissibility test, not the implementation.

For **workflow authors**: if you're fighting the YAML — wanting arithmetic in `when:`, string manipulation in a field, cleverness in structure — the language is telling you the logic belongs one level down — into a `script:`/`bash:` node or a `prompt:`, whichever fits the problem (see *The rule*: that choice is yours, not the constitution's) — leaving the YAML to do what it's for: wiring the pieces the engine governs.

For **the roadmap**: the constitution is why Archon can keep its declarative surface while workflows-as-code frameworks exist. The trade — auditability, the visual builder, non-engineer operators — stays won exactly as long as the YAML stays a coordination language. The day it computes, it loses to both alternatives at once.
