"""
Model Configuration Service for PydanticAI

Manages model selection and configuration for different services.
"""

from typing import Optional, Dict, Any
import asyncio
from pydantic import BaseModel, Field
from supabase import Client
import logging

logger = logging.getLogger(__name__)


class ModelConfig(BaseModel):
    """Configuration for a PydanticAI model"""
    service_name: str = Field(..., description="Name of the service (e.g., 'rag_agent')")
    model_string: str = Field(..., description="PydanticAI model string (e.g., 'openai:gpt-4o')")
    temperature: float = Field(0.7, ge=0.0, le=2.0, description="Temperature for model generation")
    max_tokens: Optional[int] = Field(None, gt=0, description="Maximum tokens for generation")


class ModelConfigService:
    """Manages PydanticAI model configuration in database"""
    
    # Default models for each service
    DEFAULT_MODELS = {
        'rag_agent': 'openai:gpt-4o-mini',
        'document_agent': 'openai:gpt-4o',
        'task_agent': 'openai:gpt-4o',
        'embeddings': 'openai:text-embedding-3-small',
        'contextual_embedding': 'openai:gpt-4o-mini',
        'source_summary': 'openai:gpt-4o-mini',
        'code_summary': 'openai:gpt-4o-mini',
        'code_analysis': 'openai:gpt-4o-mini',
        'validation': 'openai:gpt-3.5-turbo',
    }
    
    # Valid PydanticAI providers
    VALID_PROVIDERS = {
        'openai', 'anthropic', 'google', 'gemini', 
        'groq', 'mistral', 'ollama', 'cohere'
    }
    
    def __init__(self, supabase_client: Client):
        """Initialize with Supabase client"""
        self.db = supabase_client
    
    async def get_model_config(self, service_name: str) -> ModelConfig:
        """
        Get model configuration for a service.
        
        Args:
            service_name: Name of the service (e.g., 'rag_agent')
            
        Returns:
            ModelConfig with current settings or defaults
        """
        try:
            # Run blocking Supabase call in thread
            result = await asyncio.to_thread(
                lambda: self.db.table('model_config')
                .select('*')
                .eq('service_name', service_name)
                .single()
                .execute()
            )
            
            if result.data:
                logger.info(f"Retrieved model config for {service_name}: {result.data['model_string']}")
                return ModelConfig(**result.data)
        except Exception as e:
            # If not found or error, use default
            logger.debug(f"No config found for {service_name}, using default: {e}")
        
        # Return default configuration
        default_model = self.DEFAULT_MODELS.get(service_name, 'openai:gpt-4o-mini')
        logger.info(f"Using default model for {service_name}: {default_model}")
        
        return ModelConfig(
            service_name=service_name,
            model_string=default_model
        )
    
    async def set_model_config(
        self, 
        service_name: str, 
        model_string: str,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        updated_by: Optional[str] = None
    ) -> ModelConfig:
        """
        Update model configuration for a service.
        
        Args:
            service_name: Name of the service
            model_string: PydanticAI model string (e.g., 'openai:gpt-4o')
            temperature: Optional temperature override
            max_tokens: Optional max tokens override
            updated_by: Optional user identifier
            
        Returns:
            Updated ModelConfig
            
        Raises:
            ValueError: If model_string format is invalid
        """
        # Validate model string format
        if ':' not in model_string:
            raise ValueError(
                f"Invalid model format '{model_string}'. "
                "Use 'provider:model-name' format (e.g., 'openai:gpt-4o')"
            )
        
        provider, model_name = model_string.split(':', 1)
        
        # No longer validate providers since we support dynamic providers from OpenRouter
        # if provider not in self.VALID_PROVIDERS:
        #     raise ValueError(
        #         f"Unsupported provider '{provider}'. "
        #         f"Valid providers: {', '.join(self.VALID_PROVIDERS)}"
        #     )
        
        # Prepare data for upsert
        data = {
            'service_name': service_name,
            'model_string': model_string,
            'updated_at': 'now()'
        }
        
        if temperature is not None:
            data['temperature'] = temperature
        if max_tokens is not None:
            data['max_tokens'] = max_tokens
        if updated_by is not None:
            data['updated_by'] = updated_by
        
        # Upsert configuration (specify on_conflict to handle updates properly)
        result = await asyncio.to_thread(
            lambda: self.db.table('model_config')
            .upsert(data, on_conflict='service_name')
            .execute()
        )
        
        logger.info(f"Updated model config for {service_name} to {model_string}")
        return ModelConfig(**result.data[0])
    
    async def get_all_configs(self) -> Dict[str, str]:
        """
        Get all service model configurations.
        
        Returns:
            Dictionary mapping service_name to model_string
        """
        try:
            result = await asyncio.to_thread(
                lambda: self.db.table('model_config')
                .select('service_name, model_string')
                .execute()
            )
            
            configs = {row['service_name']: row['model_string'] for row in result.data}
            
            # Add defaults for any missing services
            for service, default_model in self.DEFAULT_MODELS.items():
                if service not in configs:
                    configs[service] = default_model
            
            logger.info(f"Retrieved {len(configs)} model configurations")
            return configs
            
        except Exception as e:
            logger.error(f"Failed to get all configs: {e}")
            # Return all defaults on error
            return self.DEFAULT_MODELS.copy()
    
    async def validate_model_string(self, model_string: str) -> tuple[bool, Optional[str]]:
        """
        Validate a model string format.
        
        Args:
            model_string: Model string to validate
            
        Returns:
            Tuple of (is_valid, error_message)
        """
        if ':' not in model_string:
            return False, "Model string must be in 'provider:model-name' format"
        
        provider, model_name = model_string.split(':', 1)
        
        if provider not in self.VALID_PROVIDERS:
            return False, f"Unknown provider '{provider}'"
        
        if not model_name:
            return False, "Model name cannot be empty"
        
        return True, None
    
    async def get_provider_from_service(self, service_name: str) -> str:
        """
        Get the provider name for a service.
        
        Args:
            service_name: Name of the service
            
        Returns:
            Provider name (e.g., 'openai', 'anthropic')
        """
        config = await self.get_model_config(service_name)
        provider = config.model_string.split(':', 1)[0]
        return provider
    
    async def bulk_update_provider(
        self, 
        old_provider: str, 
        new_provider: str,
        model_mappings: Optional[Dict[str, str]] = None
    ) -> int:
        """
        Update all services using a specific provider to a new provider.
        
        Args:
            old_provider: Current provider to replace
            new_provider: New provider to use
            model_mappings: Optional dict mapping old models to new models
            
        Returns:
            Number of services updated
        """
        configs = await self.get_all_configs()
        updated = 0
        
        for service_name, model_string in configs.items():
            if model_string.startswith(f"{old_provider}:"):
                old_model = model_string.split(':', 1)[1]
                
                # Use mapping if provided, otherwise keep same model name
                if model_mappings and old_model in model_mappings:
                    new_model = model_mappings[old_model]
                else:
                    new_model = old_model
                
                new_model_string = f"{new_provider}:{new_model}"
                
                await self.set_model_config(
                    service_name, 
                    new_model_string,
                    updated_by='bulk_update'
                )
                updated += 1
                
                logger.info(f"Updated {service_name} from {model_string} to {new_model_string}")
        
        return updated