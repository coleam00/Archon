"""
Agent Server Integration with Clean Provider System

This module shows how to integrate the clean provider system with the agent server.
"""

import os
import logging
from contextlib import asynccontextmanager
from typing import Dict, Any

from fastapi import FastAPI
from supabase import create_client, Client

# Import provider services
from ..services import (
    ModelConfigService,
    APIKeyManager,
    UsageTracker
)

logger = logging.getLogger(__name__)


def get_supabase_client() -> Client:
    """Get Supabase client instance"""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    
    if not url or not key:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
    
    return create_client(url, key)


class ProviderIntegration:
    """Handles integration of provider system with agents"""
    
    def __init__(self):
        self.supabase = get_supabase_client()
        self.model_service = ModelConfigService(self.supabase)
        self.key_manager = APIKeyManager(self.supabase)
        self.usage_tracker = UsageTracker(self.supabase)
        self.agent_configs: Dict[str, str] = {}
    
    async def initialize(self) -> Dict[str, bool]:
        """
        Initialize the provider system.
        
        Returns:
            Status dict with initialization results
        """
        status = {}
        
        try:
            # 1. Set up API keys in environment
            logger.info("Setting up API keys in environment...")
            key_status = await self.key_manager.setup_environment()
            status['api_keys'] = len(key_status) > 0
            
            for provider, success in key_status.items():
                if success:
                    logger.info(f"✓ {provider} API key configured")
                else:
                    logger.warning(f"✗ {provider} API key failed")
            
            # 2. Get model configurations
            logger.info("Loading model configurations...")
            self.agent_configs = await self.model_service.get_all_configs()
            status['model_configs'] = len(self.agent_configs) > 0
            
            for service, model in self.agent_configs.items():
                logger.info(f"  {service}: {model}")
            
            # 3. Validate configurations
            status['validation'] = await self._validate_configurations()
            
            logger.info(f"Provider system initialized: {status}")
            return status
            
        except Exception as e:
            logger.error(f"Failed to initialize provider system: {e}")
            status['error'] = str(e)
            return status
    
    async def _validate_configurations(self) -> bool:
        """
        Validate that configured models have corresponding API keys.
        
        Returns:
            True if all configurations are valid
        """
        active_providers = await self.key_manager.get_active_providers()
        all_valid = True
        
        for service, model_string in self.agent_configs.items():
            if ':' in model_string:
                provider = model_string.split(':', 1)[0]
                
                # Special case: Ollama doesn't need API key
                if provider == 'ollama':
                    continue
                
                if provider not in active_providers:
                    logger.warning(
                        f"Service '{service}' uses {provider} but no API key is configured"
                    )
                    all_valid = False
        
        return all_valid
    
    async def get_agent_model(self, agent_name: str) -> str:
        """
        Get the configured model for an agent.
        
        Args:
            agent_name: Name of the agent (e.g., 'rag', 'document')
            
        Returns:
            Model string for PydanticAI
        """
        # Map agent names to service names
        service_map = {
            'rag': 'rag_agent',
            'document': 'document_agent',
            'task': 'task_agent',
        }
        
        service_name = service_map.get(agent_name, f"{agent_name}_agent")
        
        # Get from cache or fetch
        if service_name not in self.agent_configs:
            config = await self.model_service.get_model_config(service_name)
            self.agent_configs[service_name] = config.model_string
        
        return self.agent_configs[service_name]
    
    async def track_agent_usage(
        self,
        agent_name: str,
        input_tokens: int,
        output_tokens: int
    ) -> None:
        """
        Track usage for an agent.
        
        Args:
            agent_name: Name of the agent
            input_tokens: Number of input tokens
            output_tokens: Number of output tokens
        """
        service_name = f"{agent_name}_agent"
        model_string = await self.get_agent_model(agent_name)
        
        await self.usage_tracker.track_usage(
            service_name=service_name,
            model_string=model_string,
            input_tokens=input_tokens,
            output_tokens=output_tokens
        )
    
    async def get_credentials_for_agent_init(self) -> Dict[str, Any]:
        """
        Get credentials formatted for backward compatibility.
        
        Returns:
            Dict with model configurations for agents
        """
        credentials = {}
        
        # Add model configurations
        for service, model_string in self.agent_configs.items():
            # Convert service_name to env var format
            # e.g., 'rag_agent' -> 'RAG_AGENT_MODEL'
            env_key = f"{service.upper()}_MODEL"
            credentials[env_key] = model_string
        
        # Add any other required credentials
        credentials['OPENAI_API_KEY'] = os.environ.get('OPENAI_API_KEY', '')
        credentials['ANTHROPIC_API_KEY'] = os.environ.get('ANTHROPIC_API_KEY', '')
        
        return credentials


@asynccontextmanager
async def lifespan_with_providers(app: FastAPI):
    """
    FastAPI lifespan context manager with provider integration.
    
    This replaces the old credential fetching with the new provider system.
    """
    logger.info("Starting Agents service with clean provider system...")
    
    # Initialize provider integration
    provider_integration = ProviderIntegration()
    app.state.provider_integration = provider_integration
    
    # Initialize the provider system
    init_status = await provider_integration.initialize()
    
    if not init_status.get('api_keys'):
        logger.warning("No API keys configured - agents will use defaults")
    
    if not init_status.get('model_configs'):
        logger.warning("No model configurations found - using defaults")
    
    # Import agents (do this after setting up environment)
    from agents.rag_agent import RagAgent
    from agents.document_agent import DocumentAgent
    
    # Initialize agents with configured models
    app.state.agents = {}
    
    # Get models for each agent
    rag_model = await provider_integration.get_agent_model('rag')
    doc_model = await provider_integration.get_agent_model('document')
    
    logger.info(f"Initializing RAG agent with model: {rag_model}")
    logger.info(f"Initializing Document agent with model: {doc_model}")
    
    # Create agent instances
    try:
        app.state.agents['rag'] = RagAgent(model=rag_model)
        app.state.agents['document'] = DocumentAgent(model=doc_model)
        logger.info("Agents initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize agents: {e}")
        # Continue anyway - agents might work with defaults
    
    yield
    
    # Cleanup
    logger.info("Shutting down Agents service...")


# Example of how to use in the actual agent server
def create_agent_app() -> FastAPI:
    """
    Create FastAPI app with provider integration.
    
    Returns:
        Configured FastAPI application
    """
    app = FastAPI(
        title="Archon Agents Service",
        description="PydanticAI agents with clean provider integration",
        version="2.0.0",
        lifespan=lifespan_with_providers
    )
    
    return app


# Example endpoint that tracks usage
async def run_agent_with_tracking(
    app: FastAPI,
    agent_name: str,
    prompt: str,
    context: Dict[str, Any]
) -> Any:
    """
    Run an agent and track its usage.
    
    Args:
        app: FastAPI app instance
        agent_name: Name of the agent to run
        prompt: User prompt
        context: Additional context
        
    Returns:
        Agent response
    """
    # Get the agent
    agent = app.state.agents.get(agent_name)
    if not agent:
        raise ValueError(f"Unknown agent: {agent_name}")
    
    # Run the agent
    result = await agent.run(prompt, context)
    
    # Track usage (you'd need to extract token counts from the result)
    # This is a simplified example
    if hasattr(result, 'usage'):
        await app.state.provider_integration.track_agent_usage(
            agent_name=agent_name,
            input_tokens=result.usage.get('prompt_tokens', 0),
            output_tokens=result.usage.get('completion_tokens', 0)
        )
    
    return result