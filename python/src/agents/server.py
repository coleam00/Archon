"""
Agents Service - Lightweight FastAPI server for PydanticAI agents

This service ONLY hosts PydanticAI agents. It does NOT contain:
- ML models or embeddings (those are in Server)
- Direct database access (use MCP tools)
- Business logic (that's in Server)

The agents use MCP tools for all data operations.
"""

import asyncio
import json
import logging
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# Import our PydanticAI agents
from .document_agent import DocumentAgent
from .rag_agent import RagAgent

# Import provider integration
try:
    from ..providers_clean.integration.agent_server_integration import ProviderIntegration
    PROVIDER_INTEGRATION_AVAILABLE = True
except ImportError:
    PROVIDER_INTEGRATION_AVAILABLE = False
    logger = logging.getLogger(__name__)
    logger.warning("Provider integration not available - using legacy credential system")

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# Request/Response models
class AgentRequest(BaseModel):
    """Request model for agent interactions"""

    agent_type: str  # "document", "rag", etc.
    prompt: str
    context: dict[str, Any] | None = None
    options: dict[str, Any] | None = None


class AgentResponse(BaseModel):
    """Response model for agent interactions"""

    success: bool
    result: Any | None = None
    error: str | None = None
    metadata: dict[str, Any] | None = None


# Agent registry
AVAILABLE_AGENTS = {
    "document": DocumentAgent,
    "rag": RagAgent,
}

# Global credentials storage (for legacy mode)
AGENT_CREDENTIALS = {}


async def fetch_credentials_from_server():
    """Fetch credentials from the server's internal API (legacy mode)."""
    max_retries = 30  # Try for up to 5 minutes (30 * 10 seconds)
    retry_delay = 10  # seconds

    for attempt in range(max_retries):
        try:
            async with httpx.AsyncClient() as client:
                # Call the server's internal credentials endpoint
                server_port = os.getenv("ARCHON_SERVER_PORT")
                if not server_port:
                    raise ValueError(
                        "ARCHON_SERVER_PORT environment variable is required. "
                        "Please set it in your .env file or environment."
                    )
                response = await client.get(
                    f"http://archon-server:{server_port}/internal/credentials/agents", timeout=10.0
                )
                response.raise_for_status()
                credentials = response.json()

                # Set credentials as environment variables
                for key, value in credentials.items():
                    if value is not None:
                        os.environ[key] = str(value)
                        logger.info(f"Set credential: {key}")

                # Store credentials globally for agent initialization
                global AGENT_CREDENTIALS
                AGENT_CREDENTIALS = credentials

                logger.info(f"Successfully fetched {len(credentials)} credentials from server")
                return credentials

        except (httpx.HTTPError, httpx.RequestError) as e:
            if attempt < max_retries - 1:
                logger.warning(
                    f"Failed to fetch credentials (attempt {attempt + 1}/{max_retries}): {e}"
                )
                logger.info(f"Retrying in {retry_delay} seconds...")
                await asyncio.sleep(retry_delay)
            else:
                logger.error(f"Failed to fetch credentials after {max_retries} attempts")
                raise Exception("Could not fetch credentials from server")


# Lifespan context manager
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize and cleanup resources"""
    logger.info("Starting Agents service...")

    # Try to use provider integration if available
    if PROVIDER_INTEGRATION_AVAILABLE:
        logger.info("Using clean provider integration system")
        
        # Initialize provider integration
        provider_integration = ProviderIntegration()
        app.state.provider_integration = provider_integration
        
        try:
            # Initialize the provider system
            init_status = await provider_integration.initialize()
            
            if not init_status.get('api_keys'):
                logger.warning("No API keys configured - agents will use defaults")
            
            if not init_status.get('model_configs'):
                logger.warning("No model configurations found - using defaults")
            
            # Initialize agents with configured models
            app.state.agents = {}
            
            for name, agent_class in AVAILABLE_AGENTS.items():
                try:
                    # Get model from provider system
                    model = await provider_integration.get_agent_model(name)
                    app.state.agents[name] = agent_class(model=model)
                    logger.info(f"Initialized {name} agent with model: {model}")
                except Exception as e:
                    logger.error(f"Failed to initialize {name} agent: {e}")
                    # Try with default
                    app.state.agents[name] = agent_class()
                    logger.info(f"Initialized {name} agent with default model")
                    
        except Exception as e:
            logger.error(f"Provider integration failed, falling back to legacy: {e}")
            # Fall back to legacy credential system
            await setup_legacy_agents(app)
    else:
        # Use legacy credential system
        logger.info("Using legacy credential system")
        await setup_legacy_agents(app)

    yield

    # Cleanup
    logger.info("Shutting down Agents service...")


async def setup_legacy_agents(app: FastAPI):
    """Setup agents using legacy credential system"""
    # Fetch credentials from server first
    try:
        await fetch_credentials_from_server()
    except Exception as e:
        logger.error(f"Failed to fetch credentials: {e}")
        # Continue with defaults if we can't get credentials

    # Initialize agents with fetched credentials
    app.state.agents = {}
    for name, agent_class in AVAILABLE_AGENTS.items():
        try:
            # Pass model configuration from credentials
            model_key = f"{name.upper()}_AGENT_MODEL"
            model = AGENT_CREDENTIALS.get(model_key, "openai:gpt-4o-mini")

            app.state.agents[name] = agent_class(model=model)
            logger.info(f"Initialized {name} agent with model: {model}")
        except Exception as e:
            logger.error(f"Failed to initialize {name} agent: {e}")


# Create FastAPI app
app = FastAPI(
    title="Archon Agents Service",
    description="Lightweight service hosting PydanticAI agents",
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    provider_status = "provider_integration" if PROVIDER_INTEGRATION_AVAILABLE else "legacy"
    
    return {
        "status": "healthy",
        "service": "agents",
        "agents_available": list(AVAILABLE_AGENTS.keys()),
        "provider_system": provider_status,
        "note": "This service only hosts PydanticAI agents",
    }


@app.post("/agents/run", response_model=AgentResponse)
async def run_agent(request: AgentRequest):
    """
    Run a specific agent with the given prompt.

    The agent will use MCP tools for any data operations.
    """
    try:
        # Get the requested agent
        if request.agent_type not in app.state.agents:
            raise HTTPException(status_code=400, detail=f"Unknown agent type: {request.agent_type}")

        agent = app.state.agents[request.agent_type]

        # Prepare dependencies for the agent
        deps = {
            "context": request.context or {},
            "options": request.options or {},
            "mcp_endpoint": os.getenv("MCP_SERVICE_URL", "http://archon-mcp:8051"),
        }

        # Run the agent
        result = await agent.run(request.prompt, deps)
        
        # Track usage if provider integration is available
        if PROVIDER_INTEGRATION_AVAILABLE and hasattr(app.state, 'provider_integration'):
            # Extract token counts if available (this depends on agent implementation)
            if hasattr(result, 'usage'):
                try:
                    await app.state.provider_integration.track_agent_usage(
                        agent_name=request.agent_type,
                        input_tokens=result.usage.get('prompt_tokens', 0),
                        output_tokens=result.usage.get('completion_tokens', 0)
                    )
                except Exception as e:
                    logger.warning(f"Failed to track usage: {e}")

        return AgentResponse(
            success=True,
            result=result,
            metadata={"agent_type": request.agent_type, "model": agent.model},
        )

    except Exception as e:
        logger.error(f"Error running {request.agent_type} agent: {e}")
        return AgentResponse(success=False, error=str(e))


@app.get("/agents/list")
async def list_agents():
    """List all available agents and their capabilities"""
    return {
        "agents": {
            "document": {
                "description": "Manage project documents through conversation",
                "capabilities": [
                    "Create new documents",
                    "Update existing documents",
                    "Query document information",
                    "Track version history",
                ],
                "model": getattr(app.state.agents.get("document"), "model", "not initialized"),
            },
            "rag": {
                "description": "Search and chat with your knowledge base",
                "capabilities": [
                    "Semantic search across documents",
                    "Answer questions based on content",
                    "Find code examples",
                    "Explain concepts from documentation",
                ],
                "model": getattr(app.state.agents.get("rag"), "model", "not initialized"),
            },
        }
    }


@app.get("/agents/stream/{agent_type}")
async def stream_agent(agent_type: str, prompt: str):
    """
    Stream agent responses (if the agent supports streaming).
    
    Note: Current PydanticAI agents don't support streaming natively,
    but this endpoint is here for future enhancement.
    """
    if agent_type not in app.state.agents:
        raise HTTPException(status_code=400, detail=f"Unknown agent type: {agent_type}")

    async def generate() -> AsyncGenerator[str, None]:
        # For now, just run the agent normally and yield the result
        # In the future, we can implement true streaming
        agent = app.state.agents[agent_type]
        result = await agent.run(prompt, {})
        yield json.dumps({"result": result})

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.get("/agents/model-config")
async def get_model_configuration():
    """Get current model configuration for all agents"""
    config = {}
    
    if PROVIDER_INTEGRATION_AVAILABLE and hasattr(app.state, 'provider_integration'):
        # Get from provider integration
        try:
            for agent_name in AVAILABLE_AGENTS.keys():
                config[agent_name] = await app.state.provider_integration.get_agent_model(agent_name)
        except Exception as e:
            logger.error(f"Failed to get model config from provider: {e}")
    else:
        # Get from agents directly
        for name, agent in app.state.agents.items():
            config[name] = getattr(agent, "model", "unknown")
    
    return {
        "provider_system": "provider_integration" if PROVIDER_INTEGRATION_AVAILABLE else "legacy",
        "models": config
    }


if __name__ == "__main__":
    # For local development only
    port = int(os.getenv("AGENTS_PORT", 8052))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")