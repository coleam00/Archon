---
name: "Phase 3B: AWO Archon Orchestrator Agent"
description: "PydanticAI conversational agent for managing Agent Work Orders through natural language with intelligent template selection"
phase: 3B
dependencies: ["Phase 1", "Phase 2", "Phase 3A"]
breaking_changes: false
---

## Original Story

```
Create an Archon Orchestrator Agent - a conversational AI assistant powered by PydanticAI that:
1. Provides natural language interface for creating work orders
2. Intelligently selects agents and workflows based on task description
3. Monitors work order progress and reports status
4. Facilitates human-in-the-loop reviews (plan, implementation, corrections)
5. Uses the chat model configured in Archon settings (OpenAI, Gemini, or Ollama)
6. Leverages templates from Phase 1-3A for sophisticated multi-agent workflows

Current limitation: Users must manually fill forms to create work orders. No conversational guidance, no intelligent template selection, no task analysis.

Goal: Enable users to chat with Archon to create and manage work orders: "Add authentication to my backend API" → Archon analyzes task → Recommends Python expert + Security reviewer → Selects multi-agent planning workflow → Creates work order with template execution → Monitors progress → Notifies at checkpoints.
```

## Story Metadata

**Story Type**: Feature
**Estimated Complexity**: High
**Primary Systems Affected**:
- Backend: New orchestrator agent in `python/src/agents/`
- Backend: Orchestrator API endpoints in `python/src/server/api_routes/`
- Frontend: New Archon Chat Panel component
- Integration: Archon settings for model configuration

**Phase Number**: 3B
**Dependencies**:
- Phase 1 (Template storage)
- Phase 2 (Context Hub UI)
- Phase 3A (Template execution system)
**Breaking Changes**: ❌ None (new feature - additive only)

---

## CONTEXT REFERENCES

### Analysis Documents

- `PRPs/ai_docs/orchestrator_analysis/AgentAnalysis.md` - Complete orchestrator design with tool specifications and code examples
- `PRPs/ai_docs/orchestrator_analysis/FrontendAnalysis.md` - Section 2: Archon Chat Panel component design
- `PRPs/IMPLEMENTATION_TRACKER.md` - Phase 3B checklist and validation gates
- `PRPs/PHASE_DEPENDENCY_DIAGRAM.md` - Visual phase flow

### PydanticAI References

- https://ai.pydantic.dev/ - Official PydanticAI documentation
- https://ai.pydantic.dev/agents/ - Agent creation patterns
- https://ai.pydantic.dev/tools/ - Tool definition with @agent.tool decorator
- https://ai.pydantic.dev/models/ - Model configuration (OpenAI, Anthropic, Gemini, Ollama)

### Existing Patterns

- `python/src/agents/` - Agent directory (currently unused in AWO)
- `python/src/server/services/credential_service.py` - Getting API keys and provider settings
- `python/src/server/api_routes/agent_chat_api.py` - Existing agent chat endpoint pattern
- `python/src/agent_work_orders/api/routes.py` - AWO service integration points
- `python/src/agent_work_orders/services/template_resolver.py` - Template resolution (Phase 3A)

### Frontend Chat Patterns

- `archon-ui-main/src/features/knowledge/components/` - Chat interface reference
- Pattern: Message list, input field, streaming responses

---

## Intelligent Agent Selection

The orchestrator analyzes user requests to recommend appropriate agents and workflows:

### Task Analysis Examples

**Backend API Task**:
```
User: "Add user authentication to my FastAPI backend"
Analysis:
  - Task type: Backend development
  - Technology: Python, FastAPI
  - Security implications: Yes
Recommendation:
  - Planning: Multi-agent (Python Expert + Security Expert + Backend Architect)
  - Execute: Python Backend Expert
  - Review: Security Reviewer
  - Workflow: "advanced-backend-workflow" with security sub-steps
```

**Frontend UI Task**:
```
User: "Build a responsive login form with validation"
Analysis:
  - Task type: Frontend development
  - Technology: React, UI/UX
  - Security implications: Minor (client-side validation)
Recommendation:
  - Planning: React UI Specialist
  - Execute: React UI Specialist
  - Review: Code Reviewer
  - Workflow: "standard-frontend-workflow"
```

**Full-Stack Feature**:
```
User: "Implement real-time chat with WebSocket"
Analysis:
  - Task type: Full-stack feature
  - Technology: Backend + Frontend
  - Complexity: High (real-time, WebSocket)
Recommendation:
  - Planning: Multi-agent (Backend Expert + Frontend Expert + System Architect)
  - Execute: Split into backend and frontend sub-workflows
  - Review: Multi-agent (Code Reviewer + Security Reviewer)
  - Workflow: "full-stack-workflow" with parallel execution (future)
```

---

## IMPLEMENTATION TASKS

### CREATE python/src/agents/orchestrator/__init__.py:

- CREATE: Empty init file for orchestrator module
- **VALIDATE**: `test -f python/src/agents/orchestrator/__init__.py && echo "✓"`

### CREATE python/src/agents/orchestrator/dependencies.py:

- IMPLEMENT: OrchestratorDependencies dataclass
- FIELDS: awo_service, template_service, repository_service, user_id
- PROTOCOLS: AWOServiceProtocol, TemplateServiceProtocol, RepositoryServiceProtocol (abstract interfaces)
- PURPOSE: Dependency injection for tools
- PATTERN: Follow PydanticAI dependency injection pattern
- IMPORTS: from dataclasses import dataclass; from typing import Protocol
- **VALIDATE**: `uv run python -c "from src.agents.orchestrator.dependencies import OrchestratorDependencies; print('✓')"`

### CREATE python/src/agents/orchestrator/prompts.py:

- DEFINE: ARCHON_ORCHESTRATOR_SYSTEM_PROMPT constant
- CONTENT: System prompt from AgentAnalysis.md Section 4 enhanced with:
  ```
  You are Archon, an AI orchestrator for Agent Work Orders. Your capabilities:

  1. INTELLIGENT TASK ANALYSIS
     - Analyze user requests to determine task type (backend, frontend, full-stack, security, etc.)
     - Identify required expertise (Python, React, Security, etc.)
     - Assess complexity and recommend appropriate workflows

  2. TEMPLATE SELECTION
     - Recommend agent templates based on task analysis
     - Suggest single-agent or multi-agent workflows
     - Explain why specific agents/workflows are recommended

  3. WORK ORDER MANAGEMENT
     - Create work orders with custom templates
     - Monitor execution progress
     - Report status updates
     - Facilitate human-in-the-loop reviews (Phase 4)

  4. CONVERSATIONAL GUIDANCE
     - Ask clarifying questions when task is ambiguous
     - Provide recommendations with explanations
     - Confirm before creating work orders
     - Explain what will happen at each step

  Available agent templates: {agent_templates_summary}
  Available workflows: {workflow_templates_summary}
  ```
- TEMPLATE_VARS: {{agent_templates_summary}}, {{workflow_templates_summary}} injected at runtime
- **VALIDATE**: `uv run python -c "from src.agents.orchestrator.prompts import ARCHON_ORCHESTRATOR_SYSTEM_PROMPT; print('✓')"`

### CREATE python/src/agents/orchestrator/task_analyzer.py:

- IMPLEMENT: TaskAnalyzer class
- METHOD: `async analyze_task(user_request: str) -> TaskAnalysis`
- RETURN: TaskAnalysis(task_type, technologies, complexity, security_implications, recommended_agents, recommended_workflow)
- LOGIC:
  - Use simple keyword matching initially (upgrade to LLM analysis later)
  - Backend keywords: "api", "backend", "fastapi", "database", "authentication"
  - Frontend keywords: "ui", "frontend", "react", "component", "form"
  - Security keywords: "auth", "security", "encryption", "validation"
- METHOD: `async recommend_agents(task_analysis: TaskAnalysis) -> dict[str, str]`
- RETURN: {"planning": "agent-slug", "execute": "agent-slug", "review": "agent-slug"}
- METHOD: `async recommend_workflow(task_analysis: TaskAnalysis) -> str`
- RETURN: workflow_template_slug
- **VALIDATE**: `uv run python -c "from src.agents.orchestrator.task_analyzer import TaskAnalyzer; print('✓')"`

### CREATE python/src/agents/orchestrator/tools.py:

- IMPLEMENT: Tool functions decorated with @orchestrator_agent.tool
- TOOL_1: `create_work_order(ctx, repository_url, user_request, workflow_template_slug=None, agent_overrides=None, github_issue_number=None)`
  - If workflow_template_slug is None: Use task analyzer to recommend
  - If agent_overrides is None: Use task analyzer to recommend
  - Create work order via AWO service
  - Return: work_order_id, status, recommended_agents, recommended_workflow
- TOOL_2: `check_work_order_status(ctx, work_order_id)`
  - Get work order details
  - Return: status, current_phase, git_commit_count, git_files_changed, github_pull_request_url, error_message
- TOOL_3: `list_repositories(ctx, search_query=None)`
  - List configured repositories
  - Filter by search_query if provided
  - Return: List of repositories with URLs and display names
- TOOL_4: `list_agent_templates(ctx, category=None, search_query=None)`
  - List agent templates
  - Filter by category (Development, Review, Security, etc.)
  - Filter by search_query (name, description, tags)
  - Return: List of agent templates with name, description, capabilities
- TOOL_5: `pause_workflow(ctx, work_order_id, reason=None)`
  - Pause running workflow (Phase 4 integration)
  - Return: success, pause_state
  - NOTE: Only works if Phase 4 implemented, otherwise return error
- TOOL_6: `resume_workflow(ctx, work_order_id, decision, user_feedback=None)`
  - Resume paused workflow (Phase 4 integration)
  - Decisions: "approve", "revise", "cancel"
  - Return: success, new_status
  - NOTE: Only works if Phase 4 implemented
- TOOL_7: `get_work_order_logs(ctx, work_order_id, limit=50)`
  - Get recent logs for work order
  - Return: List of log entries with timestamps
- CONTEXT: RunContext[OrchestratorDependencies] for dependency access
- PATTERN: Follow AgentAnalysis.md Section 5 tool implementations
- **VALIDATE**: `uv run python -c "from src.agents.orchestrator.tools import create_work_order; print('✓')"`

### CREATE python/src/agents/orchestrator/agent.py:

- IMPLEMENT: `create_orchestrator_agent(model: str, available_agents: list, available_workflows: list) -> Agent`
- AGENT_CONFIG: PydanticAI Agent with system_prompt, deps_type, result_type=str
- SYSTEM_PROMPT: Inject available_agents and available_workflows into prompt template
- REGISTER_TOOLS: Import and register all tools from tools.py
- MODEL_PARAM: Accept model string (openai:gpt-4, google-gen-ai:gemini-1.5-pro, etc.)
- **VALIDATE**: `uv run python -c "from src.agents.orchestrator.agent import create_orchestrator_agent; agent = create_orchestrator_agent('openai:gpt-4', [], []); print('✓')"`

### CREATE python/src/agents/orchestrator/service.py:

- IMPLEMENT: OrchestratorService class (singleton)
- STATE: sessions dict (session_id -> message history)
- STATE: agent_cache dict (model -> Agent instance)
- METHOD: `async chat(message: str, session_id: str | None = None, user_id: str | None = None) -> AgentResponse`
  - Generate session_id if not provided (use nanoid)
  - Get or create agent for configured model
  - Load message history for session
  - Execute agent with message and context
  - Update message history
  - Return: response text, session_id, tool_calls, work_orders
- METHOD: `async _create_dependencies(user_id: str) -> OrchestratorDependencies`
  - Create AWO service wrapper
  - Create template service wrapper
  - Create repository service wrapper
  - Return OrchestratorDependencies
- AGENT_INIT: Lazy initialize agent with configured model from settings
- MODEL_CONFIG: Call get_configured_model() to respect Archon settings
- PATTERN: Follow AgentAnalysis.md Section 7 OrchestratorService
- **VALIDATE**: `uv run python -c "from src.agents.orchestrator.service import OrchestratorService; print('✓')"`

### CREATE python/src/agents/orchestrator/model_config.py:

- IMPLEMENT: `async get_configured_model() -> str`
- INTEGRATION: Import credential_service from server.services.credential_service
- PROVIDER_MAPPING:
  ```python
  {
    "openai": "openai:{model}",
    "gemini": "google-gen-ai:{model}",
    "ollama": "ollama:{model}"
  }
  ```
- API_KEY_SETUP: Set environment variables for PydanticAI
  - OPENAI_API_KEY from credentials
  - GEMINI_API_KEY from credentials
  - Ollama uses local endpoint (no key)
- DEFAULT: Fallback to openai:gpt-4-turbo if not configured
- MODEL_SELECTION: Get from settings (MODEL_CHOICE)
- **VALIDATE**: `uv run python -c "from src.agents.orchestrator.model_config import get_configured_model; print('✓')"`

### CREATE python/src/server/api_routes/orchestrator_api.py:

- IMPLEMENT: FastAPI router for orchestrator endpoints
- POST: `/api/orchestrator/chat` - Send message to orchestrator
- REQUEST: ChatRequest(message: str, session_id: str | None, user_id: str | None)
- RESPONSE: ChatResponse(response: str, session_id: str, tool_calls: list[dict], work_orders: list[dict])
- SERVICE: Use orchestrator_service.chat()
- ERROR_HANDLING: Catch agent execution errors, return clear error messages
- PATTERN: Follow existing api_routes patterns
- **VALIDATE**: `uv run python -c "from src.server.api_routes.orchestrator_api import router; print('✓')"`

### UPDATE python/src/server/main.py:

- IMPORT: from .api_routes.orchestrator_api import router as orchestrator_router
- FIND: app.include_router() calls
- ADD: `app.include_router(orchestrator_router)` (after agent_chat_router)
- **VALIDATE**: `grep -q "orchestrator_router" python/src/server/main.py && echo "✓"`

### UPDATE archon-ui-main/src/features/agent-work-orders/state/agentWorkOrdersStore.ts:

**ADD NEW SLICE**: `slices/orchestratorSlice.ts`

**Client UI State** (Zustand - follows `PRPs/ai_docs/ZUSTAND_STATE_MANAGEMENT.md`):
```typescript
export interface OrchestratorSlice {
  // Chat panel state
  isChatPanelOpen: boolean;
  openChatPanel: () => void;
  closeChatPanel: () => void;
  toggleChatPanel: () => void;

  // Session persistence
  sessionId: string | null;
  setSessionId: (id: string) => void;
  clearSession: () => void;

  // Chat input draft (persisted)
  chatInputDraft: string;
  setChatInputDraft: (draft: string) => void;
}
```

**Update Store Type**:
```typescript
export type AgentWorkOrdersStore = UIPreferencesSlice & ModalsSlice & FiltersSlice & SSESlice & OrchestratorSlice;
```

**Update Persistence** (partialize):
```typescript
sessionId: state.sessionId,           // PERSIST
chatInputDraft: state.chatInputDraft, // PERSIST
// Do NOT persist: isChatPanelOpen (ephemeral)
```

**Selector Usage in Components**:
```typescript
// ✅ Single value
const isChatPanelOpen = useAgentWorkOrdersStore((s) => s.isChatPanelOpen);
const toggleChatPanel = useAgentWorkOrdersStore((s) => s.toggleChatPanel);

// ✅ Multiple values - use useShallow
import { useShallow } from 'zustand/react/shallow';
const { sessionId, chatInputDraft } = useAgentWorkOrdersStore(
  useShallow((s) => ({ sessionId: s.sessionId, chatInputDraft: s.chatInputDraft }))
);
```

**VALIDATE**: `npx tsc --noEmit`

---

### CREATE archon-ui-main/src/features/orchestrator-chat/types/index.ts:

- DEFINE: ChatMessage interface
  - id: string
  - role: "user" | "assistant"
  - content: string
  - timestamp: string
  - toolCalls?: ToolCall[]
  - workOrders?: WorkOrderSummary[]
- DEFINE: ToolCall interface (name: string, arguments: dict, result?: any)
- DEFINE: WorkOrderSummary interface (agent_work_order_id, repository_url, status, git_branch_name)
- DEFINE: ChatRequest interface (message: string, session_id?: string)
- DEFINE: ChatResponse interface (response: string, session_id: string, tool_calls: ToolCall[], work_orders: WorkOrderSummary[])
- PATTERN: Follow src/features/agent-work-orders/types/index.ts
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/orchestrator-chat/types/index.ts`

### CREATE archon-ui-main/src/features/orchestrator-chat/services/orchestratorService.ts:

- IMPLEMENT: orchestratorService.chat(message: string, sessionId?: string)
- ENDPOINT: POST /api/orchestrator/chat
- RETURN: ChatResponse
- ERROR_HANDLING: Catch network errors, return user-friendly messages
- PATTERN: Follow src/features/agent-work-orders/services/
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/orchestrator-chat/services/orchestratorService.ts`

### CREATE archon-ui-main/src/features/orchestrator-chat/hooks/useOrchestratorChat.ts:

- IMPLEMENT: useOrchestratorChat(sessionId?: string) hook
- STATE: messages: ChatMessage[] (local state, not TanStack Query)
- STATE: isLoading: boolean
- MUTATION: sendMessage mutation using orchestratorService.chat()
- OPTIMISTIC_UPDATE: Add user message immediately to messages array
- ON_SUCCESS: Add assistant response to messages array, extract work orders
- SESSION_PERSISTENCE: Store session_id in localStorage
- PATTERN: Follow FrontendAnalysis.md Section 2 chat hook example
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/orchestrator-chat/hooks/useOrchestratorChat.ts`

### CREATE archon-ui-main/src/features/orchestrator-chat/components/ChatPanel.tsx:

- IMPLEMENT: Main chat container component
- LAYOUT: Flex column - Header, Message list (scrollable), Input area
- HEADER:
  - Title: "Archon Assistant"
  - Subtitle: "Natural language work order management"
  - Close button (X icon)
- MESSAGE_LIST:
  - Map over messages array
  - Render ChatMessage components
  - Auto-scroll to bottom on new message
  - Loading indicator when isLoading
- INPUT_AREA: ChatInput component with send button
- LOADING: Show ToolCallIndicator when mutation pending
- STYLING: Tron glassmorphism, full height flex column, bg-black/80 backdrop-blur
- PATTERN: Follow FrontendAnalysis.md ChatPanel example
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/orchestrator-chat/components/ChatPanel.tsx`

### CREATE archon-ui-main/src/features/orchestrator-chat/components/ChatMessage.tsx:

- IMPLEMENT: Single message display component
- PROPS: message: ChatMessage
- LAYOUT:
  - User messages: Right-aligned, blue gradient background
  - Assistant messages: Left-aligned, dark background
- AVATAR:
  - User: "U" in circle (blue)
  - Assistant: "A" in circle (cyan)
- CONTENT: Render markdown with react-markdown (code blocks, lists, etc.)
- TOOL_CALLS: Show tools used below message
  - Format: "🔧 Used: create_work_order, check_work_order_status"
  - Collapsible section with tool arguments/results
- WORK_ORDERS: Render WorkOrderCard for created work orders
- TIMESTAMP: Show relative time (e.g., "2 minutes ago")
- PATTERN: Follow FrontendAnalysis.md ChatMessage example
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/orchestrator-chat/components/ChatMessage.tsx`

### CREATE archon-ui-main/src/features/orchestrator-chat/components/ChatInput.tsx:

- IMPLEMENT: Message input with send button
- STATE: inputText (local state)
- LAYOUT: Textarea (auto-resize) + Send button
- SUBMIT: Call onSend prop with message, clear input
- KEYBOARD:
  - Send on Enter (if not Shift+Enter)
  - Shift+Enter for newline
- DISABLED: When isLoading prop is true
- PLACEHOLDER: "Ask Archon to create a work order..."
- STYLING: Tron input styling (border-white/10, focus:border-cyan-500)
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/orchestrator-chat/components/ChatInput.tsx`

### CREATE archon-ui-main/src/features/orchestrator-chat/components/WorkOrderCard.tsx:

- IMPLEMENT: Inline work order status card (compact version)
- PROPS: workOrder: WorkOrderSummary
- DISPLAY:
  - Work order ID (truncated)
  - Repository name (extracted from URL)
  - Status badge (color-coded: running=blue, completed=green, failed=red)
  - Git branch name (if available)
  - Current phase indicator
- LINK: Link to /agent-work-orders/{id} for full details
- STYLING: bg-white/5 border border-white/10 rounded-lg compact, hover:bg-white/10
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/orchestrator-chat/components/WorkOrderCard.tsx`

### CREATE archon-ui-main/src/features/orchestrator-chat/components/ToolCallIndicator.tsx:

- IMPLEMENT: Loading indicator for tool execution
- DISPLAY: Animated spinner + "Archon is thinking..." text
- ANIMATION: Pulsing cyan glow effect
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/orchestrator-chat/components/ToolCallIndicator.tsx`

### UPDATE archon-ui-main/src/features/agent-work-orders/views/AgentWorkOrdersView.tsx:

- ADD: State - isChatPanelOpen: boolean (default false)
- ADD: Button - "Chat with Archon" (top right corner, message-circle icon)
- CLICK: Toggle isChatPanelOpen
- CONDITIONAL: Render ChatPanel when isChatPanelOpen
- PANEL_LAYOUT:
  - Desktop: 400px width sidebar, slide in from right
  - Mobile: Full screen overlay
  - Transition: transform 300ms ease-in-out
- **VALIDATE**: `npx tsc --noEmit archon-ui-main/src/features/agent-work-orders/views/AgentWorkOrdersView.tsx`

### ADD python/tests/agents/orchestrator/:

- CREATE: test_task_analyzer.py
  - Test: Backend task detection (keywords: api, backend, fastapi)
  - Test: Frontend task detection (keywords: ui, react, component)
  - Test: Security task detection (keywords: auth, security, encryption)
  - Test: Agent recommendations match task type
  - Test: Workflow recommendations match task complexity
- CREATE: test_tools.py - Test each orchestrator tool
  - Mock: AWOService, TemplateService, RepositoryService
  - Test: create_work_order with task analysis
  - Test: check_work_order_status returns correct data
  - Test: list_repositories filters correctly
  - Test: list_agent_templates filters correctly
  - Test: pause/resume (Phase 4 integration)
- CREATE: test_agent.py - Test agent creation and execution
  - Use PydanticAI TestModel for deterministic testing
  - Test: Agent initializes with correct prompt
  - Test: Tools registered correctly
- CREATE: test_service.py - Test OrchestratorService
  - Test: Session management (create, retrieve)
  - Test: Message history persistence
  - Test: Agent caching (same model = same instance)
- **VALIDATE**: `uv run pytest python/tests/agents/orchestrator/ -v`

### ADD archon-ui-main/src/features/orchestrator-chat/tests/:

- CREATE: ChatPanel.test.tsx - Test chat panel rendering and interaction
  - Test: Panel renders with header, messages, input
  - Test: Send message adds user message
  - Test: Assistant response appears after mutation
  - Test: Work order cards render
- CREATE: useOrchestratorChat.test.ts - Test chat hook
  - Mock: orchestratorService.chat()
  - Test: sendMessage mutation works
  - Test: Optimistic update (user message immediate)
  - Test: Session ID persisted in localStorage
- CREATE: TaskAnalyzer.test.ts - Test task analysis logic
  - Test: Backend keywords detected
  - Test: Frontend keywords detected
  - Test: Correct agents recommended
- LIBRARY: @testing-library/react, vitest
- **VALIDATE**: `npm run test src/features/orchestrator-chat/`

---

## Validation Loop

### Level 1: Syntax & Style

```bash
# Backend
uv run ruff check python/src/agents/orchestrator/ --fix
uv run mypy python/src/agents/orchestrator/
uv run ruff format python/src/agents/orchestrator/

# Frontend
npx tsc --noEmit
npm run biome:fix
```

### Level 2: Unit Tests

```bash
# Backend
uv run pytest python/tests/agents/orchestrator/ -v

# Frontend
npm run test src/features/orchestrator-chat/
```

### Level 3: API Integration - Basic Chat

```bash
# Start all services
docker compose --profile backend up -d
cd archon-ui-main && npm run dev

# Test orchestrator chat via API
curl -X POST http://localhost:8181/api/orchestrator/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "List my repositories", "session_id": null}' | jq .

# Expected response:
{
  "response": "You have the following repositories: ...",
  "session_id": "abc-123",
  "tool_calls": [{"name": "list_repositories", ...}],
  "work_orders": []
}
```

### Level 4: Task Analysis & Agent Recommendation

```bash
# Test intelligent agent selection
curl -X POST http://localhost:8181/api/orchestrator/chat \
  -d '{"message": "I need to add user authentication to my FastAPI backend API"}' | jq .

# Expected response should include:
# - Analysis of task (backend, Python, security)
# - Recommendation: Python Backend Expert + Security Reviewer
# - Suggestion for multi-agent planning workflow
# - Confirmation question before creating work order
```

**Validation**:
- [ ] Task type identified correctly (backend)
- [ ] Technologies detected (Python, FastAPI)
- [ ] Security implications noted (authentication)
- [ ] Appropriate agents recommended
- [ ] Multi-agent workflow suggested
- [ ] Asks for confirmation

### Level 5: Work Order Creation via Chat

```bash
# Multi-turn conversation
# Turn 1: User request
curl -X POST http://localhost:8181/api/orchestrator/chat \
  -d '{"message": "Create a work order to add authentication to github.com/test/api"}' | jq .

# Expected: Orchestrator asks clarifying questions or recommends agents

# Turn 2: User confirms
curl -X POST http://localhost:8181/api/orchestrator/chat \
  -d '{"message": "Yes, use those agents", "session_id": "abc-123"}' | jq .

# Expected response:
{
  "response": "Work order created! ID: wo_xyz. Status: running. I'm using Python Backend Expert for planning and Security Reviewer for review...",
  "session_id": "abc-123",
  "tool_calls": [{"name": "create_work_order", "result": {...}}],
  "work_orders": [{
    "agent_work_order_id": "wo_xyz",
    "repository_url": "github.com/test/api",
    "status": "running",
    "git_branch_name": "awo-wo_xyz-..."
  }]
}
```

**Validation**:
- [ ] Work order created
- [ ] Correct repository
- [ ] Template-based execution enabled (Phase 3A flag)
- [ ] Work order ID returned in response
- [ ] Work order object included in work_orders array

### Level 6: UI Integration - Chat Panel

```
1. Navigate to http://localhost:3737/agent-work-orders
2. Click "Chat with Archon" button (top right)
3. Chat panel slides in from right (400px width)
4. Panel shows: Header, empty message list, input field
5. Type: "What repositories do I have?"
6. Press Enter
7. User message appears (right-aligned, blue)
8. Loading indicator: "Archon is thinking..."
9. Assistant response appears (left-aligned, dark)
10. Response lists repositories
11. Tool call indicator: "🔧 Used: list_repositories"
```

**Validation**:
- [ ] Chat panel toggle works
- [ ] Panel slides in smoothly
- [ ] Messages send and receive
- [ ] User messages right-aligned
- [ ] Assistant messages left-aligned
- [ ] Tool calls visible
- [ ] Loading indicator shows

### Level 7: Multi-Turn Conversation with Work Order Creation

```
User: "I need to add authentication"
Assistant: "I can help with that! Which repository would you like to add authentication to?"

User: "github.com/user/backend-api"
Assistant: "Great! I recommend using:
- Planning: Multi-agent workflow (Python Expert + Security Reviewer + Architect)
- Execute: Python Backend Expert
- Review: Security Reviewer

This will ensure your authentication implementation is secure. Should I proceed with these agents?"

User: "Yes, sounds good"
Assistant: "Perfect! I'm creating a work order now..."
[Tool call: create_work_order]
Assistant: "Work order created!
- ID: wo_abc123
- Status: Running
- Branch: awo-abc123-auth-feature
- Current phase: Planning

I'll monitor progress and notify you when the plan is ready for review."

[WorkOrderCard component appears below message]

User: "Show me the status"
Assistant: "Let me check..."
[Tool call: check_work_order_status]
Assistant: "Work order wo_abc123 is currently in the planning phase. The multi-agent planning step is executing:
- Sub-step 1: Requirements Analysis (Python Expert) - Completed ✓
- Sub-step 2: Security Review (Security Expert) - In progress...
- Sub-step 3: Plan Synthesis (Architect) - Pending

I'll let you know when planning is complete and ready for your review."
```

**Validation**:
- [ ] Context maintained across turns
- [ ] Clarifying questions asked
- [ ] Recommendations provided with explanations
- [ ] User confirmation requested
- [ ] Work order created after confirmation
- [ ] Work order card renders in chat
- [ ] Status monitoring works
- [ ] Sub-step progress visible

### Level 8: Integration with Phase 3A (Template Execution)

```bash
# Verify work order created by orchestrator uses templates

# Get work order ID from orchestrator response
WO_ID="wo_abc123"

# Check logs
curl -N http://localhost:8053/api/agent-work-orders/$WO_ID/logs/stream | grep "template\|sub_step"

# EXPECTED OUTPUT:
✅ "Resolved workflow: advanced-backend-workflow"
✅ "Using step template: multi-agent-planning"
✅ "Executing sub-step 1/3: Requirements Analysis"
✅ "Agent: python-backend-expert"
✅ "Executing sub-step 2/3: Security Review"
✅ "Agent: security-expert"
✅ "Executing sub-step 3/3: Plan Synthesis"
❌ NO "Loading command from: .claude/commands" (should use templates)
```

**Validation**:
- [ ] Work order uses template execution (not hardcoded)
- [ ] Multi-agent planning workflow executes
- [ ] Sub-steps run in correct order
- [ ] Correct agents assigned to sub-steps
- [ ] Orchestrator's recommendations applied

---

## COMPLETION CHECKLIST

- [ ] PydanticAI agent module structure created
- [ ] OrchestratorDependencies dataclass implemented
- [ ] System prompt defined with template variables
- [ ] TaskAnalyzer implemented with keyword matching
- [ ] All 7 orchestrator tools implemented
- [ ] Tool: create_work_order with task analysis
- [ ] Tool: check_work_order_status
- [ ] Tool: list_repositories
- [ ] Tool: list_agent_templates
- [ ] Tool: pause_workflow (Phase 4 integration)
- [ ] Tool: resume_workflow (Phase 4 integration)
- [ ] Tool: get_work_order_logs
- [ ] Agent creation function implemented
- [ ] Model configuration from Archon settings working
- [ ] OrchestratorService with session management implemented
- [ ] Orchestrator API endpoint created and registered
- [ ] ChatPanel component created
- [ ] ChatMessage component created (with markdown, tool calls, work orders)
- [ ] ChatInput component created
- [ ] WorkOrderCard component created
- [ ] ToolCallIndicator component created
- [ ] useOrchestratorChat hook implemented
- [ ] Chat panel integrated into AWO page
- [ ] All backend tests pass
- [ ] All frontend tests pass
- [ ] Task analysis tests pass
- [ ] No ruff/mypy/TypeScript errors
- [ ] Integration test via API works
- [ ] Multi-turn conversation works
- [ ] Work order creation via chat works
- [ ] Template-based execution used
- [ ] Intelligent agent selection works

---

## Notes

**Phase 3B Scope:**
- **IN SCOPE**: Conversational interface, intelligent agent selection, work order creation via chat
- **REQUIRES**: Phase 3A (template execution must work)
- **INTEGRATES**: Phase 4 (pause/resume tools for HITL)

**Model Configuration:**
- Orchestrator uses model from Archon settings (Settings page)
- Supports: OpenAI (GPT-4, GPT-3.5), Gemini (1.5 Pro/Flash), Ollama (local models)
- Work orders still use CLI adapters (Claude/Gemini CLI from Phase 5)
- Orchestrator model ≠ work order execution CLI

**Task Analysis Intelligence:**
- **Phase 3B**: Simple keyword matching
- **Future**: LLM-based analysis (use orchestrator's own model to analyze tasks)
- **Upgrade path**: Replace TaskAnalyzer with LLM chain

**Session Management:**
- Session ID persists conversation context
- Frontend stores session_id in localStorage (per-user sessions)
- Backend maintains message history per session (in-memory or Redis future)
- Sessions expire after 24 hours of inactivity

**Tool Integration:**
- Tools call AWO service methods (create work order, get status, pause, resume)
- Tools format responses in markdown for chat display
- Work order IDs embedded in responses as WorkOrderCard components
- Tool calls visible to user (transparency about what Archon is doing)

**Agent Selection Priority:**
1. Task analysis (keywords, complexity assessment)
2. User preferences (if configured in repository)
3. Template defaults (from Phase 1 seed data)
4. Fallback: "python-backend-expert" for generic tasks

**Dependencies:**
- Requires Phase 1 (template APIs for list_agent_templates tool)
- Requires Phase 2 (templates configured in UI)
- Requires Phase 3A (template execution for work orders)
- Integrates Phase 4 (pause/resume tools - graceful degradation if not available)
- Works with Phase 5 (CLI adapters - orchestrator doesn't care which CLI)

**Future Enhancements:**
- Streaming responses (PydanticAI supports streaming)
- Rich formatting (code blocks, tables, charts)
- Inline work order status updates (WebSocket integration)
- Multi-turn clarification dialogs (disambiguation)
- Context-aware recommendations (learn from past work orders)
- Voice interface (speech-to-text integration)

**Performance Considerations:**
- Agent initialization: ~500ms first call, cached after
- Task analysis: < 100ms (keyword matching)
- LLM call (orchestrator): 1-3 seconds depending on model
- Tool execution: Variable (create_work_order ~2s, check_status ~100ms)
- Total response time: 2-5 seconds typical

<!-- EOF -->
