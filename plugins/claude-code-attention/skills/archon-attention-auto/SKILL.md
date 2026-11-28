---
name: archon-attention-auto
description: Opt-in workflow for deciding when Claude may answer an Archon attention item on the operator's behalf using the current project's own policy documents and prior rulings.
disable-model-invocation: true
---

# Archon Attention Automation (Opt-In)

This skill is **strictly opt-in**. Never answer an Archon attention item automatically unless the operator explicitly invoked this skill or enabled automated handling for the current session.

## Decision Procedure

Before answering any open attention item via `answer_attention`:

1. **Read the current project's own guidance** — never apply hardcoded rules from outside the repository:
   - `AGENTS.md` (or `CLAUDE.md`)
   - `.archon/direction.md` (if present)
   - `.archon/architecture.md` (if present)
   - `.archon/engineering.md` (if present)
   - Any prior rulings or decisions recorded on the item or in the repository.
2. **Inspect the item's evidence**:
   - Read the item's `message`, `context`, `recommendation` (and confidence), declared `options`, and linked artifacts or transcripts.
3. **Answer only when all conditions hold**:
   - The project's own guidance directly covers this class of decision with unambiguous criteria.
   - The chosen option is declared on the item.
   - The action is reversible or explicitly pre-authorized by the project's policy.
   - You include a concise ruling note in `text` citing the exact project document section or prior ruling that justified the choice.
4. **Leave for the human operator when any of these apply**:
   - Product direction, scope, priority, or roadmap trade-offs.
   - Destructive, irreversible, security-sensitive, or deployment/release actions not explicitly pre-authorized.
   - Low confidence, conflicting evidence, or missing policy coverage.
   - Options requiring human proof or judgment outside the repository's documented criteria.

When leaving an item for the operator, do not call `answer_attention`; summarize the item, its options, and why human judgment is required.
