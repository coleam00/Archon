"""Tests for Template Service

Tests CRUD operations and versioning for agent templates.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.models.template_models import AgentTemplate, CreateAgentTemplateRequest, UpdateAgentTemplateRequest
from src.server.services.template_service import (
    DuplicateTemplateError,
    TemplateNotFoundError,
    TemplateService,
)


@pytest.fixture
def mock_supabase_client():
    """Mock Supabase client"""
    client = MagicMock()
    client.table = MagicMock(return_value=client)
    client.select = MagicMock(return_value=client)
    client.eq = MagicMock(return_value=client)
    client.order = MagicMock(return_value=client)
    client.limit = MagicMock(return_value=client)
    client.insert = MagicMock(return_value=client)
    client.execute = MagicMock()
    return client


@pytest.fixture
def template_service(mock_supabase_client):
    """Template service with mocked client"""
    with patch("src.server.services.template_service.get_supabase_client", return_value=mock_supabase_client):
        service = TemplateService()
        return service


@pytest.mark.unit
@pytest.mark.asyncio
async def test_list_agent_templates(template_service, mock_supabase_client):
    """Test listing agent templates"""
    # Mock response
    mock_supabase_client.execute.return_value = MagicMock(
        data=[
            {
                "id": "uuid-1",
                "slug": "python-expert",
                "name": "Python Expert",
                "description": "Python specialist",
                "system_prompt": "You are a Python expert",
                "model": "sonnet",
                "temperature": 0.0,
                "tools": ["Read", "Write"],
                "standards": {},
                "metadata": {},
                "is_active": True,
                "version": 1,
                "parent_template_id": None,
                "created_by": None,
                "created_at": "2024-01-01T00:00:00+00:00",
                "updated_at": "2024-01-01T00:00:00+00:00",
            }
        ]
    )

    templates = await template_service.list_agent_templates()

    assert len(templates) == 1
    assert templates[0].slug == "python-expert"
    assert templates[0].name == "Python Expert"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_get_agent_template(template_service, mock_supabase_client):
    """Test getting specific agent template"""
    mock_supabase_client.execute.return_value = MagicMock(
        data=[
            {
                "id": "uuid-1",
                "slug": "python-expert",
                "name": "Python Expert",
                "description": "Python specialist",
                "system_prompt": "You are a Python expert",
                "model": "sonnet",
                "temperature": 0.0,
                "tools": ["Read", "Write"],
                "standards": {},
                "metadata": {},
                "is_active": True,
                "version": 1,
                "parent_template_id": None,
                "created_by": None,
                "created_at": "2024-01-01T00:00:00+00:00",
                "updated_at": "2024-01-01T00:00:00+00:00",
            }
        ]
    )

    template = await template_service.get_agent_template("python-expert")

    assert template.slug == "python-expert"
    assert template.version == 1


@pytest.mark.unit
@pytest.mark.asyncio
async def test_get_agent_template_not_found(template_service, mock_supabase_client):
    """Test getting non-existent template"""
    mock_supabase_client.execute.return_value = MagicMock(data=[])

    with pytest.raises(TemplateNotFoundError, match="Template not found"):
        await template_service.get_agent_template("nonexistent")


@pytest.mark.unit
@pytest.mark.asyncio
async def test_create_agent_template(template_service, mock_supabase_client):
    """Test creating agent template"""
    # Mock slug check (not exists)
    mock_supabase_client.execute.side_effect = [
        MagicMock(data=[]),  # Slug check
        MagicMock(
            data=[
                {
                    "id": "uuid-new",
                    "slug": "new-expert",
                    "name": "New Expert",
                    "description": "New specialist",
                    "system_prompt": "You are a new expert",
                    "model": "sonnet",
                    "temperature": 0.0,
                    "tools": ["Read"],
                    "standards": {},
                    "metadata": {},
                    "is_active": True,
                    "version": 1,
                    "parent_template_id": None,
                    "created_by": None,
                    "created_at": "2024-01-01T00:00:00+00:00",
                    "updated_at": "2024-01-01T00:00:00+00:00",
                }
            ]
        ),  # Insert
    ]

    request = CreateAgentTemplateRequest(
        slug="new-expert",
        name="New Expert",
        description="New specialist",
        system_prompt="You are a new expert",
        tools=["Read"],
    )

    template = await template_service.create_agent_template(request)

    assert template.slug == "new-expert"
    assert template.version == 1


@pytest.mark.unit
@pytest.mark.asyncio
async def test_create_agent_template_duplicate(template_service, mock_supabase_client):
    """Test creating template with duplicate slug"""
    # Mock slug check (exists)
    mock_supabase_client.execute.return_value = MagicMock(data=[{"id": "existing-uuid"}])

    request = CreateAgentTemplateRequest(slug="existing", name="Existing", system_prompt="Test")

    with pytest.raises(DuplicateTemplateError, match="already exists"):
        await template_service.create_agent_template(request)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_update_agent_template(template_service, mock_supabase_client):
    """Test updating agent template (creates new version)"""
    # Mock get (current template)
    current_template_data = {
        "id": "uuid-1",
        "slug": "python-expert",
        "name": "Python Expert",
        "description": "Python specialist",
        "system_prompt": "You are a Python expert",
        "model": "sonnet",
        "temperature": 0.0,
        "tools": ["Read", "Write"],
        "standards": {},
        "metadata": {},
        "is_active": True,
        "version": 1,
        "parent_template_id": None,
        "created_by": None,
        "created_at": "2024-01-01T00:00:00+00:00",
        "updated_at": "2024-01-01T00:00:00+00:00",
    }

    mock_supabase_client.execute.side_effect = [
        MagicMock(data=[current_template_data]),  # Get current
        MagicMock(
            data=[
                {
                    **current_template_data,
                    "id": "uuid-2",
                    "name": "Updated Expert",
                    "version": 2,
                    "parent_template_id": "uuid-1",
                }
            ]
        ),  # Insert new version
    ]

    request = UpdateAgentTemplateRequest(name="Updated Expert")

    template = await template_service.update_agent_template("python-expert", request)

    assert template.version == 2
    assert template.parent_template_id == "uuid-1"
    assert template.name == "Updated Expert"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_get_template_versions(template_service, mock_supabase_client):
    """Test getting all versions of a template"""
    mock_supabase_client.execute.return_value = MagicMock(
        data=[
            {
                "id": "uuid-2",
                "slug": "python-expert",
                "name": "Updated Expert",
                "description": None,
                "system_prompt": "Test",
                "model": "sonnet",
                "temperature": 0.0,
                "tools": [],
                "standards": {},
                "metadata": {},
                "is_active": True,
                "version": 2,
                "parent_template_id": "uuid-1",
                "created_by": None,
                "created_at": "2024-01-02T00:00:00+00:00",
                "updated_at": "2024-01-02T00:00:00+00:00",
            },
            {
                "id": "uuid-1",
                "slug": "python-expert",
                "name": "Python Expert",
                "description": None,
                "system_prompt": "Test",
                "model": "sonnet",
                "temperature": 0.0,
                "tools": [],
                "standards": {},
                "metadata": {},
                "is_active": True,
                "version": 1,
                "parent_template_id": None,
                "created_by": None,
                "created_at": "2024-01-01T00:00:00+00:00",
                "updated_at": "2024-01-01T00:00:00+00:00",
            },
        ]
    )

    templates = await template_service.get_template_versions("python-expert")

    assert len(templates) == 2
    assert templates[0].version == 2
    assert templates[1].version == 1
