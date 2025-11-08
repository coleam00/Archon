"""
Tests for MCP Session Manager

Tests session tracking functionality for MCP server connections.
"""

import pytest
from datetime import datetime
from src.server.services.mcp_session_manager import MCPSessionManager, MCPSessionInfo


class TestMCPSessionManager:
    """Test suite for MCPSessionManager"""

    @pytest.fixture
    def session_manager(self):
        """Create MCPSessionManager instance"""
        return MCPSessionManager()

    def test_init_empty_sessions(self, session_manager):
        """Test manager initializes with no sessions"""
        assert session_manager.get_active_sessions_count() == 0
        assert len(session_manager.get_all_sessions()) == 0

    def test_add_session(self, session_manager):
        """Test adding a new session"""
        session_manager.add_session("session_1", "Cursor", "192.168.1.100")

        assert session_manager.get_active_sessions_count() == 1
        sessions = session_manager.get_all_sessions()
        assert len(sessions) == 1
        assert sessions[0]["session_id"] == "session_1"
        assert sessions[0]["client_name"] == "Cursor"
        assert sessions[0]["client_ip"] == "192.168.1.100"

    def test_add_multiple_sessions(self, session_manager):
        """Test adding multiple sessions"""
        session_manager.add_session("session_1", "Cursor", "192.168.1.100")
        session_manager.add_session("session_2", "Windsurf", "192.168.1.101")
        session_manager.add_session("session_3", "Claude Desktop", "192.168.1.102")

        assert session_manager.get_active_sessions_count() == 3

    def test_remove_session(self, session_manager):
        """Test removing a session"""
        session_manager.add_session("session_1", "Cursor", "192.168.1.100")
        session_manager.add_session("session_2", "Windsurf", "192.168.1.101")

        assert session_manager.get_active_sessions_count() == 2

        session_manager.remove_session("session_1")

        assert session_manager.get_active_sessions_count() == 1
        sessions = session_manager.get_all_sessions()
        assert sessions[0]["session_id"] == "session_2"

    def test_remove_nonexistent_session(self, session_manager):
        """Test removing non-existent session doesn't error"""
        session_manager.add_session("session_1", "Cursor", "192.168.1.100")

        # Should not raise exception
        session_manager.remove_session("nonexistent_session")

        assert session_manager.get_active_sessions_count() == 1

    def test_get_session_info(self, session_manager):
        """Test retrieving specific session info"""
        session_manager.add_session("session_1", "Cursor", "192.168.1.100")

        info = session_manager.get_session_info("session_1")

        assert info is not None
        assert info["session_id"] == "session_1"
        assert info["client_name"] == "Cursor"
        assert info["client_ip"] == "192.168.1.100"
        assert "connected_at" in info
        assert isinstance(info["connected_at"], datetime)

    def test_get_session_info_nonexistent(self, session_manager):
        """Test retrieving non-existent session returns None"""
        info = session_manager.get_session_info("nonexistent")

        assert info is None

    def test_clear_all_sessions(self, session_manager):
        """Test clearing all sessions"""
        session_manager.add_session("session_1", "Cursor", "192.168.1.100")
        session_manager.add_session("session_2", "Windsurf", "192.168.1.101")

        assert session_manager.get_active_sessions_count() == 2

        session_manager.clear_all_sessions()

        assert session_manager.get_active_sessions_count() == 0
        assert len(session_manager.get_all_sessions()) == 0

    def test_session_info_model(self):
        """Test MCPSessionInfo Pydantic model"""
        now = datetime.now()

        session_info = MCPSessionInfo(
            session_id="test_session",
            client_name="Cursor",
            client_ip="192.168.1.100",
            connected_at=now
        )

        assert session_info.session_id == "test_session"
        assert session_info.client_name == "Cursor"
        assert session_info.client_ip == "192.168.1.100"
        assert session_info.connected_at == now

    def test_session_info_to_dict(self):
        """Test converting MCPSessionInfo to dict"""
        now = datetime.now()

        session_info = MCPSessionInfo(
            session_id="test_session",
            client_name="Cursor",
            client_ip="192.168.1.100",
            connected_at=now
        )

        data = session_info.model_dump()

        assert data["session_id"] == "test_session"
        assert data["client_name"] == "Cursor"
        assert data["client_ip"] == "192.168.1.100"
        assert data["connected_at"] == now

    def test_concurrent_session_management(self, session_manager):
        """Test managing sessions with same client from different IPs"""
        session_manager.add_session("cursor_1", "Cursor", "192.168.1.100")
        session_manager.add_session("cursor_2", "Cursor", "192.168.1.101")

        assert session_manager.get_active_sessions_count() == 2

        sessions = session_manager.get_all_sessions()
        client_names = [s["client_name"] for s in sessions]
        assert client_names.count("Cursor") == 2

    def test_session_reconnect(self, session_manager):
        """Test handling session reconnect (same session_id)"""
        session_manager.add_session("session_1", "Cursor", "192.168.1.100")

        first_time = session_manager.get_session_info("session_1")["connected_at"]

        # Reconnect with same session_id (should update or replace)
        import time
        time.sleep(0.01)  # Ensure different timestamp
        session_manager.remove_session("session_1")
        session_manager.add_session("session_1", "Cursor", "192.168.1.100")

        second_time = session_manager.get_session_info("session_1")["connected_at"]

        # Should have new connection time
        assert second_time >= first_time

    def test_get_all_sessions_returns_copy(self, session_manager):
        """Test that get_all_sessions returns safe copy"""
        session_manager.add_session("session_1", "Cursor", "192.168.1.100")

        sessions = session_manager.get_all_sessions()

        # Modify returned list shouldn't affect internal state
        sessions.clear()

        assert session_manager.get_active_sessions_count() == 1

    def test_session_with_no_ip(self, session_manager):
        """Test adding session without IP address"""
        session_manager.add_session("session_1", "Cursor", None)

        info = session_manager.get_session_info("session_1")

        assert info["client_ip"] is None

    def test_session_with_unknown_client(self, session_manager):
        """Test adding session with unknown client type"""
        session_manager.add_session("session_1", "UnknownIDE", "192.168.1.100")

        info = session_manager.get_session_info("session_1")

        assert info["client_name"] == "UnknownIDE"

    def test_multiple_removes_same_session(self, session_manager):
        """Test removing same session multiple times"""
        session_manager.add_session("session_1", "Cursor", "192.168.1.100")

        session_manager.remove_session("session_1")
        assert session_manager.get_active_sessions_count() == 0

        # Second remove should not error
        session_manager.remove_session("session_1")
        assert session_manager.get_active_sessions_count() == 0
