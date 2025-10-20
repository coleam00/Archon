"""
Unit tests for agent_chat_api.py
"""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from src.server.main import app


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


def test_create_session_success(client):
    """Test successful chat session creation."""
    response = client.post(
        "/api/agent-chat/sessions",
        json={"project_id": "test-project", "agent_type": "rag"}
    )

    assert response.status_code == 200
    data = response.json()
    assert "session_id" in data
    assert len(data["session_id"]) > 0


def test_create_session_default_agent_type(client):
    """Test session creation with default agent type."""
    response = client.post(
        "/api/agent-chat/sessions",
        json={}
    )

    assert response.status_code == 200
    data = response.json()
    assert "session_id" in data


def test_get_session_success(client):
    """Test getting an existing session."""
    # Create session first
    create_response = client.post(
        "/api/agent-chat/sessions",
        json={"agent_type": "rag"}
    )
    session_id = create_response.json()["session_id"]

    # Get session
    response = client.get(f"/api/agent-chat/sessions/{session_id}")

    assert response.status_code == 200
    data = response.json()
    assert data["session_id"] == session_id
    assert data["agent_type"] == "rag"
    assert "messages" in data
    assert "created_at" in data


def test_get_session_not_found(client):
    """Test getting a non-existent session."""
    response = client.get("/api/agent-chat/sessions/nonexistent-session-id")

    assert response.status_code == 404
    assert "Session not found" in response.json()["detail"]


def test_get_messages_success(client):
    """Test getting messages for a session."""
    # Create session
    create_response = client.post(
        "/api/agent-chat/sessions",
        json={"agent_type": "rag"}
    )
    session_id = create_response.json()["session_id"]

    # Get messages
    response = client.get(f"/api/agent-chat/sessions/{session_id}/messages")

    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) == 0  # No messages yet


def test_get_messages_session_not_found(client):
    """Test getting messages for non-existent session."""
    response = client.get("/api/agent-chat/sessions/nonexistent/messages")

    assert response.status_code == 404


def test_send_message_success(client):
    """Test sending a message to a session."""
    # Create session
    create_response = client.post(
        "/api/agent-chat/sessions",
        json={"agent_type": "rag"}
    )
    session_id = create_response.json()["session_id"]

    # Send message
    response = client.post(
        f"/api/agent-chat/sessions/{session_id}/messages",
        json={"message": "What is Python?"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "sent"

    # Verify message was stored
    messages_response = client.get(f"/api/agent-chat/sessions/{session_id}/messages")
    messages = messages_response.json()
    assert len(messages) == 1
    assert messages[0]["content"] == "What is Python?"
    assert messages[0]["sender"] == "user"


def test_send_message_session_not_found(client):
    """Test sending message to non-existent session."""
    response = client.post(
        "/api/agent-chat/sessions/nonexistent/messages",
        json={"message": "Hello"}
    )

    assert response.status_code == 404


def test_send_empty_message(client):
    """Test sending an empty message."""
    # Create session
    create_response = client.post(
        "/api/agent-chat/sessions",
        json={"agent_type": "rag"}
    )
    session_id = create_response.json()["session_id"]

    # Send empty message
    response = client.post(
        f"/api/agent-chat/sessions/{session_id}/messages",
        json={"message": ""}
    )

    assert response.status_code == 200
    # Message is still stored, even if empty
    messages = client.get(f"/api/agent-chat/sessions/{session_id}/messages").json()
    assert len(messages) == 1
