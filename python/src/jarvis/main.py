"""
JARVIS Service - Main API Entry Point

FastAPI service that exposes JARVIS's capabilities via HTTP.
"""

import logging
import os
from datetime import datetime

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .brain import JARVIS

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Initialize FastAPI
app = FastAPI(
    title="JARVIS API",
    description="Just A Rather Very Intelligent System - Your Personal AI Assistant",
    version="1.0.0"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify actual origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize JARVIS
jarvis: JARVIS = None


class CommandRequest(BaseModel):
    """Request model for JARVIS commands."""
    text: str
    context: dict = None


class CommandResponse(BaseModel):
    """Response model for JARVIS commands."""
    success: bool
    response: str
    intent: str = None
    confidence: float = None
    timestamp: str
    error: str = None


@app.on_event("startup")
async def startup_event():
    """Initialize JARVIS on startup."""
    global jarvis
    user_name = os.getenv("JARVIS_USER_NAME", "Sir")
    jarvis = JARVIS(user_name=user_name)
    logger.info(f"JARVIS initialized and ready to serve {user_name}")


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "service": "jarvis",
        "version": "1.0.0",
        "timestamp": datetime.now().isoformat(),
        "message": "JARVIS is operational"
    }


@app.post("/api/process", response_model=CommandResponse)
async def process_command(request: CommandRequest):
    """
    Process a natural language command through JARVIS.

    This is the main API endpoint for interacting with JARVIS.
    Send a text command and get JARVIS's response.

    Example:
        ```json
        {
            "text": "Design an authentication system for my Next.js app",
            "context": {}
        }
        ```
    """
    if not jarvis:
        raise HTTPException(status_code=503, detail="JARVIS not initialized")

    try:
        result = await jarvis.process_command(request.text, request.context)
        return CommandResponse(**result)

    except Exception as e:
        logger.error(f"Error processing command: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Error processing command: {str(e)}"
        )


@app.get("/api/status")
async def get_status():
    """Get JARVIS system status."""
    if not jarvis:
        return {"status": "not_initialized"}

    return {
        "status": "operational",
        "user": jarvis.user_name,
        "rings_loaded": len(jarvis.rings),
        "conversation_history_length": len(jarvis.conversation_history),
        "active_agents": jarvis.active_agents,
        "archon_mcp_url": jarvis.archon_mcp_url,
        "timestamp": datetime.now().isoformat()
    }


@app.get("/api/rings")
async def list_rings():
    """List all available specialist rings (agents)."""
    if not jarvis:
        raise HTTPException(status_code=503, detail="JARVIS not initialized")

    rings_info = []
    for ring_id, ring in jarvis.rings.items():
        rings_info.append({
            "id": ring.id,
            "name": ring.name,
            "role": ring.role,
            "capabilities": ring.capabilities,
            "triggers": ring.triggers
        })

    return {
        "success": True,
        "rings": rings_info,
        "count": len(rings_info)
    }


@app.get("/api/conversation-history")
async def get_conversation_history(limit: int = 10):
    """Get recent conversation history."""
    if not jarvis:
        raise HTTPException(status_code=503, detail="JARVIS not initialized")

    history = jarvis.conversation_history[-limit:]
    return {
        "success": True,
        "history": history,
        "count": len(history),
        "total": len(jarvis.conversation_history)
    }


@app.get("/api/cost-stats")
async def get_cost_stats():
    """
    Get JARVIS cost and usage statistics.

    Returns API call counts, cache statistics, and estimated costs.
    Useful for monitoring API usage and optimizing costs.
    """
    if not jarvis:
        raise HTTPException(status_code=503, detail="JARVIS not initialized")

    stats = jarvis.get_cost_stats()
    return {
        "success": True,
        "stats": stats,
        "timestamp": datetime.now().isoformat()
    }


if __name__ == "__main__":
    port = int(os.getenv("JARVIS_PORT", "8055"))
    uvicorn.run(app, host="0.0.0.0", port=port)
