---
name: bmad-bridge
description: Reference guide for using the BMAD Method alongside the GDIT framework. Use when users ask about BMAD, want to integrate BMAD workflows, or need to convert BMAD artifacts to the GDIT framework spec format. Covers installation, capability mapping, direct artifact consumption, optional conversion, and combined workflow.
---

# BMAD Bridge

Use the BMAD Method's creative/planning strengths with the GDIT framework's implementation/compliance strengths.

## Installing BMAD

Prerequisites: Node.js 20+, Python 3.10+, uv

```
npx bmad-method install
```

Follow the installer prompts. Select the BMM (core) module at minimum. The Test Architect (TEA) module is also relevant if your project uses the GDIT framework's testing capability.

BMAD installs to `.bmad/` in your project directory. The GDIT framework uses `.kiro/`. They coexist without conflict.

## When to Use Which

| Capability | Use | Why |
|-----------|-----|-----|
| Brainstorming | BMAD | No GDIT framework equivalent; BMAD's multi-persona sessions excel here |
| Party Mode (multi-agent collab) | BMAD | Unique to BMAD — brings PM, Architect, Dev into one session |
| Advanced Elicitation | BMAD | Structured requirements gathering with domain experts |
| Adversarial Review | BMAD | Complements the GDIT framework's verification with different perspective |
| Edge-Case Hunting | BMAD | Catches scenarios before implementation |
| PRD / Requirements | BMAD | Author and maintain in BMAD; The GDIT framework reads directly |
| Architecture Doc | BMAD | Author and maintain in BMAD; The GDIT framework reads directly |
| Stories / Tasks | BMAD | Author and maintain in BMAD; The GDIT framework reads directly |
| Implementation Protocol | GDIT framework | Spec-driven workflow with protocol headers |
| Security Scanning | GDIT framework | semgrep, gitleaks, trivy built into workflow |
| Compliance (SSDF/FedRAMP) | GDIT framework | Compliance tracking and evidence collection |
| Spec Validation | Either | validate-spec.py for GDIT framework format; optional with BMAD artifacts |
| Two-Layer Verification | GDIT framework | Deterministic + semantic verification |

## Integration Modes

The GDIT framework supports two modes for working with BMAD artifacts. Users choose based on preference.

### Mode 1: Direct Consumption (default)

The GDIT framework reads BMAD artifacts in-place without conversion. The user continues authoring and iterating in BMAD. No validate-spec.py required.

**How it works:** When The GDIT framework encounters BMAD artifacts (PRD, architecture doc, stories) instead of GDIT framework specs, it builds a runtime mapping:

| BMAD Artifact | GDIT framework Concept | Runtime Mapping |
|---------------|-------------|-----------------|
| PRD user story | REQ-N | Each user story is treated as a requirement, numbered in document order |
| PRD acceptance criteria | Acceptance Criteria | Used directly — same concept |
| Architecture component/decision | Design section | Read as design guidance; correctness properties inferred from acceptance criteria |
| Story | Task | Each story is treated as a task unit |
| Story subtasks | Task checkboxes | Tracked as completion items |

**What the GDIT framework does at implementation time:**

1. Reads BMAD artifacts from `.bmad/` (or wherever the user points)
2. Maps user stories → requirements (numbered in order: first story = REQ-1, etc.)
3. Maps architecture sections → design guidance
4. Maps stories → tasks with subtasks as checkboxes
5. Infers traceability from content proximity and naming (story references to PRD sections, architecture references to components)
6. Generates the protocol header using the mapped concepts
7. Proceeds with implementation, security scanning, and compliance as normal

**Traceability in direct mode:** The GDIT framework states the mapping explicitly in the protocol header:

```
SPEC-DRIVEN IMPLEMENTATION PROTOCOL
─────────────────────────────────────
☑ Source: BMAD artifacts (direct consumption)
☑ PRD: .bmad/docs/prd.md
☑ Architecture: .bmad/docs/architecture.md
☑ Story: .bmad/docs/stories/story-3-user-auth.md
☑ Mapped requirement: User Story 3 → REQ-3 (Login with MFA)
☑ Mapped design: Architecture §4.2 (Auth Service)
☑ No assumptions beyond BMAD artifacts
```

**Limitations of direct mode:**
- No automated cross-reference validation (validate-spec.py won't run against BMAD format)
- Traceability is runtime-inferred, not structurally enforced
- If BMAD artifacts have gaps (missing acceptance criteria, vague stories), The GDIT framework will flag them at implementation time rather than at a spec gate

### Mode 2: Conversion (optional)

For teams that want the GDIT framework's structural validation gates, BMAD artifacts can be converted to the GDIT framework spec format. This is a one-time operation per feature — after conversion, the GDIT framework specs become the source of truth.

**When to choose conversion:**
- Federal/compliance projects requiring auditable traceability artifacts
- Teams that want validate-spec.py quality gates before implementation
- Projects where BMAD planning is complete and won't change

**When to skip conversion:**
- Iterative projects where BMAD artifacts evolve during implementation
- Teams that prefer BMAD as their single source of truth
- Rapid prototyping where structural validation adds overhead

### Conversion Reference

If the user chooses conversion, the mappings are:

#### PRD → requirements.md

```
BMAD PRD:                          GDIT framework requirements.md:
─────────                          ─────────────────────
User Story: As a user...     →     ## REQ-1: Feature Name
Acceptance Criteria:               **Acceptance Criteria:**
  - Can do X                       - Can do X
  - Sees Y when Z                  - Sees Y when Z
```

Extract each BMAD user story as a `## REQ-N:` section. Copy acceptance criteria as `**Acceptance Criteria:**` bullet list.

#### Architecture → design.md

```
BMAD Architecture:                 GDIT framework design.md:
──────────────────                 ────────────────
Component Design             →     ### Component (REQ-1)
  Technical approach                Technical approach
  (no correctness props)            **Correctness Properties:**
  (no task refs)                    - Property from AC
                                    **Implemented by**: Task 1
```

Add `(REQ-N)` to section headers. Add `**Correctness Properties:**` derived from acceptance criteria. Add `**Implemented by**: Task N` forward references.

#### Stories → tasks.md

```
BMAD Story:                        GDIT framework tasks.md:
───────────                        ──────────────
Story: Implement login       →     ### Task 1: Implement login
  Subtasks:                        - [ ] Subtask 1
  - Subtask 1                      - [ ] Subtask 2
  - Subtask 2                      - **Addresses**: REQ-1
  (no traceability)                - **Design**: design.md#section
```

Add `**Addresses**: REQ-N` and `**Design**: design.md#anchor` to each task. Convert subtasks to `- [ ]` checkboxes. Add effort estimate tables.

After conversion, run: `python3 ~/.kiro/scripts/validate-spec.py .kiro/specs/<feature>/`

## BMAD Artifact Discovery

When a user asks the GDIT framework to implement from BMAD artifacts, it searches for them in this order:

1. `.bmad/docs/` — standard BMAD output location
2. `docs/` — some projects keep BMAD output here
3. User-specified path — if the user points to a specific location

Common BMAD artifact filenames:
- `prd.md` or `product-requirements.md` — PRD
- `architecture.md` or `technical-architecture.md` — Architecture
- `stories/` directory or `epics-and-stories.md` — Stories
- `brief.md` or `product-brief.md` — Product brief (pre-PRD)

## Recommended Combined Workflow

```
BMAD (ideation + planning)  →  the GDIT framework (implementation + compliance)
                            ↑
                     User keeps iterating
                     in BMAD as needed
```

### Phase 1: BMAD (ongoing)

Use BMAD for brainstorming, elicitation, and planning. Produce PRD, architecture, and stories. Continue refining these artifacts throughout the project — they remain the source of truth.

### Phase 2: the GDIT framework (implementation)

The GDIT framework reads BMAD artifacts directly (Mode 1) or from converted specs (Mode 2):

1. The GDIT framework discovers and reads BMAD artifacts
2. The GDIT framework maps BMAD concepts to the GDIT framework concepts at runtime
3. The GDIT framework generates protocol header with mapped traceability
4. The GDIT framework implements, scans, and validates as normal
5. If BMAD artifacts change, The GDIT framework re-reads them on next task

### Returning to BMAD

If requirements change or new stories are needed, the user goes back to BMAD. On the next implementation task, The GDIT framework re-reads the updated BMAD artifacts. No re-conversion needed in direct mode.

## Handling Gaps

When The GDIT framework reads BMAD artifacts directly and finds gaps:

| Gap | GDIT framework Response |
|-----|--------------|
| Story missing acceptance criteria | Flag to user before implementation; suggest adding via BMAD elicitation |
| Architecture section too vague for implementation | Ask user clarifying questions; suggest BMAD adversarial review |
| No clear story-to-PRD traceability | The GDIT framework infers from content; flags ambiguous mappings for user confirmation |
| Missing architecture for a story | Block implementation; suggest BMAD architecture review |
