"""
API routes for Agent Registry.
"""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..config.logfire_config import get_logger
from ..services.agent_registry_service import get_agent_registry_service

logger = get_logger(__name__)
router = APIRouter(prefix="/api/agents", tags=["Agent Registry"])


# Request Models
class AgentRegisterRequest(BaseModel):
    name: str = Field(..., description="Unique agent name")
    capabilities: list[str] | None = Field(default_factory=list, description="Agent capabilities")
    metadata: dict | None = Field(default_factory=dict, description="Additional metadata")
    role: str | None = Field(default=None, description="Agent role (e.g. 'Developer', 'Scrum Master')")


@router.post("/register", response_model=dict)
async def register_agent(request: AgentRegisterRequest):
    """Register or update an agent in the registry."""
    try:
        service = get_agent_registry_service()
        agent = await service.register_agent(
            name=request.name,
            capabilities=request.capabilities,
            metadata=request.metadata,
            role=request.role,
        )
        return {"success": True, "agent": agent}
    except Exception as e:
        logger.error(f"Error registering agent: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{name}/heartbeat", response_model=dict)
async def agent_heartbeat(name: str):
    """Update agent last_seen and set status to active."""
    try:
        service = get_agent_registry_service()
        agent = await service.heartbeat(name)
        return {"success": True, "agent": agent}
    except Exception as e:
        logger.error(f"Error sending heartbeat for agent {name}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("", response_model=dict)
async def list_agents(
    status: str | None = Query(None, description="Filter by status: active, inactive, busy"),
):
    """List all registered agents with optional status filter."""
    try:
        service = get_agent_registry_service()
        agents = await service.list_agents(status=status)
        return {"success": True, "agents": agents, "count": len(agents)}
    except Exception as e:
        logger.error(f"Error listing agents: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{name}", response_model=dict)
async def get_agent(name: str):
    """Get a specific agent by name."""
    try:
        service = get_agent_registry_service()
        agent = await service.get_agent(name)
        if not agent:
            raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")
        return {"success": True, "agent": agent}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting agent {name}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{name}/deactivate", response_model=dict)
async def deactivate_agent(name: str):
    """Set an agent's status to inactive."""
    try:
        service = get_agent_registry_service()
        agent = await service.deactivate_agent(name)
        return {"success": True, "agent": agent}
    except Exception as e:
        logger.error(f"Error deactivating agent {name}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
