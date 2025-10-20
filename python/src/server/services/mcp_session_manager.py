"""
MCP Session Manager

This module provides simplified session management for MCP server connections,
enabling clients to reconnect after server restarts.
"""

import uuid
from datetime import datetime, timedelta

from pydantic import BaseModel

# Removed direct logging import - using unified config
from ..config.logfire_config import get_logger

logger = get_logger(__name__)


class MCPSessionInfo(BaseModel):
    """Information about an active MCP session"""
    session_id: str
    client_id: str
    connected_at: datetime
    last_activity: datetime
    tools_called: int = 0


class SimplifiedSessionManager:
    """Simplified MCP session manager that tracks session IDs and expiration"""

    def __init__(self, timeout: int = 3600):
        """
        Initialize session manager

        Args:
            timeout: Session expiration time in seconds (default: 1 hour)
        """
        self.sessions: dict[str, datetime] = {}  # session_id -> last_seen
        self._detailed_sessions: dict[str, MCPSessionInfo] = {}  # session_id -> session info
        self.timeout = timeout

    def create_session(self) -> str:
        """Create a new session and return its ID"""
        session_id = str(uuid.uuid4())
        self.sessions[session_id] = datetime.now()
        logger.info(f"Created new session: {session_id}")
        return session_id

    def validate_session(self, session_id: str) -> bool:
        """Validate a session ID and update last seen time"""
        if session_id not in self.sessions:
            return False

        last_seen = self.sessions[session_id]
        if datetime.now() - last_seen > timedelta(seconds=self.timeout):
            # Session expired, remove it
            del self.sessions[session_id]
            logger.info(f"Session {session_id} expired and removed")
            return False

        # Update last seen time
        self.sessions[session_id] = datetime.now()
        return True

    def cleanup_expired_sessions(self) -> int:
        """Remove expired sessions and return count of removed sessions"""
        now = datetime.now()
        expired = []

        for session_id, last_seen in self.sessions.items():
            if now - last_seen > timedelta(seconds=self.timeout):
                expired.append(session_id)

        for session_id in expired:
            del self.sessions[session_id]
            if session_id in self._detailed_sessions:
                del self._detailed_sessions[session_id]
            logger.info(f"Cleaned up expired session: {session_id}")

        return len(expired)

    def get_active_session_count(self) -> int:
        """Get count of active sessions"""
        # Clean up expired sessions first
        self.cleanup_expired_sessions()
        return len(self.sessions)

    def register_session(self, session_id: str, client_id: str) -> None:
        """Register a new MCP client session with detailed tracking."""
        self._detailed_sessions[session_id] = MCPSessionInfo(
            session_id=session_id,
            client_id=client_id,
            connected_at=datetime.now(),
            last_activity=datetime.now(),
        )
        # Also register in the simple sessions dict
        self.sessions[session_id] = datetime.now()
        logger.info(f"Registered detailed session: {session_id} for client: {client_id}")

    def update_activity(self, session_id: str) -> None:
        """Update last activity timestamp for session."""
        if session_id in self._detailed_sessions:
            self._detailed_sessions[session_id].last_activity = datetime.now()
            self._detailed_sessions[session_id].tools_called += 1

        # Also update simple sessions
        if session_id in self.sessions:
            self.sessions[session_id] = datetime.now()

    def unregister_session(self, session_id: str) -> None:
        """Remove a session when client disconnects."""
        self._detailed_sessions.pop(session_id, None)
        self.sessions.pop(session_id, None)
        logger.info(f"Unregistered session: {session_id}")

    def get_active_sessions(self) -> list[MCPSessionInfo]:
        """Return list of all active MCP sessions."""
        # Clean up expired sessions first
        self.cleanup_expired_sessions()
        return list(self._detailed_sessions.values())

    def get_session_count(self) -> int:
        """Return count of active sessions."""
        # Clean up expired sessions first
        self.cleanup_expired_sessions()
        return len(self._detailed_sessions)


# Global session manager instance
_session_manager: SimplifiedSessionManager | None = None


def get_session_manager() -> SimplifiedSessionManager:
    """Get the global session manager instance"""
    global _session_manager
    if _session_manager is None:
        _session_manager = SimplifiedSessionManager()
    return _session_manager
