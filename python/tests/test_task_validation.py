import pytest
from pydantic import ValidationError

from src.server.schemas.tasks import TaskUpdate, TaskCreate
from src.server.services.projects.task_service import TaskService

MAX_LEN = 50_000


@pytest.mark.asyncio
async def test_update_description_allows_boundary(mock_supabase_client):
    # Pydantic model should accept boundary value
    m = TaskUpdate(description="a" * MAX_LEN)
    assert m.description is not None and len(m.description) == MAX_LEN

    # Service should also accept and not error
    svc = TaskService(supabase_client=mock_supabase_client)
    ok, _ = await svc.update_task("abc123", {"description": "a" * MAX_LEN})
    # Note: we won't assert ok because mock update returns minimal data; just ensure no exception


@pytest.mark.asyncio
async def test_update_description_rejects_too_long(mock_supabase_client):
    # Pydantic model should reject
    with pytest.raises(ValidationError):
        TaskUpdate(description="a" * (MAX_LEN + 1))

    # Service should reject as well (fail fast)
    svc = TaskService(supabase_client=mock_supabase_client)
    ok, result = await svc.update_task("abc123", {"description": "a" * (MAX_LEN + 1)})
    assert ok is False
    assert "exceeds" in result.get("error", "")


@pytest.mark.asyncio
async def test_update_description_allows_null(mock_supabase_client):
    # Pydantic allows None
    m = TaskUpdate(description=None)
    assert m.description is None

    # Service should accept None
    svc = TaskService(supabase_client=mock_supabase_client)
    ok, _ = await svc.update_task("abc123", {"description": None})


def test_create_description_rejects_too_long():
    # Pydantic model should reject too long description on create
    with pytest.raises(ValidationError):
        TaskCreate(project_id="p1", title="t", description="a" * (MAX_LEN + 1))

