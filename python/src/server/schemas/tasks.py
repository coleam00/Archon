from pydantic import BaseModel, Field
from typing import Any

# Server-side schemas for task create/update payloads.
# Enforces a strict 50,000 character limit for description per Beta Guidelines.

MAX_DESCRIPTION_LENGTH = 50_000


class TaskCreate(BaseModel):
    project_id: str
    title: str
    description: str | None = Field(default=None, max_length=MAX_DESCRIPTION_LENGTH)
    status: str | None = "todo"
    assignee: str | None = "User"
    task_order: int | None = 0
    feature: str | None = None


class TaskUpdate(BaseModel):
    title: str | None = None
    description: str | None = Field(default=None, max_length=MAX_DESCRIPTION_LENGTH)
    status: str | None = None
    assignee: str | None = None
    task_order: int | None = None
    feature: str | None = None

