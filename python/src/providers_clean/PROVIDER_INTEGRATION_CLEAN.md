# Clean Provider + PydanticAI Integration Plan

## Core Principle
Build directly on PydanticAI's native model handling. No custom provider clients, no parallel systems. Just configuration management and model selection.

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   UI Settings   │────▶│  Model Config    │────▶│  PydanticAI     │
│  (Provider/Model│     │    Service       │     │    Agents       │
│    Selection)   │     │                  │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │                          │
                               ▼                          ▼
                        ┌──────────────────┐     ┌─────────────────┐
                        │    Database      │     │   Native LLM    │
                        │  (Simple Config) │     │   Providers     │
                        └──────────────────┘     └─────────────────┘
```

## Simplified Database Schema

```sql
-- Single table for model configuration
CREATE TABLE model_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Service identification
    service_name TEXT NOT NULL UNIQUE, -- 'rag_agent', 'document_agent', 'embeddings'
    
    -- PydanticAI model string
    model_string TEXT NOT NULL, -- 'openai:gpt-4o', 'anthropic:claude-3-opus'
    
    -- Optional overrides
    temperature FLOAT DEFAULT 0.7,
    max_tokens INTEGER,
    
    -- Metadata
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by TEXT
);

-- Single table for API keys (encrypted)
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    provider TEXT NOT NULL UNIQUE, -- 'openai', 'anthropic', 'google'
    encrypted_key TEXT NOT NULL,
    
    -- Optional provider config
    base_url TEXT, -- For Ollama or custom endpoints
    headers JSONB, -- Additional headers if needed
    
    is_active BOOLEAN DEFAULT true,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Simple usage tracking
CREATE TABLE model_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    service_name TEXT NOT NULL,
    model_string TEXT NOT NULL,
    
    -- Usage metrics
    request_count INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    estimated_cost DECIMAL(10, 6),
    
    -- Time window
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    
    -- Index for efficient queries
    PRIMARY KEY (service_name, model_string, period_start)
);
```

## Core Services

### 1. Model Configuration Service

```python
# python/src/services/model_config.py

from typing import Optional, Dict
import os
from pydantic import BaseModel

class ModelConfig(BaseModel):
    """Configuration for a PydanticAI model"""
    service_name: str
    model_string: str  # e.g., "openai:gpt-4o"
    temperature: float = 0.7
    max_tokens: Optional[int] = None

class ModelConfigService:
    """Manages PydanticAI model configuration"""
    
    def __init__(self, supabase_client):
        self.db = supabase_client
    
    async def get_model_config(self, service_name: str) -> ModelConfig:
        """Get model configuration for a service"""
        result = self.db.table('model_config').select('*').eq('service_name', service_name).single().execute()
        
        if not result.data:
            # Return default
            return ModelConfig(
                service_name=service_name,
                model_string=self._get_default_model(service_name)
            )
        
        return ModelConfig(**result.data)
    
    async def set_model_config(self, service_name: str, model_string: str, **kwargs) -> ModelConfig:
        """Update model configuration"""
        data = {
            'service_name': service_name,
            'model_string': model_string,
            'updated_at': 'now()',
            **kwargs
        }
        
        result = self.db.table('model_config').upsert(data).execute()
        return ModelConfig(**result.data[0])
    
    async def get_all_configs(self) -> Dict[str, str]:
        """Get all service model configurations"""
        result = self.db.table('model_config').select('service_name, model_string').execute()
        return {row['service_name']: row['model_string'] for row in result.data}
    
    def _get_default_model(self, service_name: str) -> str:
        """Get default model for a service"""
        defaults = {
            'rag_agent': 'openai:gpt-4o-mini',
            'document_agent': 'openai:gpt-4o',
            'embeddings': 'openai:text-embedding-3-small',
        }
        return defaults.get(service_name, 'openai:gpt-4o-mini')
```

### 2. API Key Manager

```python
# python/src/services/api_key_manager.py

import os
from typing import Optional, Dict
from cryptography.fernet import Fernet

class APIKeyManager:
    """Manages API keys for PydanticAI providers"""
    
    def __init__(self, supabase_client):
        self.db = supabase_client
        self.cipher = Fernet(os.environ['ENCRYPTION_KEY'].encode())
    
    async def set_api_key(self, provider: str, api_key: str, base_url: Optional[str] = None):
        """Store an API key for a provider"""
        encrypted = self.cipher.encrypt(api_key.encode()).decode()
        
        data = {
            'provider': provider,
            'encrypted_key': encrypted,
            'base_url': base_url,
            'is_active': True
        }
        
        self.db.table('api_keys').upsert(data).execute()
    
    async def setup_environment(self):
        """Set up environment variables for PydanticAI"""
        result = self.db.table('api_keys').select('*').eq('is_active', True).execute()
        
        for row in result.data:
            provider = row['provider']
            decrypted_key = self.cipher.decrypt(row['encrypted_key'].encode()).decode()
            
            # Set environment variables that PydanticAI expects
            env_mappings = {
                'openai': 'OPENAI_API_KEY',
                'anthropic': 'ANTHROPIC_API_KEY',
                'google': 'GOOGLE_API_KEY',
                'gemini': 'GOOGLE_API_KEY',
                'groq': 'GROQ_API_KEY',
                'mistral': 'MISTRAL_API_KEY',
            }
            
            if provider in env_mappings:
                os.environ[env_mappings[provider]] = decrypted_key
            
            # Handle base URLs for custom endpoints
            if row.get('base_url'):
                if provider == 'openai':
                    os.environ['OPENAI_BASE_URL'] = row['base_url']
                elif provider == 'ollama':
                    os.environ['OLLAMA_BASE_URL'] = row['base_url']
    
    async def get_active_providers(self) -> list[str]:
        """Get list of providers with active API keys"""
        result = self.db.table('api_keys').select('provider').eq('is_active', True).execute()
        return [row['provider'] for row in result.data]
```

### 3. Agent Initialization

```python
# python/src/agents/server.py

from contextlib import asynccontextmanager
from fastapi import FastAPI
from services.model_config import ModelConfigService
from services.api_key_manager import APIKeyManager
from agents.rag_agent import RagAgent
from agents.document_agent import DocumentAgent

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize agents with database configuration"""
    
    # Initialize services
    model_service = ModelConfigService(get_supabase_client())
    key_manager = APIKeyManager(get_supabase_client())
    
    # Set up API keys in environment
    await key_manager.setup_environment()
    
    # Get model configurations
    configs = await model_service.get_all_configs()
    
    # Initialize agents with configured models
    app.state.agents = {
        'rag': RagAgent(model=configs.get('rag_agent', 'openai:gpt-4o-mini')),
        'document': DocumentAgent(model=configs.get('document_agent', 'openai:gpt-4o')),
    }
    
    yield
    
    # Cleanup if needed

app = FastAPI(lifespan=lifespan)
```

### 4. Simple API Endpoints

```python
# python/src/server/api_routes/model_api.py

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from services.model_config import ModelConfigService
from services.api_key_manager import APIKeyManager

router = APIRouter(prefix="/api/models")

class ModelSelection(BaseModel):
    service_name: str
    model_string: str

class APIKeyUpdate(BaseModel):
    provider: str
    api_key: str
    base_url: Optional[str] = None

@router.get("/config/{service_name}")
async def get_model_config(service_name: str):
    """Get current model configuration for a service"""
    service = ModelConfigService(get_supabase_client())
    return await service.get_model_config(service_name)

@router.post("/config")
async def update_model_config(selection: ModelSelection):
    """Update model for a service"""
    service = ModelConfigService(get_supabase_client())
    
    # Validate model string format
    if ':' not in selection.model_string:
        raise HTTPException(400, "Invalid model format. Use 'provider:model-name'")
    
    provider, model = selection.model_string.split(':', 1)
    valid_providers = ['openai', 'anthropic', 'google', 'gemini', 'groq', 'mistral', 'ollama']
    
    if provider not in valid_providers:
        raise HTTPException(400, f"Unsupported provider: {provider}")
    
    return await service.set_model_config(
        selection.service_name,
        selection.model_string
    )

@router.post("/api-keys")
async def update_api_key(key_update: APIKeyUpdate):
    """Update API key for a provider"""
    manager = APIKeyManager(get_supabase_client())
    await manager.set_api_key(
        key_update.provider,
        key_update.api_key,
        key_update.base_url
    )
    
    # Refresh environment
    await manager.setup_environment()
    
    return {"status": "success", "provider": key_update.provider}

@router.get("/available-models")
async def get_available_models():
    """Get list of available models based on configured API keys"""
    manager = APIKeyManager(get_supabase_client())
    providers = await manager.get_active_providers()
    
    # Return models available for each provider
    available_models = {}
    
    if 'openai' in providers:
        available_models['openai'] = [
            'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 
            'gpt-3.5-turbo', 'text-embedding-3-small'
        ]
    
    if 'anthropic' in providers:
        available_models['anthropic'] = [
            'claude-3-opus-20240229', 'claude-3-sonnet-20240229',
            'claude-3-haiku-20240307'
        ]
    
    if 'google' in providers or 'gemini' in providers:
        available_models['gemini'] = [
            'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-pro'
        ]
    
    return available_models
```

### 5. Usage Tracking

```python
# python/src/services/usage_tracker.py

from datetime import datetime, timedelta
from decimal import Decimal

class UsageTracker:
    """Track model usage and costs"""
    
    # Simple cost mapping (per 1K tokens)
    COSTS = {
        'openai:gpt-4o': {'input': 0.005, 'output': 0.015},
        'openai:gpt-4o-mini': {'input': 0.00015, 'output': 0.0006},
        'openai:gpt-3.5-turbo': {'input': 0.0005, 'output': 0.0015},
        'anthropic:claude-3-opus': {'input': 0.015, 'output': 0.075},
        'anthropic:claude-3-sonnet': {'input': 0.003, 'output': 0.015},
        # Add more as needed
    }
    
    def __init__(self, supabase_client):
        self.db = supabase_client
    
    async def track_usage(
        self,
        service_name: str,
        model_string: str,
        input_tokens: int,
        output_tokens: int
    ):
        """Track usage for a model"""
        # Calculate cost
        cost = self._calculate_cost(model_string, input_tokens, output_tokens)
        
        # Get current period (daily)
        today = datetime.utcnow().date()
        period_start = datetime.combine(today, datetime.min.time())
        period_end = period_start + timedelta(days=1)
        
        # Upsert usage record
        data = {
            'service_name': service_name,
            'model_string': model_string,
            'period_start': period_start.isoformat(),
            'period_end': period_end.isoformat(),
        }
        
        # Use raw SQL for atomic increment
        self.db.rpc('increment_usage', {
            'p_service': service_name,
            'p_model': model_string,
            'p_tokens': input_tokens + output_tokens,
            'p_cost': float(cost),
            'p_period_start': period_start.isoformat()
        }).execute()
    
    def _calculate_cost(self, model_string: str, input_tokens: int, output_tokens: int) -> Decimal:
        """Calculate cost for token usage"""
        if model_string not in self.COSTS:
            return Decimal(0)
        
        costs = self.COSTS[model_string]
        input_cost = Decimal(str(costs['input'])) * Decimal(input_tokens) / 1000
        output_cost = Decimal(str(costs['output'])) * Decimal(output_tokens) / 1000
        
        return input_cost + output_cost
```

## Frontend Integration

```typescript
// archon-ui-main/src/services/modelService.ts

interface ModelConfig {
  serviceName: string;
  modelString: string;
  temperature?: number;
  maxTokens?: number;
}

interface AvailableModels {
  [provider: string]: string[];
}

class ModelService {
  async getModelConfig(serviceName: string): Promise<ModelConfig> {
    const response = await fetch(`/api/models/config/${serviceName}`);
    return response.json();
  }
  
  async updateModelConfig(serviceName: string, modelString: string): Promise<ModelConfig> {
    const response = await fetch('/api/models/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_name: serviceName, model_string: modelString })
    });
    return response.json();
  }
  
  async updateAPIKey(provider: string, apiKey: string, baseUrl?: string): Promise<void> {
    await fetch('/api/models/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, api_key: apiKey, base_url: baseUrl })
    });
  }
  
  async getAvailableModels(): Promise<AvailableModels> {
    const response = await fetch('/api/models/available-models');
    return response.json();
  }
}
```

## Implementation Phases

### Phase 1: Core Infrastructure (2 days)
- Create simplified database tables
- Implement ModelConfigService
- Implement APIKeyManager
- Add encryption key generation

### Phase 2: Agent Integration (1 day)
- Update agent server lifespan
- Remove old credential fetching
- Test agent initialization

### Phase 3: API Layer (1 day)
- Add model configuration endpoints
- Add API key management endpoints
- Add available models endpoint

### Phase 4: Usage Tracking (1 day)
- Implement UsageTracker
- Add usage RPC function to database
- Integrate with agents

### Phase 5: Frontend (2 days)
- Create model selection UI
- Add API key configuration
- Display usage metrics

### Phase 6: Testing & Polish (2 days)
- Integration tests
- Error handling
- Documentation

**Total: ~9 days**

## Key Advantages

1. **Simplicity**: Direct use of PydanticAI's native support
2. **No Custom Clients**: Eliminates entire provider client layer
3. **Single Source of Truth**: Database stores only configuration
4. **Easy to Understand**: Clear separation of concerns
5. **Minimal Code**: ~500 lines vs thousands
6. **Native Performance**: No overhead from custom abstractions

## Migration Steps

1. Drop all existing provider tables
2. Create new simplified schema
3. Remove all code in `python/src/server/providers/`
4. Add new services to `python/src/services/`
5. Update agent server
6. Update frontend

## What We're NOT Building

- Custom provider clients
- Provider abstraction layers
- Complex routing rules
- Health check systems
- Credential rotation (can add later if needed)
- Complex quota management

## Environment Variables Required

```env
# Encryption for API keys
ENCRYPTION_KEY=<generated-fernet-key>

# Database
SUPABASE_URL=<your-url>
SUPABASE_SERVICE_KEY=<your-key>

# Server ports
ARCHON_SERVER_PORT=8181
ARCHON_AGENTS_PORT=8052
```

## SQL Functions

```sql
-- Atomic usage increment function
CREATE OR REPLACE FUNCTION increment_usage(
    p_service TEXT,
    p_model TEXT,
    p_tokens INTEGER,
    p_cost NUMERIC,
    p_period_start TIMESTAMPTZ
) RETURNS void AS $$
BEGIN
    INSERT INTO model_usage (
        service_name, model_string, request_count, 
        total_tokens, estimated_cost, period_start, 
        period_end
    ) VALUES (
        p_service, p_model, 1, 
        p_tokens, p_cost, p_period_start, 
        p_period_start + INTERVAL '1 day'
    )
    ON CONFLICT (service_name, model_string, period_start)
    DO UPDATE SET
        request_count = model_usage.request_count + 1,
        total_tokens = model_usage.total_tokens + p_tokens,
        estimated_cost = model_usage.estimated_cost + p_cost;
END;
$$ LANGUAGE plpgsql;
```

## Testing Strategy

```python
# tests/test_model_config.py

async def test_pydantic_model_selection():
    """Test that agents use configured models"""
    
    # Set model config
    service = ModelConfigService(db)
    await service.set_model_config('rag_agent', 'anthropic:claude-3-opus')
    
    # Initialize agent
    config = await service.get_model_config('rag_agent')
    agent = RagAgent(model=config.model_string)
    
    # Verify agent uses correct model
    assert agent.model == 'anthropic:claude-3-opus'

async def test_api_key_environment():
    """Test API keys are set in environment"""
    
    manager = APIKeyManager(db)
    await manager.set_api_key('openai', 'sk-test123')
    await manager.setup_environment()
    
    assert os.environ.get('OPENAI_API_KEY') == 'sk-test123'
```

## Conclusion

This clean approach leverages PydanticAI's native capabilities while providing just enough configuration management. It's simpler, faster to implement, and easier to maintain than building a parallel provider system.