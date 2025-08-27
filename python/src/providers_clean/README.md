# Clean Provider Integration for PydanticAI

A simplified approach to managing AI providers that leverages PydanticAI's native model handling.

## Philosophy

Instead of building custom provider clients and abstraction layers, this implementation:
- Uses PydanticAI's native support for OpenAI, Anthropic, Google, etc.
- Provides simple configuration management
- Tracks usage and costs
- Manages API keys securely

## Structure

```
providers_clean/
├── migrations/          # Database migrations
│   └── 001_simplified_schema.sql
├── services/           # Core services
│   ├── model_config.py     # Model configuration management
│   ├── api_key_manager.py  # API key storage and retrieval
│   └── usage_tracker.py    # Usage and cost tracking
├── api/               # API endpoints (to be implemented)
├── models/            # Pydantic models (if needed)
└── tests/             # Test suite
```

## Quick Start

### 1. Run Migration

```sql
-- Run the migration to create tables
psql $DATABASE_URL < migrations/001_simplified_schema.sql
```

### 2. Set Encryption Key

```python
from providers_clean.services import APIKeyManager

# Generate a new encryption key
key = APIKeyManager.generate_encryption_key()
print(f"Add to .env: ARCHON_ENCRYPTION_KEY={key}")
```

### 3. Configure API Keys

```python
from supabase import create_client
from providers_clean.services import APIKeyManager

# Initialize
supabase = create_client(url, key)
key_manager = APIKeyManager(supabase)

# Store API keys
await key_manager.set_api_key('openai', 'sk-...')
await key_manager.set_api_key('anthropic', 'sk-ant-...')

# Set up environment for PydanticAI
await key_manager.setup_environment()
```

### 4. Configure Models

```python
from providers_clean.services import ModelConfigService

# Initialize
config_service = ModelConfigService(supabase)

# Set model for a service
await config_service.set_model_config(
    'rag_agent',
    'anthropic:claude-3-opus-20240229'
)

# Get all configurations
configs = await config_service.get_all_configs()
# {'rag_agent': 'anthropic:claude-3-opus-20240229', ...}
```

### 5. Use with PydanticAI Agents

```python
from pydantic_ai import Agent
from providers_clean.services import ModelConfigService, APIKeyManager

# Setup (run once at startup)
key_manager = APIKeyManager(supabase)
await key_manager.setup_environment()  # Sets env vars

config_service = ModelConfigService(supabase)
configs = await config_service.get_all_configs()

# Create agents with configured models
rag_agent = Agent(
    model=configs['rag_agent'],  # e.g., 'openai:gpt-4o'
    # ... other agent config
)
```

### 6. Track Usage

```python
from providers_clean.services import UsageTracker

tracker = UsageTracker(supabase)

# Track usage after each call
await tracker.track_usage(
    service_name='rag_agent',
    model_string='openai:gpt-4o',
    input_tokens=500,
    output_tokens=200
)

# Get usage summary
summary = await tracker.get_usage_summary()
print(f"Total cost: ${summary.total_cost}")
```

## Database Schema

### Tables

1. **model_config** - Stores model selection per service
   - service_name (unique)
   - model_string (e.g., 'openai:gpt-4o')
   - temperature, max_tokens

2. **api_keys** - Encrypted API key storage
   - provider (unique)
   - encrypted_key
   - base_url (optional)
   - is_active

3. **model_usage** - Usage and cost tracking
   - service_name, model_string
   - request_count, total_tokens
   - estimated_cost
   - period_start, period_end

## Supported Providers

All providers supported by PydanticAI:
- OpenAI (gpt-4o, gpt-3.5-turbo, etc.)
- Anthropic (claude-3-opus, claude-3-sonnet, etc.)
- Google/Gemini (gemini-1.5-pro, gemini-1.5-flash)
- Groq (llama, mixtral)
- Mistral (mistral-large, mistral-medium)
- Ollama (local models)
- Cohere (command-r-plus, command-r)

## Cost Tracking

The system includes built-in cost tables for all major models. Usage is tracked automatically and costs are calculated based on token usage.

## Security

- API keys are encrypted using Fernet symmetric encryption
- Encryption key should be stored securely (environment variable)
- Row-level security can be enabled on api_keys table

## Testing

Run tests with pytest:

```bash
cd python
pytest src/providers_clean/tests/ -v
```

## Migration from Old System

If migrating from the complex provider system:

1. Export any API keys from old system
2. Run the migration (it drops old tables)
3. Re-enter API keys using new system
4. Update agent initialization code
5. Remove old provider code

## Benefits

- **Simple**: ~500 lines of code vs thousands
- **Native**: Uses PydanticAI's built-in provider support
- **Fast**: No abstraction overhead
- **Maintainable**: Clear separation of concerns
- **Flexible**: Easy to extend or modify

## Next Steps

1. Implement API endpoints for UI management
2. Add frontend components for provider configuration
3. Create usage dashboard
4. Add cost alerts and budgets
5. Implement model recommendation engine