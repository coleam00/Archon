# Bug Report: Pydantic AI API Incompatibility

## Summary
The Archon codebase uses an outdated API for initializing `OpenAIModel` from `pydantic-ai`. This causes a `TypeError` when running with newer versions of the library.

## Error Message
```
TypeError: OpenAIChatModel.__init__() got an unexpected keyword argument 'base_url'
```

## Affected Files
- `archon/pydantic_ai_coder.py`
- `archon/advisor_agent.py`
- `archon/archon_graph.py`
- `archon/refiner_agents/prompt_refiner_agent.py`
- `archon/refiner_agents/tools_refiner_agent.py`
- `archon/refiner_agents/agent_refiner_agent.py`

## Root Cause
The `pydantic-ai` library changed its API between versions:

- **requirements.txt specifies**: `pydantic-ai==0.0.22`
- **Current installed version**: `pydantic-ai==1.0.15`

### Old API (v0.0.22)
```python
from pydantic_ai.models.openai import OpenAIModel

model = OpenAIModel(model_name, base_url=base_url, api_key=api_key)
```

### New API (v1.0.x)
```python
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider

model = OpenAIModel(model_name, provider=OpenAIProvider(base_url=base_url, api_key=api_key))
```

## Fix Applied
1. Added import for `OpenAIProvider`:
   ```python
   from pydantic_ai.providers.openai import OpenAIProvider
   ```

2. Changed model initialization pattern:
   ```python
   # Before
   model = AnthropicModel(llm, api_key=api_key) if provider == "Anthropic" else OpenAIModel(llm, base_url=base_url, api_key=api_key)

   # After
   model = AnthropicModel(llm, api_key=api_key) if provider == "Anthropic" else OpenAIModel(llm, provider=OpenAIProvider(base_url=base_url, api_key=api_key))
   ```

## Recommendations

### Option 1: Update requirements.txt
Update `requirements.txt` to specify the newer pydantic-ai version:
```
pydantic-ai>=1.0.0
```

### Option 2: Pin to old version
If backwards compatibility is required, ensure Docker builds and local environments use the pinned version:
```
pydantic-ai==0.0.22
```

### Option 3: Support both versions
Add version detection to support both old and new APIs (not recommended due to added complexity).

## Environment Details
- **Date Discovered**: 2025-11-30
- **Python Version**: 3.x
- **OS**: Windows 10/11
- **Discovery Context**: During Database Layer Refactoring project on branch `refactor/db-layer`

## Notes
- The existing Docker image likely worked because it had the old pydantic-ai version frozen at build time
- The bug affects anyone installing dependencies fresh with a newer pip resolver
- The `agent-resources/examples/pydantic_mcp_agent.py` file already uses the correct new API pattern, suggesting this was a known issue
