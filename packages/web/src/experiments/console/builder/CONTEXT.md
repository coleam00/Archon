# Archon Studio Builder

The in-console visual workflow builder and its surrounding capabilities (authoring,
persistence and AI-assisted authoring). This glossary fixes the
language used across the builder PR series so the same concept never travels under two names.

## Language

**Builder Copilot**:
The AI chat assistant embedded in the workflow builder. It converses with the author and emits
Proposed Edits against the workflow currently on the canvas. It does not edit autonomously.
_Avoid_: builder agent, AI builder, workflow bot

**Proposed Edit**:
A single structured change the Builder Copilot suggests (add a node, connect two nodes, set a
field, rename, remove), expressed in the builder's own mutation vocabulary so it can be applied
through the same reducer a manual edit uses.
_Avoid_: op, action, command, mutation (these are the implementation names; "Proposed Edit" is the domain term)

**Proposal**:
The atomic batch of Proposed Edits the Builder Copilot returns from one turn. The author Accepts
or Rejects a Proposal as a whole; a Proposal is never partially applied.
_Avoid_: suggestion set, change set, batch
