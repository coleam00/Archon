import pytest
from fastapi.testclient import TestClient

@pytest.fixture
def test_client():
    """Create a test client for the agent chat router."""
    from fastapi import FastAPI
    from src.server.api_routes.agent_chat_api import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)

def test_create_session(test_client: TestClient):
    """Test creating a new chat session."""
    response = test_client.post("/api/agent-chat/sessions", json={})
    assert response.status_code == 200
    data = response.json()
    assert "session_id" in data
    assert isinstance(data["session_id"], str)

def test_get_session_not_found(test_client: TestClient):
    """Test getting a non-existent session."""
    response = test_client.get("/api/agent-chat/sessions/non-existent-id")
    assert response.status_code == 404

def test_send_and_get_messages(test_client: TestClient):
    """Test sending a message and then retrieving it."""
    # 1. Create a session
    create_res = test_client.post("/api/agent-chat/sessions", json={"agent_type": "test"})
    assert create_res.status_code == 200
    session_id = create_res.json()["session_id"]

    # 2. Send a message
    message_content = "Hello, agent!"
    send_res = test_client.post(
        f"/api/agent-chat/sessions/{session_id}/messages",
        json={"message": message_content}
    )
    assert send_res.status_code == 200
    assert send_res.json() == {"status": "sent"}

    # 3. Get messages and verify
    get_res = test_client.get(f"/api/agent-chat/sessions/{session_id}/messages")
    assert get_res.status_code == 200
    messages = get_res.json()
    assert isinstance(messages, list)
    assert len(messages) == 1
    assert messages[0]["content"] == message_content
    assert messages[0]["sender"] == "user"

def test_send_message_to_invalid_session(test_client: TestClient):
    """Test sending a message to a session that doesn't exist."""
    response = test_client.post(
        "/api/agent-chat/sessions/invalid-session-id/messages",
        json={"message": "This should fail"}
    )
    assert response.status_code == 404

def test_get_messages_for_invalid_session(test_client: TestClient):
    """Test getting messages for a session that doesn't exist."""
    response = test_client.get("/api/agent-chat/sessions/invalid-session-id/messages")
    assert response.status_code == 404
