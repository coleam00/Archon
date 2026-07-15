---
title: Workflow Language Constitution
description: The design rules that keep Archon's workflow YAML a coordination language — the admissibility test for new YAML features, the failure smells, and how each is managed.
category: reference
audience: [developer, contributor]
status: current
sidebar:
  order: 9
---

Every workflow engine's configuration format faces the same gravitational pull: it grows until it becomes a bad programming language. Jenkins pipelines grew Groovy. GitHub Actions grew an expression language. Helm grew Turing-complete templating. Airflow grew so much Python-in-config that it eventually surrendered and became workflows-as-code. The pattern is always the same — individually reasonable feature grants, compounding into an informally-specified, untestable, half-language that is worse than code at computing and worse than configuration at declaring.

Archon's workflow YAML is deliberately held on the right side of that line. This page is the constitution that keeps it there: the rule, the admissibility test applied to every proposed YAML feature, the known failure smells, and the management lever for each.

## The rule

> **YAML coordinates. Code computes. Agents judge.**

The workflow YAML exists to express what the **engine** must see in order to govern a run: ordering, gating, retrying, joining, pausing for humans, session identity, artifact identity, and reusable structure. Everything that *computes a value or transforms data* belongs in a `bash:`/`script:` node. Everything that *requires judgment* belongs in a prompt. The YAML is the wiring between them — nothing more.

This is not an aesthetic preference. The declarative surface is what makes Archon's core promises possible: load-time validation, the visual builder, resumability, audit trails, and approval gates all depend on the engine being able to *statically see* the workflow's structure. Every unit of computation that leaks into the YAML is a unit the engine can no longer validate, render, resume, or audit — and a unit that a script node would have handled better.

## The admissibility test

A proposed workflow-YAML feature (new field, new node type, new expression capability) must pass all three questions:

1. **Does the engine need to see it to govern the run?** Gates, joins, retries, sessions, artifacts, sub-structure — yes. A string transformation, a computed value, an arithmetic condition — no.
2. **Is it declarative data, or is it evaluation?** Data that the engine interprets with fixed semantics is fine. Anything that introduces *evaluation order, operator precedence, or user-defined abstraction* is language-building.
3. **Could a script node + existing wiring express it today?** If yes, the burden of proof is on the feature: it must earn its place by governance value (visibility, resumability, auditability), not by convenience.

If a feature computes rather than coordinates, it is rejected — with the pointer to the escape hatch that already covers it.

### Case law

| Feature | Verdict | Why |
|---------|---------|-----|
| `approval:` nodes, `trigger_rule`, `retry:` | ✅ admitted | Pure governance — the engine must see them to pause, join, and re-run |
| `loop:` / `loop_group:` | ✅ admitted | Iteration structure the engine must own for events, gates, and cost accounting |
| `include:` (load-time inlining, [#2121](https://github.com/coleam00/Archon/issues/2121)) | ✅ admitted | Textual composition, zero new runtime semantics — the engine sees a flat DAG |
| `first_success` racing join (proposed, [#1764](https://github.com/coleam00/Archon/issues/1764)) | ✅ admissible | A join rule — coordination |
| Runtime sub-runs (`workflow:`, #2121 Phase 2) | ✅ admissible | A sub-run is a governance object (own run record, own audit trail) |
| Arithmetic / string functions / regex in `when:` | ❌ rejected | Computation. A script node computes the decision; `when:` gates on its output |
| Parentheses & nested boolean grouping in `when:` | ❌ rejected (see policy below) | The first step of home-growing an expression language |
| Templating (Jinja-style interpolation, computed node ids) | ❌ rejected | Evaluation inside declaration — the Helm road |
| Dynamic include targets (`include: $x.output`) | ❌ rejected | Turns structure into a runtime value; the engine can no longer statically validate the graph |
| `with:` include parameters carrying expressions | ⚠️ constrained | Admissible only as **data-only** mapping (values or `$node.output` refs) — the moment values can be computed inline, it is function application |

## The five smells — and the management lever for each

These are the specific mechanisms by which workflow languages rot. Each is listed with how the pressure arises, how it would look in Archon, and the lever that manages it. The smells are not hypothetical — several were observed directly in the 2026-07 defaults audit.

### 1. Expression creep (`when:` wants to become CEL)

**Mechanism.** A condition language starts minimal. Users hit a case it can't express, file a reasonable issue ("just add parentheses", "just add `contains()`"), and each grant is small. But expression languages have no natural stopping point — after parens come functions, after functions comes arithmetic, and each addition makes the *next* one look smaller. The end state is an informally-specified expression language with no debugger, no unit tests, and semantics defined by one regex in one file.

**Archon today.** `when:` is deliberately tiny: six comparison operators, `&&`/`||`, *no parentheses*. That's a feature, not a gap.

**Lever — the wholesale-or-nothing policy.** `when:` never grows incrementally. Requests for more expressive conditions get one of two answers: (a) compute the decision in a script node and gate on its structured output (`when: "$decide.output.proceed == true"`) — this is almost always the right answer and works today; or (b) if genuine demand accumulates for years, adopt a *specified, tested, third-party* expression language (CEL) wholesale in a single versioned change — never home-grow one operator at a time. There is no option (c).

### 2. Composition metastasis (structure features become functions)

**Mechanism.** Reuse primitives are the most dangerous axis because they converge on function application: includes become calls, parameters become arguments, loop-carried state becomes variables — and suddenly the config format has scoping rules, evaluation order, and abstraction. This is how Helm charts became programs.

**Archon today.** `loop_group` already carries loop-state (`$LOOP_PREV`); `include:` Phase 1 adds textual reuse. Both were held on the declarative side deliberately: `include` is load-time expansion with zero runtime semantics, `with:` was **deferred and rejects fail-fast**, deep output access across the include boundary is unsupported, and dynamic targets are out of scope.

**Lever — composition must be resolvable at load time.** Any reuse feature must fully resolve before execution begins (the engine executes a flat, static DAG). Parameterization, if ever added, is data-only mapping. Anything requiring runtime resolution of *structure* is Phase-2 sub-run territory — where it becomes a governance object with its own run record, not a language feature.

### 3. Workaround pressure (copy-paste is a feature request in disguise)

**Mechanism.** When a primitive is missing, users don't stop — they work around it: copy-pasted blocks, abused fields, prompt-embedded logic. The workarounds accumulate until the pressure forces a primitive, and if the maintainer isn't watching, the primitive that ships is shaped by the workaround rather than by the constitution.

**Archon today (observed).** The defaults audit found a 9-node review block copy-pasted into five workflows and a byte-identical bash node in up to nine — precisely because composition was missing. That evidence produced `include:` (#2121), a constitutional feature. The same audit found the opposite failure too: deterministic validation suites narrated as AI prose because authors lacked a polyglot pattern — resolved not with a YAML feature but with a *pattern* (detect with AI → execute with bash → fix with AI).

**Lever — audit the workarounds, not the requests.** Periodically audit real workflows (bundled and user-reported) for repeated structure and embedded logic. Each finding gets classified: missing *coordination* primitive → design it constitutionally; missing *pattern* → document the pattern; missing *computation* → point to script nodes. The workaround corpus, not the feature-request queue, decides what the language needs.

### 4. Schema width (the parameter matrix is a symptom)

**Mechanism.** Every per-provider capability lands as a node field; fields accumulate interactions; soon authors need a compatibility matrix to know what works where. Width is quieter than expression creep but produces the same outcome: a language nobody can hold in their head.

**Archon today.** The node schema carries ~15 AI-tuning fields (`hooks`, `mcp`, `skills`, `agents`, `sandbox`, `effort`, `thinking`, `betas`, …), several valid on only one or two providers — the agent skill literally ships a parameters-×-node-types matrix because one is needed.

**Lever — contain, alias, and warn loudly.** (a) New provider capabilities default to living inside *provider config or tier/alias presets* (`tiers:`/`aliases:` already resolve provider+model+effort as one named unit) rather than as new node fields; a node field is only warranted when per-node variance is the actual use case. (b) Capability mismatches must warn (never silently no-op) — the capability flags in each provider's `capabilities.ts` are the single source of truth, and docs derive from them rather than hand-tracking (see [#2116](https://github.com/coleam00/Archon/issues/2116)). (c) The matrix page is treated as a smoke alarm: when it stops fitting on one screen, the schema — not the docs — is the problem.

### 5. Implicit magic (behavior nobody wrote down)

**Mechanism.** Languages feel "bad" less because of size than because of *surprise*: behaviors that fire without being declared. Auto-coercions, silent fallbacks, context that appears from nowhere. Each one is added as a convenience; together they make workflows impossible to reason about from the file alone.

**Archon today.** A few deliberate implicits exist (auto-resume of failed runs, `$CONTEXT` auto-append, parallel-layer session reset, default transient retries on AI nodes). Each is documented and each is either fail-safe or user-visible. The engine's broader posture leans hard the other way: unresolvable `$node.output.field` refs *fail loudly*, structured-output misses *fail* rather than degrade, unknown providers *reject the file*, invalid fields *warn*.

**Lever — the implicit-behavior budget.** Every implicit behavior must be (a) documented in the same table (the authoring docs' behavior list), (b) individually defeatable (`always_run`, `context: fresh`, explicit retry config), and (c) justified as fail-safe. New implicit behaviors require the same admissibility scrutiny as new fields — convenience alone never qualifies. When in doubt: explicit beats implicit, loud beats silent.

## What this means in practice

For **contributors**: cite this page in `feat(workflows)` PRs that touch the YAML surface. A reviewer's first question is the admissibility test, not the implementation.

For **workflow authors**: if you're fighting the YAML — wanting arithmetic in `when:`, string manipulation in a field, cleverness in structure — the language is telling you the logic belongs one level down. Compute in a script node, decide in a prompt, and let the YAML do what it's for: wiring the pieces the engine governs.

For **the roadmap**: the constitution is why Archon can keep its declarative surface while workflows-as-code frameworks exist. The trade — auditability, the visual builder, non-engineer operators — stays won exactly as long as the YAML stays a coordination language. The day it computes, it loses to both alternatives at once.
