"""
Agent Chat API - Polling-based chat with SSE proxy to AI agents
"""

import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# Create router
router = APIRouter(prefix="/api/agent-chat", tags=["agent-chat"])

# Simple in-memory session storage
sessions: dict[str, dict] = {}


# Request/Response models
class CreateSessionRequest(BaseModel):
    project_id: str | None = None
    agent_type: str = "rag"


class ChatMessage(BaseModel):
    id: str
    content: str
    sender: str
    timestamp: datetime
    agent_type: str | None = None


# REST Endpoints (minimal for frontend compatibility)
@router.post("/sessions")
async def create_session(request: CreateSessionRequest):
    """Create a new chat session."""
    session_id = str(uuid.uuid4())
    sessions[session_id] = {
        "id": session_id,
        "session_id": session_id,  # Frontend expects this
        "project_id": request.project_id,
        "agent_type": request.agent_type,
        "messages": [],
        "created_at": datetime.now().isoformat(),
    }
    logger.info(f"Created chat session {session_id} with agent_type: {request.agent_type}")
    return {"session_id": session_id}


@router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Get session information."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    return sessions[session_id]


@router.get("/sessions/{session_id}/messages")
async def get_messages(session_id: str):
    """Get messages for a session (for polling)."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    return sessions[session_id].get("messages", [])


@router.post("/sessions/{session_id}/messages")
async def send_message(session_id: str, request: dict):
    """REST endpoint for sending messages."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    # Store user message
    user_msg = {
        "id": str(uuid.uuid4()),
        "content": request.get("message", ""),
        "sender": "user",
        "timestamp": datetime.now().isoformat(),
    }
    sessions[session_id]["messages"].append(user_msg)

    # Note: Agent responses would be processed here if agents service was enabled
    # For now, just return success
    return {"status": "sent"}
