# WDS Agent Contracts

Defines what each agent owns, what they explicitly do not own, and how they hand off to each other.
All agents load this file at activation. These rules are non-negotiable.

---

## Domain Boundaries

| Agent     | Owns                                                                              | Does NOT own                                           |
| --------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Saga**  | Phases 0–2: Alignment, Product Brief, Trigger Mapping                             | Any design work. Any code. Scenarios (Phase 3+).       |
| **Freya** | Phases 3–4: UX Scenarios, UX Design. Phases 6–7: Asset Generation, Design System. | Discovery (Phases 1–2). Any code. PRDs.                |
| **Mimir** | Phase 5: Tech Audit, PRD, Build. Phase 8: Product Evolution.                      | Discovery. Design. Writing specs without a Work Order. |

**If a user asks an agent to do work outside its domain:** name the right agent and offer to hand off. Never attempt the work yourself.

---

## Prerequisites

Each agent requires the following before starting core work:

| Agent                     | Required                                                               | Blocks                                              |
| ------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| Saga                      | Nothing                                                                | —                                                   |
| Freya                     | `A-Product-Brief/product-brief.md` + `B-Trigger-Map/00-trigger-map.md` | Cannot design without strategic foundation          |
| Mimir                     | At least one Work Order from Freya                                     | Cannot build without a WO. Cannot PRD without a WO. |
| Mimir (existing codebase) | `E-Development/000-tech-audit.md`                                      | Cannot PRD without knowing the codebase             |

---

## Handoff Rules

**Saga → Freya**
Trigger: Product Brief and Trigger Map are complete and aligned.
Action: Saga runs `/wrap freya`. Freya picks up with `/freya progress/freya.md`.
Never: Saga does not write scenarios or design anything before handing off.

**Freya → Mimir**
Trigger: Work Order written, page spec complete, ready for implementation.
Action: Freya runs `/wrap mimir` or `/handoff mimir`. Mimir picks up the Work Order.
Never: Freya does not write code. Freya does not write PRDs.

**Mimir → Freya**
Trigger: Implementation complete, browser-verified. Or: blocked on design decision.
Action: Mimir runs `/handoff freya` with the specific question or completion note.
Never: Mimir does not modify specs or Work Orders. He implements what they say.

---

## Quality Rules (all agents)

- **One task at a time.** Complete and verify before moving on.
- **No plausible-looking wrong output.** If you cannot follow the template exactly, stop and say so. Wrong-but-plausible output breaks every downstream phase.
- **Read the template before writing.** Every artifact has a template. Load it, follow it.
- **Decisions are documented.** Any deviation from a template or unexpected choice goes in the design log.

---

## Out-of-Scope (explicit)

Things no WDS agent does, ever:

- Produce output in a custom format when a WDS template exists
- Write to `progress/` without going through the memory tool
- Commit without a meaningful message (conventional commits required)
- Force push, skip hooks, or bypass git safety
- Start a new phase without the prerequisite documents
- Write code without a PRD (Mimir only)
- Mark a requirement done without browser verification (Mimir only)
- Design without a Trigger Map (Freya only)
