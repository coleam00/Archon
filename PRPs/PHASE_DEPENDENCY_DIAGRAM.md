# Agent Work Orders - Phase Dependency Diagram

## Visual Flow Chart

```mermaid
graph TD
    Start[Start: Current System<br/>Hardcoded .md commands] --> Phase1

    Phase1[Phase 1: Template Storage<br/>Database + APIs<br/>⏱️ 1.5 weeks<br/>❌ No breaking changes]

    Phase1 --> Phase2
    Phase1 --> Phase3A

    Phase2[Phase 2: Context Hub UI<br/>Template Management Frontend<br/>⏱️ 2 weeks<br/>❌ No breaking changes]

    Phase2 --> Phase3A

    Phase3A[Phase 3A: Template Execution<br/>Sub-Workflows + Flag Toggle<br/>⏱️ 2.5 weeks<br/>⚠️ Flag-gated per repository]

    Phase3A --> Phase3B
    Phase3A --> Phase4
    Phase3A --> Phase5

    Phase3B[Phase 3B: Orchestrator Agent<br/>PydanticAI Conversational Interface<br/>⏱️ 2 weeks<br/>❌ No breaking changes]

    Phase3B --> Phase4

    Phase4[Phase 4: Human-in-the-Loop<br/>Pause/Resume at Checkpoints<br/>⏱️ 2 weeks<br/>⚠️ Changes workflow timing]

    Phase4 --> Phase5

    Phase5[Phase 5: Multi-CLI Adapters<br/>Claude/Gemini/Codex Support<br/>⏱️ 1.5 weeks<br/>❌ No breaking changes]

    Phase5 --> Phase6

    Phase6[Phase 6: Parallel Execution<br/>Deferred to Future<br/>⏱️ 3-4 weeks<br/>⚠️ High complexity]

    Phase6 --> Complete[Complete:<br/>Full Template System]

    style Start fill:#e1f5ff
    style Phase1 fill:#c3f0ca
    style Phase2 fill:#c3f0ca
    style Phase3A fill:#fff4c3
    style Phase3B fill:#c3f0ca
    style Phase4 fill:#fff4c3
    style Phase5 fill:#c3f0ca
    style Phase6 fill:#ffd4d4
    style Complete fill:#d4f5d4
```

## Phase Breakdown

### Legend
- 🟢 Green: No breaking changes, additive only
- 🟡 Yellow: Breaking changes but flag-gated/controlled
- 🔴 Red: High complexity, deferred to future

---

## Phase 1: Template Storage System
**Duration**: 1.5 weeks | **Risk**: Low | **Breaking**: ❌ None

```mermaid
graph LR
    DB[(Database)] --> Models[Pydantic Models]
    Models --> Services[Template Services]
    Services --> API[REST API Endpoints]
    API --> Test[✓ Still uses<br/>hardcoded .md]

    style DB fill:#c3f0ca
    style Models fill:#c3f0ca
    style Services fill:#c3f0ca
    style API fill:#c3f0ca
    style Test fill:#d4f5d4
```

**Deliverables**:
- ✅ Database tables (agent_templates, step_templates, workflow_templates)
- ✅ CRUD APIs for templates
- ✅ Seed data mirroring hardcoded commands
- ✅ Versioning system

**Validation**: Create work order → Still uses `.claude/commands/*.md` files

---

## Phase 2: Context Hub Frontend
**Duration**: 2 weeks | **Risk**: Low | **Breaking**: ❌ None

```mermaid
graph LR
    Phase1[Phase 1<br/>Template APIs] --> UI[Context Hub UI]
    UI --> Browse[Browse Templates]
    UI --> Create[Create/Edit Templates]
    UI --> SubWorkflow[Configure Sub-Workflows]
    UI --> Version[View Version History]
    Create --> Test[✓ Still uses<br/>hardcoded .md]

    style Phase1 fill:#c3f0ca
    style UI fill:#c3f0ca
    style Browse fill:#e1f5ff
    style Create fill:#e1f5ff
    style SubWorkflow fill:#e1f5ff
    style Version fill:#e1f5ff
    style Test fill:#d4f5d4
```

**Deliverables**:
- ✅ Agent Template Library view
- ✅ Step Template Library view (with sub-step builder)
- ✅ Workflow Builder UI
- ✅ Repository Configuration page

**Validation**: Create template via UI → Work orders still use hardcoded commands

---

## Phase 3A: Template Execution System (CRITICAL PATH)
**Duration**: 2.5 weeks | **Risk**: Medium | **Breaking**: ⚠️ Flag-gated

```mermaid
graph TD
    Phase1[Phase 1<br/>Templates] --> Resolver[Template Resolver]
    Phase2[Phase 2<br/>UI] --> Resolver
    Resolver --> Flag{Repository<br/>Flag}
    Flag -->|False| Hardcoded[Use .md files<br/>EXISTING BEHAVIOR]
    Flag -->|True| Templates[Use Templates<br/>NEW BEHAVIOR]
    Templates --> SubOrch[Sub-Workflow<br/>Orchestrator]
    SubOrch --> Execute[Execute with<br/>Multiple Agents]
    Hardcoded --> Git[Git Operations]
    Execute --> Git
    Git --> Done[Work Order Complete]

    style Phase1 fill:#c3f0ca
    style Phase2 fill:#c3f0ca
    style Resolver fill:#fff4c3
    style Flag fill:#fff4c3
    style Templates fill:#fff4c3
    style SubOrch fill:#fff4c3
    style Hardcoded fill:#c3f0ca
    style Execute fill:#fff4c3
    style Git fill:#e1f5ff
    style Done fill:#d4f5d4
```

**Deliverables**:
- ✅ Template resolution engine
- ✅ Sub-workflow orchestrator (multi-agent support)
- ✅ Flag toggle per repository (`use_template_execution`)
- ✅ Backward compatibility (hardcoded mode remains default)

**Validation**:
1. Default repositories → Hardcoded .md files
2. Opt-in repositories → Template-based execution
3. Sub-workflows → Multiple agents collaborate on single step

**Core Steps** (configurable with templates):
- Planning (can have sub-steps)
- Execute (can have sub-steps)
- Review (can have sub-steps)

**Setup Steps** (always hardcoded):
- create-branch (git operation)
- commit (git operation)
- create-pr (GitHub API)

---

## Phase 3B: Orchestrator Agent
**Duration**: 2 weeks | **Risk**: Low | **Breaking**: ❌ None

```mermaid
graph LR
    Phase3A[Phase 3A<br/>Template Execution] --> Orchestrator[PydanticAI<br/>Orchestrator]
    Orchestrator --> Chat[Chat Interface]
    Chat --> Select[Intelligent<br/>Agent Selection]
    Select --> Create[Create Work Order<br/>with Templates]
    Create --> Monitor[Monitor Progress]
    Monitor --> HITL[Facilitate HITL<br/>Phase 4]

    style Phase3A fill:#fff4c3
    style Orchestrator fill:#c3f0ca
    style Chat fill:#e1f5ff
    style Select fill:#e1f5ff
    style Create fill:#e1f5ff
    style Monitor fill:#e1f5ff
    style HITL fill:#ffd4d4
```

**Deliverables**:
- ✅ PydanticAI conversational agent
- ✅ 7 orchestrator tools (create, monitor, pause, resume, etc.)
- ✅ Intelligent agent selection based on task analysis
- ✅ Chat panel UI integrated into AWO page

**Validation**: Chat: "Add authentication" → Recommends Python expert + Security reviewer → Creates work order with custom templates

---

## Phase 4: Human-in-the-Loop
**Duration**: 2 weeks | **Risk**: Medium | **Breaking**: ⚠️ Changes timing

```mermaid
graph TD
    Phase3A[Phase 3A<br/>Template Execution] --> Workflow[Workflow Execution]
    Workflow --> Planning[Planning Step]
    Planning --> Pause1{Pause<br/>Checkpoint?}
    Pause1 -->|Yes| Wait1[Wait for<br/>User Decision]
    Wait1 --> Decision1{User<br/>Decision}
    Decision1 -->|Approve| Execute[Execute Step]
    Decision1 -->|Revise| Planning
    Decision1 -->|Cancel| Failed[Work Order Failed]
    Pause1 -->|No| Execute
    Execute --> Pause2{Pause<br/>Checkpoint?}
    Pause2 -->|Yes| Wait2[Wait for<br/>User Decision]
    Pause2 -->|No| Review[Review Step]
    Wait2 --> Decision2{User<br/>Decision}
    Decision2 -->|Approve| Review
    Decision2 -->|Revise| Execute
    Review --> Complete[Work Order Complete]

    style Phase3A fill:#fff4c3
    style Workflow fill:#c3f0ca
    style Pause1 fill:#fff4c3
    style Pause2 fill:#fff4c3
    style Wait1 fill:#fff4c3
    style Wait2 fill:#fff4c3
    style Decision1 fill:#fff4c3
    style Decision2 fill:#fff4c3
    style Failed fill:#ffd4d4
    style Complete fill:#d4f5d4
```

**Deliverables**:
- ✅ Pause service (database-backed pause states)
- ✅ Workflow orchestrator pause/resume logic
- ✅ Configurable checkpoints in workflow templates (`pause_after: true`)
- ✅ PauseStateCard UI component with Approve/Revise/Cancel
- ✅ Polling-based (WebSocket deferred to future)

**Checkpoints**:
1. After Planning → Review and approve plan
2. After Execute → Decide if code review needed
3. After Review → Approve changes or request corrections

**Validation**: Workflow pauses at configured checkpoints → User reviews → Workflow continues or revises based on feedback

---

## Phase 5: Multi-CLI Adapter System
**Duration**: 1.5 weeks | **Risk**: Low | **Breaking**: ❌ None

```mermaid
graph TD
    Phase3A[Phase 3A<br/>Template Execution] --> Factory[CLI Adapter<br/>Factory]
    Factory --> Claude[Claude<br/>Adapter]
    Factory --> Gemini[Gemini<br/>Adapter]
    Factory --> Codex[Codex<br/>Adapter<br/>Future]
    Claude --> Normalize[Normalize to<br/>CLIEvent]
    Gemini --> Normalize
    Codex --> Normalize
    Normalize --> Orchestrator[Workflow<br/>Orchestrator]
    Orchestrator --> Config{Repository<br/>Config}
    Config -->|Claude| UseC[Execute with Claude CLI]
    Config -->|Gemini| UseG[Execute with Gemini CLI]
    UseC --> Complete[Work Order Complete]
    UseG --> Complete

    style Phase3A fill:#fff4c3
    style Factory fill:#c3f0ca
    style Claude fill:#e1f5ff
    style Gemini fill:#e1f5ff
    style Codex fill:#ffd4d4
    style Normalize fill:#c3f0ca
    style Config fill:#c3f0ca
    style UseC fill:#e1f5ff
    style UseG fill:#e1f5ff
    style Complete fill:#d4f5d4
```

**Deliverables**:
- ✅ CLIAdapter abstract base class
- ✅ Claude CLI adapter (stream-json parsing)
- ✅ Gemini CLI adapter (stream-json parsing)
- ✅ Adapter factory (provider selection)
- ✅ Event normalization (all CLIs → same event format)

**Scope**: Provider switching (Claude **OR** Gemini), not parallel execution (Claude **AND** Gemini)

**Validation**: Switch repository to Gemini → Work order executes with Gemini CLI → Same event structure as Claude

---

## Phase 6: Parallel CLI Execution (DEFERRED)
**Duration**: 3-4 weeks | **Risk**: High | **Breaking**: ⚠️ Complex

```mermaid
graph TD
    Phase5[Phase 5<br/>Multi-CLI] --> Config[Parallel<br/>Configuration]
    Config --> Split[Fork Workflow]
    Split --> Claude[Execute with<br/>Claude CLI]
    Split --> Gemini[Execute with<br/>Gemini CLI]
    Claude --> Worktree1[Worktree 1<br/>Claude Branch]
    Gemini --> Worktree2[Worktree 2<br/>Gemini Branch]
    Worktree1 --> Compare[Compare<br/>Outputs]
    Worktree2 --> Compare
    Compare --> Strategy{Merge<br/>Strategy}
    Strategy -->|Best| Auto[Auto-select<br/>Best Result]
    Strategy -->|User Choice| Manual[User<br/>Selects Winner]
    Strategy -->|Side-by-Side| Both[Create Both PRs<br/>for Comparison]
    Auto --> Merge[Merge to Main]
    Manual --> Merge
    Both --> Merge

    style Phase5 fill:#c3f0ca
    style Config fill:#ffd4d4
    style Split fill:#ffd4d4
    style Claude fill:#ffd4d4
    style Gemini fill:#ffd4d4
    style Compare fill:#ffd4d4
    style Strategy fill:#ffd4d4
    style Merge fill:#ffd4d4
```

**Scope**: Execute multiple CLIs simultaneously, compare outputs, merge results

**Challenges**:
- Parallel worktree management
- Result comparison algorithms
- Conflict resolution
- Resource/cost management

**Decision**: Defer until Phases 1-5 proven stable

---

## Critical Path Analysis

```
Phase 1 (1.5w) → Phase 2 (2w) → Phase 3A (2.5w) → Phase 3B (2w) → Phase 4 (2w) → Phase 5 (1.5w)
                                      ↓
                                   CRITICAL

Total: 11.5 weeks for Phases 1-5
```

**Phase 3A is the critical path** - all subsequent phases depend on it.

**Parallelization Opportunities**:
- Phase 3B and Phase 4 can start simultaneously after Phase 3A
- Phase 5 can start after Phase 3A (doesn't need Phase 3B/4)

---

## Risk Heatmap

| Phase | Complexity | Risk | Breaking Changes | Testing Burden |
|-------|-----------|------|------------------|----------------|
| Phase 1 | Medium | 🟢 Low | None | Medium |
| Phase 2 | High | 🟢 Low | None | Medium |
| **Phase 3A** | **Very High** | 🟡 **Medium** | **Flag-gated** | **High** |
| Phase 3B | High | 🟢 Low | None | Medium |
| Phase 4 | High | 🟡 Medium | Changes timing | High |
| Phase 5 | Medium | 🟢 Low | None | Medium |
| Phase 6 | Very High | 🔴 High | Complex | Very High |

**Highest Risk**: Phase 3A (template execution system)
- Most complex
- Touches core orchestrator
- Potential for breaking existing workflows
- Requires extensive backward compatibility testing

**Mitigation**:
- Flag-gated rollout (`use_template_execution` per repository)
- Comprehensive test coverage (unit, integration, E2E)
- Extensive validation gates
- Backward compatibility tests in every phase

---

## Validation Strategy

```mermaid
graph LR
    Unit[Unit Tests<br/>Isolated Components] --> Integration[Integration Tests<br/>API Endpoints]
    Integration --> E2E[E2E Tests<br/>Full Workflows]
    E2E --> Backward[Backward Compatibility<br/>Hardcoded Mode]
    Backward --> Gate{All Tests<br/>Pass?}
    Gate -->|No| Block[❌ BLOCK<br/>Next Phase]
    Gate -->|Yes| Proceed[✅ PROCEED<br/>Next Phase]

    style Unit fill:#e1f5ff
    style Integration fill:#e1f5ff
    style E2E fill:#e1f5ff
    style Backward fill:#fff4c3
    style Gate fill:#fff4c3
    style Block fill:#ffd4d4
    style Proceed fill:#d4f5d4
```

**Mandatory Gates**:
1. **Syntax & Linting**: Zero errors (ruff, mypy, TypeScript)
2. **Unit Tests**: 80%+ coverage, all pass
3. **Integration Tests**: All API endpoints functional
4. **Backward Compatibility**: Existing workflows unaffected
5. **Performance**: No regressions in execution time

**Backward Compatibility Test** (every phase):
```bash
# Create work order
# Verify uses hardcoded .md files
# Verify no template errors
# Verify workflow completes
```

---

## Success Metrics

**Phase Completion Criteria**:
- ✅ All tasks in PRP completed
- ✅ All validation gates passed
- ✅ Zero critical bugs
- ✅ Documentation updated
- ✅ Backward compatibility verified

**Overall Project Success**:
- ✅ Users can create custom agent templates
- ✅ Users can build workflows with sub-steps
- ✅ Work orders execute using templates
- ✅ HITL checkpoints functional
- ✅ Multiple CLI providers supported
- ✅ Orchestrator provides intelligent recommendations
- ✅ Zero regressions in existing functionality
- ✅ < 5% failure rate in template-based executions

---

## Timeline Estimate

**Conservative Estimate** (with buffer):
- Phase 1: 2 weeks (1.5w + 0.5w buffer)
- Phase 2: 2.5 weeks (2w + 0.5w buffer)
- Phase 3A: 3 weeks (2.5w + 0.5w buffer) ← CRITICAL
- Phase 3B: 2.5 weeks (2w + 0.5w buffer)
- Phase 4: 2.5 weeks (2w + 0.5w buffer)
- Phase 5: 2 weeks (1.5w + 0.5w buffer)

**Total: 14.5 weeks (~3.5 months)**

**Optimistic Estimate** (if everything goes smoothly):
- Total: 11.5 weeks (~2.75 months)

**With Parallelization** (Phase 3B/4/5 overlap):
- Potential: 9-10 weeks (~2.5 months)

---

**Last Updated**: 2025-01-05
**Status**: Planning Complete, Ready for Phase 1
**Next Action**: Begin Phase 1 database migrations
