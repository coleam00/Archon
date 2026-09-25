# Archon engineering craft

This document is what work gets checked against, not instructions for doing work. Operational rules for agents stay in `AGENTS.md`, which every agent loads and which stays short. This document is Archon's own project context, not ambient context a workflow pack loads: it reaches an agent through `AGENTS.md`'s pointer to it, or because an evaluator — a reviewer, a questioner, a gate designer — was explicitly briefed on it. It can afford depth because only evaluators go looking for it.

## How this document works

- The operator writes it. Agents may propose entries as artifacts from real runs; promotion into this file is always an operator edit. An evaluator that revises its own criteria is not calibrating, it is drifting.
- Anything here that becomes machine-checkable graduates to a lint rule, a type, or a CI check, and then leaves this file. One owner per rule. This file holds what needs judgment; checkers hold what needs enforcement.
- Entries are phrased so drift is catchable: prefer claims that can be audited against the codebase over vibes. A periodic pass grades entries confirmed or drifted. Drifted entries are deleted, not annotated; a stale correction is worse than none.
- Facts that change (counts, paths, inventories) do not belong here at all. Point at the owning source.
- Rules here earned their place through real failures or operator decisions. The stories stay in run artifacts and git history; this file keeps only the rule.

## The objective function

Correct first. Cost-efficient second. Speed last.

Speed is a convenience for the operator while working, never a reason to thin verification. A review that is fast and wrong failed. Spend more on changes that can destroy things and less on changes that cannot; a flat cost per change is a sign nobody is judging stakes.

## Aspirations

**The survival shape.** The tools that survive the agentic era, above all tools for engineers and their agents, have a small strong core and extend at the seams. Agents multiply how fast everything around a tool changes: providers, models, harnesses, and integrations churn monthly, and no monolith keeps up by adding surface. It keeps up by owning less, harder. The core must be usable from any surface: our CLI, our server, someone else's product, a script in CI. Users build their own surfaces, providers, adapters, and isolation backends at their own convenience, against contracts we keep stable. That is why the engine becomes an SDK. The SDK is not a packaging decision; it is the survival shape of the product.

The review test this yields: when a change grows the core, ask whether a seam could have carried it. Core growth that a plugin, adapter, or host could express is a finding, not a feature.

These describe where the engineering is going. Do not reject a change for failing to complete an aspiration; reject new coupling that makes one materially harder.

- **The core becomes self-sufficient.** The engine stands alone as an SDK: define, validate, run, resume, govern, and query workflows with no server, no UI, no database, no platform adapter required. Core plus CLI is a complete install. Append-only files are the default persistence; a database is an adapter.
- **Adapters and providers sit behind clear contracts.** A provider or platform integration attaches through a typed seam the engine owns. If adding an integration requires touching engine control flow, the contract is missing or wrong.
- **Provider SDKs are for observability and for running the user's configuration.** They translate options, surface events and usage truthfully, and preserve the user's native config, auth, and guidance. They are not a place for engine logic, capability widening, or config replacement.
- **Every engine capability has a host seam.** Wakes, schedules, triggers, and cleanup are core surfaces a CLI, server loop, or third-party host can drive. The server is a batteries-included host, not the owner.

## Taste

- The smallest truthful system. Every validator, guard, state, and compatibility path protects a named requirement or a concrete failure mode. Before adding machinery, look for machinery to delete.
- Fix drift on the path you touch. When a change reveals two sites that should agree and do not — one recording a field the other omits, one performing a cleanup the other skips — correct them rather than carry the disagreement forward. A pure-move diff is easier to review, and that is not enough: deferring buys a second change and a second review that usually never come, while the drift keeps producing the defect that exposed it. Code is cheap; a second run is not. The bound is relevance, not size — correct what the change already touches, not what it merely noticed.
- Types carry invariants. Invalid states should be hard to represent; a sound type beats a runtime check beats a comment. Escape hatches carry a justification or they are findings.
- Explicit control flow over meta-programming, shared mutable state, or hidden coupling. Duplicate small local logic until a pattern has repeated and stabilized.
- Fail early and loudly on unsupported, ambiguous, or unsafe states. A fallback is intentional, documented at the branch, and observable, or it is a bug.
- Derive shared vocabularies; never re-enumerate them at a use site. A status set or capability list spelled out where it is consumed drifts from its owner. Derived, a new member inherits the right behavior automatically.
- A guard is evidence only after it has been seen red. Before trusting any check, retry, or validation, watch it fail against the condition it claims to catch. This applies to tests, lint rules, and platform behavior alike: built-in options are claims until probed.
- When isolating a boundary, prove the isolation against every path in, not only the one you thought of.
- Comments clarify functionality and how code is used, and they stay current when behavior changes. Never request a comment on self-explanatory code; request removal or editing of comments on self-explanatory code instead. Code that is not self-explanatory is usually too complex and the finding is simplification, not narration. A missing comment is reportable only when the change introduces durable knowledge that code or types cannot express: a surprising external constraint, a non-obvious safety or ordering requirement, a deliberate compatibility compromise a future maintainer could clean up and break, or operational behavior not discoverable from the local code. Never request narration of control flow, parameter names, or implementation steps.

## Risk taxonomy

What raises the stakes of a change, and therefore the depth of its review:

- Irreversible or destructive paths: deletion, force operations, terminal state transitions, anything that touches user-owned estate.
- Lifecycle ownership: code that decides whether work is alive, dead, resumable, or abandoned.
- Schema and persisted contracts: identifiers, wire values, additive-only evolution.
- Credentials and auth boundaries.
- Provider and adapter boundaries: native config preservation, capability scoping.
- Concurrency and shared estate: worktrees, sessions, leases.

A change in these areas gets adversarial review depth: an explicit attempt to refute, input-set variation, and a stated answer to "what would make this merge wrong." A docs or prose change gets the minimum. This section is the authority for Archon's own review depth. The bundled SDLC pack states a generic version of this list inside its own prompts, because a reusable pack cannot read a path only this repository has; that copy is a deliberate fork, not a synced mirror, and editing one does not change the other.

## Review posture

- An unengaged risk is a failure. If the orchestrator names a risk and no lens engages it, the review is not clean, it is incomplete, and the verdict must say so.
- "Could not tell" is a verdict. Ambiguity, lens disagreement, and low confidence produce an inconclusive outcome for a human, never a silent pass and never a manufactured correction.
- A malformed or failed verdict call defaults conservative: toward not-ready, never toward pass.
- Findings and discoveries carry their source. Attribution is what makes calibration possible; an unattributed finding cannot teach anything.
- Review anchors on the original work order. The implementation's account of itself, including the PR body and any self-report, is a set of claims to verify, never a scope definition.
- A defect that violates the same invariant through the same mechanism as the change under review is in scope: a correction, not a discovery.
- Tests prove a decision by varying the input it turns on, against the real primitive. A test that stubs the deciding function passes under every mutation of it and proves nothing.
- Two individually green changes can compose into a failure. A composition is its own change; checks that passed on the parts are claims about the parts.
- Simplification found at review is corrected on the produced change, not deferred. Code is cheap to regenerate; merged complexity compounds into drift that every later change pays for. A concrete smaller shape that preserves behavior is a correction-round finding, and a verdict may rest on simplification alone. A simplification that is speculative or risks behavior stays a suggestion.
