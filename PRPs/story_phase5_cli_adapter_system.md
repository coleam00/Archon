---
name: "Phase 5: AWO CLI Adapter System"
description: "Generic CLI adapter plugin architecture for multi-provider support (Claude, Gemini, Codex) - Provider switching only"
phase: 5
dependencies: ["Phase 1", "Phase 2", "Phase 3A"]
breaking_changes: false
---

## Original Story

```
Create a generic CLI adapter system for Agent Work Orders that supports multiple AI coding CLIs (Claude Code, Gemini CLI, Codex CLI, and future tools).

Current limitation: AWO only supports Claude Code CLI with hardcoded subprocess calls in agent_cli_executor.py. Cannot use alternative CLIs (Gemini, Codex, etc.).

Goal: Enable users to execute work orders using their preferred AI CLI tool by implementing a plugin-based adapter architecture that:
1. Provides a common interface for CLI execution
2. Parses CLI-specific output formats (JSONL stream-json) into normalized events
3. Supports provider swapping based on repository configuration or agent template preferences
4. Maintains simplified observability (step-level events only)
5. Enables future CLI additions without core orchestrator changes
```

## Story Metadata

**Story Type**: Enhancement
**Estimated Complexity**: Medium
**Primary Systems Affected**:
- Backend: `python/src/agent_work_orders/agent_executor/`
- Backend: `python/src/agent_work_orders/cli_adapters/` (new module)
- Configuration: Repository and agent template CLI preferences

**Phase Number**: 5
**Dependencies**:
- Phase 1 (Templates for CLI preferences)
- Phase 2 (UI to configure CLI preferences)
- Phase 3A (Template execution system)
**Breaking Changes**: ❌ None (backward compatible - Claude remains default)

---

## SCOPE CLARIFICATION

### This Phase: Provider Switching

**What This Phase Does**:
- Choose Claude **OR** Gemini **OR** Codex per work order
- One CLI executes the entire workflow
- Swap providers via repository configuration or agent template preferences
- All CLIs produce normalized CLIEvent format

**Example**:
```
Repository A: Prefers Claude CLI → Work orders use Claude
Repository B: Prefers Gemini CLI → Work orders use Gemini
Agent Template "Security Expert": Prefers Codex → Overrides repository default
```

### NOT This Phase: Parallel Execution

**What This Phase Does NOT Do**:
- Running Claude **AND** Gemini simultaneously
- Comparing outputs from multiple CLIs side-by-side
- Merging results from parallel branches
- Creating multiple PRs for comparison

**Parallel execution is deferred to Phase 6** (future work - high complexity).

---

## CONTEXT REFERENCES

### Analysis Documents

- `PRPs/ai_docs/orchestrator_analysis/ArchitectureAnalysis.md` - Section 8: "AWO Improvement Recommendations" - CLI adapter pattern design
- `PRPs/ai_docs/orchestrator_analysis/BackendAnalysis.md` - Section 4: "Proposed: Generic CLI Adapter with Simplified Observability" - Implementation details and code examples
- `PRPs/IMPLEMENTATION_TRACKER.md` - Phase 5 checklist and validation gates
- `PRPs/PHASE_DEPENDENCY_DIAGRAM.md` - Visual phase flow

### Existing Patterns

- `python/src/agent_work_orders/agent_executor/agent_cli_executor.py` - Current Claude CLI subprocess wrapper to be refactored
- `python/src/agent_work_orders/workflow_engine/workflow_orchestrator.py` - Uses agent_executor, will use adapters
- `python/src/agent_work_orders/models.py` - Event models (StepExecutionResult, CommandExecutionResult)
- `python/src/agent_work_orders/config.py` - Configuration patterns (CLAUDE_CLI_PATH, etc.)

### External References

- https://github.com/google-gemini/gemini-cli - Gemini CLI documentation, supports --output-format stream-json
- https://docs.claude.com/en/docs/claude-code/sdk/sdk-headless - Claude Code CLI --output-format=stream-json documentation
- https://claudelog.com/faqs/what-is-output-format-in-claude-code/ - Claude CLI output format details

### Backend Patterns

- File: `python/src/server/services/credential_service.py` - Getting configured provider from settings
- Pattern: Service layer with dependency injection
- Testing: `python/tests/agent_work_orders/` - Test structure for AWO components

---

## CLI Adapter Architecture

### Adapter Interface

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import AsyncIterator

@dataclass
class CLIEvent:
    """Normalized event from any CLI"""
    work_order_id: str
    event_type: str  # "step_started", "step_completed", "file_changed", "error_occurred"
    step: str | None = None
    file_path: str | None = None
    error: str | None = None
    metadata: dict = None
    timestamp: datetime = None

class CLIAdapter(ABC):
    """Abstract base class for CLI adapters"""

    @abstractmethod
    async def execute(
        self,
        prompt: str,
        working_dir: str,
        session_id: str | None = None
    ) -> AsyncIterator[CLIEvent]:
        """Execute CLI command and yield normalized events"""
        pass
```

### Provider Selection Priority

```
1. Agent Template Preference (highest priority)
   - If agent.preferred_cli is set, use it

2. Repository Default (medium priority)
   - If repository.preferred_cli is set, use it

3. System Default (lowest priority)
   - Fallback to "claude"
```

### Event Normalization

All CLIs must produce these events:
- `step_started` - Step execution begins
- `step_completed` - Step execution finishes
- `file_changed` - File modified (optional)
- `error_occurred` - Error during execution

---

## IMPLEMENTATION TASKS

### CREATE python/src/agent_work_orders/cli_adapters/__init__.py:

- CREATE: Empty init file for module
- EXPORT: CLIAdapter, CLIEvent, get_cli_adapter
- **VALIDATE**: `test -f python/src/agent_work_orders/cli_adapters/__init__.py && echo "✓"`

### CREATE python/src/agent_work_orders/cli_adapters/base.py:

- IMPLEMENT: CLIAdapter abstract base class with async execute() method
- DEFINE: CLIEvent dataclass
  - FIELDS: work_order_id, event_type, step, file_path, error, metadata, timestamp
  - DEFAULT: timestamp=datetime.now(timezone.utc), metadata={}
- EVENT_TYPES: Constants - STEP_STARTED, STEP_COMPLETED, FILE_CHANGED, ERROR_OCCURRED
- IMPORTS: from abc import ABC, abstractmethod; from dataclasses import dataclass, field; from typing import AsyncIterator; from datetime import datetime, timezone
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.cli_adapters.base import CLIAdapter, CLIEvent; print('✓')"`

### CREATE python/src/agent_work_orders/cli_adapters/claude_adapter.py:

- IMPLEMENT: ClaudeCLIAdapter(CLIAdapter) class
- ATTR: work_order_id (passed in __init__)
- METHOD: async execute(prompt, working_dir, session_id=None) -> AsyncIterator[CLIEvent]
- CLI_COMMAND: Build command list
  ```python
  cmd = [
      config.CLAUDE_CLI_PATH,
      "--output-format=stream-json",
      "--print",
      "--verbose" if config.CLAUDE_CLI_VERBOSE else "",
      "--model", config.CLAUDE_CLI_MODEL,
      "--dangerously-skip-permissions" if config.CLAUDE_CLI_SKIP_PERMISSIONS else "",
  ]
  if session_id:
      cmd.extend(["--continue", "--session-id", session_id])
  cmd.append(prompt)
  ```
- PROCESS: subprocess.Popen with stdout=PIPE, stderr=PIPE
- PARSE_JSONL: Async iteration over stdout lines
  ```python
  async for line in process.stdout:
      try:
          data = json.loads(line)
          event_type = data.get("type")
          if event_type in ["step_started", "file_changed", ...]:
              yield CLIEvent(work_order_id=self.work_order_id, event_type=event_type, ...)
      except json.JSONDecodeError:
          logger.warning("Malformed JSON line", line=line)
          continue
  ```
- SESSION_SUPPORT: Use --continue and --session-id flags if session_id provided
- ERROR_HANDLING: Catch JSONDecodeError, log malformed lines, continue
- PATTERN: Follow python/src/agent_work_orders/agent_executor/agent_cli_executor.py subprocess pattern
- IMPORTS: import asyncio; import json; from pathlib import Path; from ..config import config
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.cli_adapters.claude_adapter import ClaudeCLIAdapter; print('✓')"`

### CREATE python/src/agent_work_orders/cli_adapters/gemini_adapter.py:

- IMPLEMENT: GeminiCLIAdapter(CLIAdapter) class
- METHOD: async execute(prompt, working_dir, session_id=None) -> AsyncIterator[CLIEvent]
- CLI_COMMAND: Build Gemini CLI command
  ```python
  cmd = ["gemini", "-p", prompt, "--output-format", "stream-json"]
  # Gemini CLI may have different flags - check documentation
  ```
- PARSE_JSONL: Similar to Claude adapter, parse Gemini's JSONL format
- NORMALIZE: Convert Gemini CLI output to CLIEvent format
  - Map Gemini event types to standard types
  - Extract file paths from Gemini's format
- FALLBACK: If gemini CLI not installed (shutil.which("gemini") is None)
  - Log warning: "Gemini CLI not found, falling back to Claude"
  - Raise CLINotAvailableError
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.cli_adapters.gemini_adapter import GeminiCLIAdapter; print('✓')"`

### CREATE python/src/agent_work_orders/cli_adapters/codex_adapter.py:

- IMPLEMENT: CodexCLIAdapter(CLIAdapter) class (placeholder for future)
- METHOD: async execute(...) -> AsyncIterator[CLIEvent]
- PLACEHOLDER: Raise NotImplementedError("Codex CLI adapter not yet implemented")
- PURPOSE: Shows extensibility, ready for Codex CLI when available
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.cli_adapters.codex_adapter import CodexCLIAdapter; print('✓')"`

### CREATE python/src/agent_work_orders/cli_adapters/factory.py:

- IMPLEMENT: get_cli_adapter(provider: str, work_order_id: str) -> CLIAdapter
- ADAPTER_REGISTRY:
  ```python
  ADAPTER_REGISTRY = {
      "claude": ClaudeCLIAdapter,
      "gemini": GeminiCLIAdapter,
      "codex": CodexCLIAdapter,
  }
  ```
- LOGIC:
  ```python
  def get_cli_adapter(provider: str, work_order_id: str) -> CLIAdapter:
      adapter_class = ADAPTER_REGISTRY.get(provider)
      if not adapter_class:
          raise ValueError(f"Unsupported CLI provider: {provider}")
      return adapter_class(work_order_id)
  ```
- ERROR_HANDLING: Raise ValueError for unsupported provider
- FALLBACK: If adapter raises CLINotAvailableError, fall back to Claude
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.cli_adapters.factory import get_cli_adapter; adapter = get_cli_adapter('claude', 'test-id'); print('✓')"`

### CREATE python/src/agent_work_orders/cli_adapters/event_parser.py:

- IMPLEMENT: parse_cli_output_stream(process, work_order_id, event_callback)
- ASYNC_ITERATION: async for line in process.stdout
- JSON_PARSING: Try json.loads(), catch JSONDecodeError
- EVENT_EXTRACTION: Extract key events only (not every tool call)
  - Extract: step_started, step_completed, file_changed, error_occurred
  - Skip: Internal tool calls, debug messages, verbose output
- EVENT_CALLBACK: Async function to handle emitted events
  ```python
  async def event_callback(event: CLIEvent):
      # Add to log buffer for SSE streaming
      await log_buffer.add(event)
      # Optionally save to database
  ```
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.cli_adapters.event_parser import parse_cli_output_stream; print('✓')"`

### UPDATE python/src/agent_work_orders/agent_executor/agent_cli_executor.py:

- REFACTOR: Move to use CLI adapters instead of direct subprocess
- ADD_PARAM: execute_command(provider: str = "claude")
- METHOD: Update execute_command() to use adapter.execute()
  ```python
  async def execute_command(self, prompt: str, working_dir: str, provider: str = "claude", session_id: str | None = None):
      adapter = get_cli_adapter(provider, self.work_order_id)

      events = []
      async for event in adapter.execute(prompt, working_dir, session_id):
          events.append(event)
          # Process event (log, emit to SSE, etc.)

      # Aggregate events into CommandExecutionResult
      return self._aggregate_events(events)
  ```
- BACKWARDS_COMPAT: Default provider="claude" maintains existing behavior
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.agent_executor.agent_cli_executor import AgentCLIExecutor; print('✓')"`

### UPDATE python/src/agent_work_orders/services/sub_workflow_orchestrator.py:

- UPDATE: Pass provider to agent_cli_executor.execute_command()
- LOGIC: Get provider from agent template
  ```python
  # In _execute_single_agent_step or _execute_sub_step:
  agent_template = await template_service.get_agent_template(agent_slug)
  provider = agent_template.preferred_cli or repository.preferred_cli or "claude"

  result = await agent_executor.execute_command(
      prompt=rendered_prompt,
      working_dir=working_dir,
      provider=provider,
      session_id=session_id
  )
  ```
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.services.sub_workflow_orchestrator import SubWorkflowOrchestrator; print('✓')"`

### UPDATE python/src/agent_work_orders/models.py:

- UPDATE: AgentTemplate - Add preferred_cli field
  ```python
  class AgentTemplate(BaseModel):
      # ... existing fields ...
      preferred_cli: str = "claude"  # "claude", "gemini", "codex"
      # Agent can override repository default
  ```
- UPDATE: ConfiguredRepository - Add preferred_cli field
  ```python
  class ConfiguredRepository(BaseModel):
      # ... existing fields ...
      preferred_cli: str = "claude"  # Repository default
  ```
- **VALIDATE**: `uv run python -c "from src.agent_work_orders.models import AgentTemplate, ConfiguredRepository; print('✓')"`

### UPDATE migration/alter_agent_templates_for_cli_preference.sql:

- ALTER_TABLE: archon_agent_templates
- ADD_COLUMN: preferred_cli TEXT DEFAULT 'claude'
- COMMENT: "CLI provider preference for this agent: claude, gemini, codex"
- **VALIDATE**: Run in Supabase SQL Editor, verify column added

### UPDATE migration/alter_configured_repositories_for_cli_preference.sql:

- ALTER_TABLE: archon_configured_repositories
- ADD_COLUMN: preferred_cli TEXT DEFAULT 'claude'
- COMMENT: "Default CLI provider for work orders in this repository"
- **VALIDATE**: Run in Supabase SQL Editor, verify column added

### ADD python/tests/agent_work_orders/cli_adapters/:

- CREATE: test_claude_adapter.py
  - Test: Claude CLI command construction
  - Test: JSONL parsing from mocked stdout
  - Test: CLIEvent generation
  - Test: Session ID support (--continue flag)
  - Mock: subprocess.Popen
  - Simulate: stream-json output from Claude CLI
- CREATE: test_gemini_adapter.py
  - Test: Gemini CLI command construction
  - Test: JSONL parsing
  - Test: Event normalization (Gemini → CLIEvent)
  - Mock: subprocess.Popen
- CREATE: test_codex_adapter.py
  - Test: NotImplementedError raised (placeholder)
- CREATE: test_factory.py
  - Test: Adapter selection for each provider
  - Test: ValueError for unsupported provider
  - Test: Correct adapter class returned
- CREATE: test_event_parser.py
  - Test: Event extraction from JSONL stream
  - Test: Malformed JSON handling (skip and continue)
  - Test: Event callback invocation
- MOCK: Mock subprocess.Popen for CLI simulation
- TEST_EVENTS: Verify CLIEvent normalization
- **VALIDATE**: `uv run pytest python/tests/agent_work_orders/cli_adapters/ -v`

---

## Validation Loop

### Level 1: Syntax & Style

```bash
uv run ruff check python/src/agent_work_orders/cli_adapters/ --fix
uv run mypy python/src/agent_work_orders/cli_adapters/
uv run ruff format python/src/agent_work_orders/cli_adapters/
```

### Level 2: Unit Tests

```bash
uv run pytest python/tests/agent_work_orders/cli_adapters/ -v
```

**Expected**:
- [ ] All Claude adapter tests pass
- [ ] All Gemini adapter tests pass (with mocks)
- [ ] Factory tests pass
- [ ] Event parser tests pass

### Level 3: Claude Adapter Integration (Backward Compatibility)

```bash
# Start AWO service
uv run python -m uvicorn src.agent_work_orders.server:app --port 8053 --reload &

# Create work order with default settings (should use Claude)
WO_ID=$(curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -H "Content-Type: application/json" \
  -d '{
    "repository_url": "https://github.com/test/repo",
    "user_request": "Test adapter system",
    "sandbox_type": "git_worktree"
  }' | jq -r '.agent_work_order_id')

# Monitor logs - should see Claude CLI being used
curl -N http://localhost:8053/api/agent-work-orders/$WO_ID/logs/stream | grep -E "claude|CLI"

# EXPECTED OUTPUT:
✅ "Using CLI adapter: claude"
✅ "Executing: claude --output-format=stream-json ..."
✅ CLIEvent: step_started, step_completed events
❌ NO errors about adapters
❌ NO fallback warnings

# Verify workflow completes
sleep 120
curl http://localhost:8053/api/agent-work-orders/$WO_ID | jq '.status'

# EXPECTED: status="completed"
```

**Validation**:
- [ ] Work order executes with Claude adapter
- [ ] Logs show adapter usage
- [ ] Events normalized correctly
- [ ] Workflow completes successfully
- [ ] Backward compatible with pre-Phase 5 behavior

### Level 4: Switch Repository to Gemini

```bash
# Update repository configuration
REPO_ID=$(curl http://localhost:8053/api/agent-work-orders/repositories | jq -r '.[0].id')

curl -X PUT http://localhost:8053/api/agent-work-orders/repositories/$REPO_ID \
  -d '{"preferred_cli": "gemini"}' | jq .

# EXPECTED: Repository updated with preferred_cli="gemini"

# Create work order (should use Gemini now)
WO_ID=$(curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{
    "repository_url": "https://github.com/test/repo",
    "user_request": "Test Gemini adapter",
    "sandbox_type": "git_worktree"
  }' | jq -r '.agent_work_order_id')

# Monitor logs - should see Gemini CLI being used
curl -N http://localhost:8053/api/agent-work-orders/$WO_ID/logs/stream | grep -E "gemini|CLI"

# EXPECTED OUTPUT:
✅ "Using CLI adapter: gemini"
✅ "Executing: gemini -p ... --output-format stream-json"
✅ CLIEvent: step_started, step_completed events
❌ If Gemini not installed: "Gemini CLI not found, falling back to Claude"

# Verify workflow completes
sleep 120
curl http://localhost:8053/api/agent-work-orders/$WO_ID | jq '.status'

# EXPECTED: status="completed"
```

**Validation**:
- [ ] Repository configuration updates
- [ ] Work order uses Gemini CLI (or falls back gracefully)
- [ ] Event normalization works
- [ ] Workflow completes successfully

### Level 5: Agent Template Override

```bash
# Update agent template to prefer Codex (future CLI)
curl -X PUT http://localhost:8053/api/agent-work-orders/templates/agents/python-backend-expert \
  -d '{"preferred_cli": "codex"}' | jq .

# Repository still prefers Gemini (from Level 4)

# Create work order that uses python-backend-expert
# Should use Codex (agent overrides repository)
WO_ID=$(curl -X POST ...)

# Monitor logs
curl -N .../$WO_ID/logs/stream | grep "CLI"

# EXPECTED (if Codex not implemented):
✅ "Agent template prefers: codex"
✅ "Codex CLI not available, using repository default: gemini"
OR
✅ "Using CLI adapter: codex" (if Codex implemented)

# Verify priority: Agent > Repository > Default
```

**Validation**:
- [ ] Agent template CLI preference saved
- [ ] Overrides repository default
- [ ] Fallback chain works (Codex → Gemini → Claude)
- [ ] Workflow uses correct CLI based on priority

### Level 6: Event Normalization Comparison

```bash
# Test 1: Execute with Claude
curl -X PUT .../repositories/$REPO_ID -d '{"preferred_cli": "claude"}'
WO1=$(curl -X POST ...)
# Capture CLIEvents from logs

# Test 2: Execute with Gemini (if installed)
curl -X PUT .../repositories/$REPO_ID -d '{"preferred_cli": "gemini"}'
WO2=$(curl -X POST ...)
# Capture CLIEvents from logs

# Compare event structures
curl .../$WO1/logs | jq '.[] | select(.event_type)' > claude_events.json
curl .../$WO2/logs | jq '.[] | select(.event_type)' > gemini_events.json

# Verify both have same event types
cat claude_events.json | jq '.event_type' | sort | uniq
cat gemini_events.json | jq '.event_type' | sort | uniq

# EXPECTED: Both output same event types (step_started, step_completed, file_changed, error_occurred)
```

**Validation**:
- [ ] Both CLIs produce CLIEvents
- [ ] Event types match (normalized)
- [ ] Metadata fields populated
- [ ] Log buffer receives events
- [ ] Frontend can consume both identically

### Level 7: Multi-Agent Sub-Workflow with Mixed CLIs

```bash
# Advanced test: Sub-workflow with different CLIs per sub-step

# Create step template with mixed CLI preferences
curl -X POST .../templates/steps \
  -d '{
    "name": "Cross-Platform Planning",
    "slug": "cross-platform-planning",
    "step_type": "planning",
    "sub_steps": [
      {
        "order": 1,
        "name": "Claude Analysis",
        "agent_template_slug": "claude-expert",  # Agent prefers Claude
        "prompt_template": "Analyze with Claude"
      },
      {
        "order": 2,
        "name": "Gemini Analysis",
        "agent_template_slug": "gemini-expert",  # Agent prefers Gemini
        "prompt_template": "Analyze with Gemini"
      }
    ]
  }'

# Create work order
WO_ID=$(curl -X POST ...)

# Monitor logs - should see both CLIs used
curl -N .../$WO_ID/logs/stream | grep "CLI"

# EXPECTED:
✅ "Sub-step 1: Using CLI adapter: claude"
✅ "Sub-step 2: Using CLI adapter: gemini"
✅ Both sub-steps complete successfully
✅ Outputs aggregated

# Verify completion
curl .../$WO_ID | jq '.status, .git_commit_count'

# EXPECTED: status="completed", commits>0
```

**Validation**:
- [ ] Sub-workflow uses different CLIs per sub-step
- [ ] Agent template preferences respected
- [ ] Both CLIs execute successfully
- [ ] Outputs aggregate correctly
- [ ] No conflicts between CLIs

### Level 8: Error Handling - Unsupported Provider

```bash
# Test 1: Unsupported provider
curl -X PUT .../repositories/$REPO_ID -d '{"preferred_cli": "invalid-cli"}' | jq .

# EXPECTED: 400 Bad Request or validation error

# Test 2: Provider not installed (Gemini CLI missing)
curl -X PUT .../repositories/$REPO_ID -d '{"preferred_cli": "gemini"}'
WO_ID=$(curl -X POST ...)

# Monitor logs
curl -N .../$WO_ID/logs/stream | grep "fallback\|not found"

# EXPECTED:
✅ "Gemini CLI not found at path: gemini"
✅ "Falling back to Claude CLI"
✅ "Using CLI adapter: claude"
✅ Workflow completes successfully (fallback works)

# Test 3: Malformed CLI output
# Simulate corrupted JSONL from CLI
# Expected: Skip malformed lines, log warning, continue processing
```

**Validation**:
- [ ] Invalid providers rejected
- [ ] Missing CLI binaries handled gracefully
- [ ] Fallback to Claude works
- [ ] Malformed output doesn't crash workflow
- [ ] Clear error messages in logs

### Level 9: UI Integration - CLI Preference Selector

```
1. Navigate to http://localhost:3737/context-hub
2. Go to "Repository Config" tab
3. Select repository from dropdown
4. See "Preferences" section
5. Field: "Preferred CLI Provider"
6. Options: Claude (default), Gemini, Codex
7. Select "Gemini"
8. Click Save
9. Success toast: "Repository configuration saved"
10. Create new work order for this repository
11. Work order detail page → Logs
12. Verify logs show: "Using CLI adapter: gemini"
```

**Validation**:
- [ ] CLI preference selector renders
- [ ] Options populated (Claude, Gemini, Codex)
- [ ] Save updates repository
- [ ] New work orders use selected CLI
- [ ] UI reflects current preference

---

## COMPLETION CHECKLIST

- [ ] All CLI adapter files created
- [ ] CLIAdapter abstract base class implemented
- [ ] CLIEvent dataclass defined
- [ ] Claude adapter parses stream-json correctly
- [ ] Gemini adapter parses stream-json correctly
- [ ] Codex adapter placeholder created
- [ ] Adapter factory selects correct adapter
- [ ] Event parser extracts simplified events
- [ ] AgentCLIExecutor refactored to use adapters
- [ ] SubWorkflowOrchestrator uses provider parameter
- [ ] AgentTemplate has preferred_cli field
- [ ] ConfiguredRepository has preferred_cli field
- [ ] Database migrations for CLI preferences run
- [ ] Provider selection priority logic implemented (Agent > Repository > Default)
- [ ] Fallback chain works (unavailable → next priority → Claude)
- [ ] Unit tests pass for all adapters
- [ ] Integration test with Claude works (backward compat)
- [ ] Integration test with Gemini works (if installed)
- [ ] Mixed CLI sub-workflow works
- [ ] Error handling works (unsupported provider, missing binary, malformed output)
- [ ] No ruff/mypy errors
- [ ] Existing work orders still function
- [ ] UI for CLI preference selection implemented

---

## Notes

**Phase 5 Scope:**
- **IN SCOPE**: Provider switching (one CLI per work order), adapter architecture, event normalization
- **OUT OF SCOPE**: Parallel execution (multiple CLIs simultaneously), result comparison, merging
- **CRITICAL**: Backward compatible - Claude remains default, existing work orders unaffected

**Provider Selection Flow:**
```
1. Check agent_template.preferred_cli (highest priority)
   ↓ If None
2. Check repository.preferred_cli (medium priority)
   ↓ If None
3. Use "claude" (default)
```

**Fallback Chain:**
```
1. Try preferred CLI
   ↓ If CLINotAvailableError
2. Try repository default
   ↓ If CLINotAvailableError
3. Fall back to Claude (always installed)
```

**Dependencies:**
- Claude Code CLI: Required (already installed)
- Gemini CLI: Optional (graceful fallback if missing)
- Codex CLI: Not yet available (placeholder adapter)

**Backwards Compatibility:**
- Existing work orders continue to work (Claude is default)
- No database migration needed for existing work orders
- Repository.preferred_cli defaults to "claude"
- Agent.preferred_cli defaults to "claude"
- No frontend changes required (CLI preference optional in UI)

**Future Extensibility:**
- Easy to add CursorCLIAdapter, AiderCLIAdapter, etc.
- Plugin architecture makes new CLIs simple to add
- Just implement CLIAdapter interface + add to ADAPTER_REGISTRY
- No orchestrator changes needed

**Event Normalization Benefits:**
- Frontend consumes same event structure regardless of CLI
- Log buffer doesn't care which CLI was used
- SSE streaming works identically
- Analytics/metrics CLI-agnostic

**Performance Considerations:**
- Adapter overhead: < 10ms per command
- JSONL parsing: Streaming (low memory)
- Event extraction: O(n) where n = output lines (typical: 100-1000 lines)
- No performance impact from provider switching

**Integration with Other Phases:**
- Phase 1: preferred_cli stored in templates
- Phase 2: UI to configure CLI preferences
- Phase 3A: Template execution works with any CLI
- Phase 3B: Orchestrator recommendations include CLI suggestions
- Phase 4: Pause/resume independent of CLI choice
- Phase 6: Foundation for parallel execution (future)

**CLI-Specific Notes:**

**Claude CLI**:
- Most mature integration
- --output-format=stream-json fully supported
- Session management via --session-id
- All event types available

**Gemini CLI**:
- Newer, less documentation
- Assume stream-json similar to Claude
- May need custom event mapping
- Test thoroughly with mocks

**Codex CLI**:
- Not yet available publicly
- Placeholder adapter for future
- Shows extensibility of system

<!-- EOF -->
