"""Tests for Workflow Service

Tests CRUD operations and validation for step and workflow templates.
"""

from unittest.mock import MagicMock, patch

import pytest

from src.server.models.template_models import CreateStepTemplateRequest, CreateWorkflowTemplateRequest
from src.server.services.workflow_service import ValidationError, WorkflowService


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
def workflow_service(mock_supabase_client):
    """Workflow service with mocked client"""
    with patch("src.server.services.workflow_service.get_supabase_client", return_value=mock_supabase_client):
        service = WorkflowService()
        return service


@pytest.mark.unit
def test_validate_sub_steps_valid(workflow_service):
    """Test validation with valid sub-steps"""
    sub_steps = [
        {
            "order": 1,
            "name": "Step 1",
            "agent_template_slug": "agent-1",
            "prompt_template": "Do step 1",
            "required": True,
        },
        {
            "order": 2,
            "name": "Step 2",
            "agent_template_slug": "agent-2",
            "prompt_template": "Do step 2",
            "required": False,
        },
    ]

    # Should not raise
    workflow_service._validate_sub_steps(sub_steps)


@pytest.mark.unit
def test_validate_sub_steps_missing_field(workflow_service):
    """Test validation with missing required field"""
    sub_steps = [{"order": 1, "name": "Step 1"}]  # Missing agent_template_slug, prompt_template, required

    with pytest.raises(ValidationError, match="missing required field"):
        workflow_service._validate_sub_steps(sub_steps)


@pytest.mark.unit
def test_validate_sub_steps_duplicate_order(workflow_service):
    """Test validation with duplicate order values"""
    sub_steps = [
        {
            "order": 1,
            "name": "Step 1",
            "agent_template_slug": "agent-1",
            "prompt_template": "Test",
            "required": True,
        },
        {
            "order": 1,
            "name": "Step 2",
            "agent_template_slug": "agent-2",
            "prompt_template": "Test",
            "required": True,
        },
    ]

    with pytest.raises(ValidationError, match="unique order"):
        workflow_service._validate_sub_steps(sub_steps)


@pytest.mark.unit
def test_validate_workflow_steps_valid(workflow_service):
    """Test validation with valid workflow steps"""
    steps = [
        {"step_type": "planning", "order": 1, "step_template_slug": "plan"},
        {"step_type": "implement", "order": 2, "step_template_slug": "impl"},
        {"step_type": "validate", "order": 3, "step_template_slug": "val"},
    ]

    # Should not raise
    workflow_service._validate_workflow_steps(steps)


@pytest.mark.unit
def test_validate_workflow_steps_missing_required_type(workflow_service):
    """Test validation with missing required step type"""
    steps = [
        {"step_type": "planning", "order": 1, "step_template_slug": "plan"},
        # Missing implement and validate
    ]

    with pytest.raises(ValidationError, match="missing required step types"):
        workflow_service._validate_workflow_steps(steps)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_create_step_template(workflow_service, mock_supabase_client):
    """Test creating step template"""
    mock_supabase_client.execute.side_effect = [
        MagicMock(data=[]),  # Slug check
        MagicMock(
            data=[
                {
                    "id": "uuid-step",
                    "step_type": "planning",
                    "slug": "new-step",
                    "name": "New Step",
                    "description": None,
                    "prompt_template": "Do something",
                    "agent_template_id": "agent-uuid",
                    "sub_steps": [],
                    "metadata": {},
                    "is_active": True,
                    "version": 1,
                    "parent_template_id": None,
                    "created_by": None,
                    "created_at": "2024-01-01T00:00:00+00:00",
                    "updated_at": "2024-01-01T00:00:00+00:00",
                }
            ]
        ),
    ]

    request = CreateStepTemplateRequest(
        step_type="planning", slug="new-step", name="New Step", prompt_template="Do something", agent_template_id="agent-uuid"
    )

    template = await workflow_service.create_step_template(request)

    assert template.slug == "new-step"
    assert template.step_type == "planning"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_create_workflow_template(workflow_service, mock_supabase_client):
    """Test creating workflow template"""
    mock_supabase_client.execute.side_effect = [
        MagicMock(data=[]),  # Slug check
        MagicMock(
            data=[
                {
                    "id": "uuid-workflow",
                    "slug": "new-workflow",
                    "name": "New Workflow",
                    "description": None,
                    "steps": [
                        {"step_type": "planning", "order": 1, "step_template_slug": "plan"},
                        {"step_type": "implement", "order": 2, "step_template_slug": "impl"},
                        {"step_type": "validate", "order": 3, "step_template_slug": "val"},
                    ],
                    "metadata": {},
                    "is_active": True,
                    "created_by": None,
                    "created_at": "2024-01-01T00:00:00+00:00",
                    "updated_at": "2024-01-01T00:00:00+00:00",
                }
            ]
        ),
    ]

    request = CreateWorkflowTemplateRequest(
        slug="new-workflow",
        name="New Workflow",
        steps=[
            {"step_type": "planning", "order": 1, "step_template_slug": "plan"},
            {"step_type": "implement", "order": 2, "step_template_slug": "impl"},
            {"step_type": "validate", "order": 3, "step_template_slug": "val"},
        ],
    )

    template = await workflow_service.create_workflow_template(request)

    assert template.slug == "new-workflow"
    assert len(template.steps) == 3
