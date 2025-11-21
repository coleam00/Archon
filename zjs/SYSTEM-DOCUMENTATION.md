# Archon System Documentation: Modification & Extension Guide

## Table of Contents
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Development Workflows](#development-workflows)
- [Adding New Features](#adding-new-features)
- [Modifying Existing Features](#modifying-existing-features)
- [API Development](#api-development)
- [Frontend Development](#frontend-development)
- [Database Modifications](#database-modifications)
- [MCP Tool Development](#mcp-tool-development)
- [AI Agent Development](#ai-agent-development)
- [Testing Guide](#testing-guide)
- [Common Development Tasks](#common-development-tasks)
- [Troubleshooting](#troubleshooting)
- [Best Practices](#best-practices)

---

## Getting Started

### Prerequisites

#### Required Software
- **Docker** 20.10+ and **Docker Compose** 2.0+
- **Node.js** 18+ and **npm** 9+
- **Python** 3.12+
- **uv** (Python package manager): `pip install uv`
- **Git** 2.0+

#### Required Accounts
- **Supabase** account with a project created
- **OpenAI** API key (for embeddings)
- **Anthropic** API key (optional, for AI agents)
- **GitHub** account (optional, for work orders)

### Initial Setup

#### 1. Clone Repository

```bash
git clone https://github.com/coleam00/Archon.git
cd Archon
```

#### 2. Configure Environment

```bash
# Copy example environment file
cp python/.env.example python/.env

# Edit with your credentials
nano python/.env
```

**Required Variables**:
```bash
# Supabase (REQUIRED)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key-here  # NOT anon key!

# OpenAI (for embeddings)
OPENAI_API_KEY=sk-...

# Optional
ANTHROPIC_API_KEY=sk-ant-...
LOGFIRE_TOKEN=...
GITHUB_PAT_TOKEN=ghp_...
CLAUDE_CODE_OAUTH_TOKEN=...
```

**Important**: You MUST use a Supabase **service key** (starts with `eyJ...` and has `service_role` in payload), NOT the anon key. The system validates this at startup.

#### 3. Run Database Migrations

```bash
# Apply migrations to your Supabase database
# Option 1: Using Supabase CLI
supabase db push

# Option 2: Manual (copy SQL to Supabase SQL editor)
# Navigate to: https://app.supabase.com/project/YOUR_PROJECT/sql
# Run: migration/complete_setup.sql
```

#### 4. Install Dependencies

**Frontend**:
```bash
cd archon-ui-main
npm install
cd ..
```

**Backend** (if running locally):
```bash
cd python
uv sync --group all
cd ..
```

#### 5. Start Development Environment

**Recommended: Hybrid Mode** (backend in Docker, frontend local):
```bash
make dev
```

**Alternative: Full Docker**:
```bash
make dev-docker
```

**Alternative: All Local** (3 terminals):
```bash
# Terminal 1: Backend
cd python
uv run python -m uvicorn src.server.main:app --port 8181 --reload

# Terminal 2: Frontend
cd archon-ui-main
npm run dev

# Terminal 3: Agent Work Orders (optional)
cd python
uv run python -m uvicorn src.agent_work_orders.server:app --port 8053 --reload
```

#### 6. Verify Setup

**Check Services**:
```bash
# Frontend
curl http://localhost:3737

# Backend API
curl http://localhost:8181/health

# MCP Server
curl http://localhost:8051/health

# Agents (if running)
curl http://localhost:8052/health
```

**Check Database**:
```bash
# Query Supabase
curl "https://your-project.supabase.co/rest/v1/sources" \
  -H "apikey: YOUR_SERVICE_KEY" \
  -H "Authorization: Bearer YOUR_SERVICE_KEY"
```

---

## Development Setup

### IDE Configuration

#### VS Code Recommended Extensions

```json
// .vscode/extensions.json
{
  "recommendations": [
    "dbaeumer.vscode-eslint",
    "biomejs.biome",
    "bradlc.vscode-tailwindcss",
    "ms-python.python",
    "ms-python.vscode-pylance",
    "charliermarsh.ruff",
    "GitHub.copilot"
  ]
}
```

#### VS Code Settings

```json
// .vscode/settings.json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "biomejs.biome",
  "[python]": {
    "editor.defaultFormatter": "charliermarsh.ruff",
    "editor.codeActionsOnSave": {
      "source.organizeImports": true
    }
  },
  "python.linting.enabled": true,
  "python.linting.ruffEnabled": true,
  "tailwindCSS.experimental.classRegex": [
    ["cva\\(([^)]*)\\)", "[\"'`]([^\"'`]*).*?[\"'`]"]
  ]
}
```

### Environment Variables Reference

**Full list** (see `python/.env.example` for complete documentation):

```bash
# Database (REQUIRED)
SUPABASE_URL=
SUPABASE_SERVICE_KEY=

# LLM Providers
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434

# Logging
LOGFIRE_TOKEN=
LOG_LEVEL=INFO  # DEBUG, INFO, WARNING, ERROR

# GitHub Integration
GITHUB_PAT_TOKEN=
GITHUB_REPO=coleam00/Archon  # Override default

# Claude Code CLI (for agent work orders)
CLAUDE_CODE_OAUTH_TOKEN=

# Service Ports
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_AGENTS_PORT=8052
AGENT_WORK_ORDERS_PORT=8053
ARCHON_UI_PORT=3737

# Service URLs (for Docker)
ARCHON_SERVER_URL=http://archon-server:8181
ARCHON_MCP_URL=http://archon-mcp:8051

# RAG Configuration
RAG_CONTEXTUAL_EMBEDDINGS_ENABLED=false
RAG_RERANKING_ENABLED=false

# Agent Work Orders
STATE_STORAGE_TYPE=supabase  # or 'file'
```

---

## Development Workflows

### Making Changes: The Flow

1. **Create Branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make Changes** (see specific guides below)

3. **Run Linters**
   ```bash
   make lint
   # Or separately:
   make lint-fe  # Frontend
   make lint-be  # Backend
   ```

4. **Run Tests**
   ```bash
   make test
   # Or separately:
   make test-fe  # Frontend
   make test-be  # Backend
   ```

5. **Commit Changes**
   ```bash
   git add .
   git commit -m "feat: add your feature"
   ```

6. **Push & Create PR**
   ```bash
   git push origin feature/your-feature-name
   # Create PR on GitHub
   ```

### Hot Reload Development

**Frontend** (automatic):
- Vite watches for changes
- Browser refreshes automatically
- Fast HMR (Hot Module Replacement)

**Backend** (with `--reload` flag):
```bash
# In Docker: already configured
# Local:
uvicorn src.server.main:app --reload
```

Changes to Python files trigger automatic restart.

### Debugging

#### Frontend Debugging

**Browser DevTools**:
```javascript
// Add breakpoints in Chrome DevTools
// Or use debugger statement
debugger;
```

**TanStack Query DevTools**:
```typescript
// Already configured in App.tsx
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

<ReactQueryDevtools initialIsOpen={false} />
```

Access at: `http://localhost:3737` (bottom-left icon)

#### Backend Debugging

**Python Debugger**:
```python
# Add to code
import pdb; pdb.set_trace()

# Or use breakpoint()
breakpoint()
```

**Logging**:
```python
from ..config.logfire_config import get_logger

logger = get_logger(__name__)

logger.debug("Debug message")
logger.info("Info message")
logger.warning("Warning message")
logger.error("Error message", exc_info=True)
```

**View Logs**:
```bash
# Docker
docker compose logs -f archon-server

# Local
# Logs appear in terminal
```

---

## Adding New Features

### End-to-End Feature Addition

Let's walk through adding a complete feature: **Comments on Tasks**.

#### Step 1: Database Schema

**File**: `migration/0.1.0/017_add_task_comments.sql`

```sql
-- Create comments table
CREATE TABLE IF NOT EXISTS archon_task_comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id UUID NOT NULL REFERENCES archon_tasks(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX archon_task_comments_task_id_idx ON archon_task_comments(task_id);
CREATE INDEX archon_task_comments_created_at_idx ON archon_task_comments(created_at);
```

**Apply Migration**:
```bash
# Run SQL in Supabase SQL editor
# Or using Supabase CLI:
supabase db push
```

#### Step 2: Backend API

**A. Create Service**

**File**: `python/src/server/services/projects/comment_service.py`

```python
from typing import Optional
from uuid import UUID
from ..client_manager import SupabaseClientManager
from ...config.logfire_config import get_logger

logger = get_logger(__name__)

class CommentService:
    def __init__(self):
        self.supabase = SupabaseClientManager.get_client()

    async def list_comments_for_task(self, task_id: UUID) -> list[dict]:
        """Get all comments for a task"""
        logger.info(f"Listing comments for task {task_id}")

        response = await self.supabase.table("archon_task_comments") \
            .select("*") \
            .eq("task_id", str(task_id)) \
            .order("created_at", desc=False) \
            .execute()

        return response.data

    async def create_comment(
        self,
        task_id: UUID,
        author: str,
        content: str
    ) -> dict:
        """Create a new comment"""
        logger.info(f"Creating comment on task {task_id} by {author}")

        comment_data = {
            "task_id": str(task_id),
            "author": author,
            "content": content
        }

        response = await self.supabase.table("archon_task_comments") \
            .insert(comment_data) \
            .execute()

        return response.data[0]

    async def update_comment(
        self,
        comment_id: UUID,
        content: str
    ) -> dict:
        """Update a comment"""
        logger.info(f"Updating comment {comment_id}")

        response = await self.supabase.table("archon_task_comments") \
            .update({"content": content, "updated_at": "now()"}) \
            .eq("id", str(comment_id)) \
            .execute()

        return response.data[0]

    async def delete_comment(self, comment_id: UUID) -> None:
        """Delete a comment"""
        logger.info(f"Deleting comment {comment_id}")

        await self.supabase.table("archon_task_comments") \
            .delete() \
            .eq("id", str(comment_id)) \
            .execute()

# Singleton
comment_service = CommentService()
```

**B. Create API Routes**

**File**: `python/src/server/api_routes/comments_api.py`

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from uuid import UUID
from ..services.projects.comment_service import comment_service
from ..utils.etag_utils import generate_etag
from fastapi import Request, Response
import json

router = APIRouter(prefix="/api/tasks", tags=["comments"])

# Request/Response Models
class CreateCommentRequest(BaseModel):
    author: str
    content: str

class UpdateCommentRequest(BaseModel):
    content: str

class CommentResponse(BaseModel):
    id: UUID
    task_id: UUID
    author: str
    content: str
    created_at: str
    updated_at: str

# Routes
@router.get("/{task_id}/comments", response_model=list[CommentResponse])
async def list_comments(task_id: UUID, request: Request):
    """Get all comments for a task (with ETag support)"""
    try:
        comments = await comment_service.list_comments_for_task(task_id)

        # ETag support
        from ..utils.etag_utils import check_etag
        if check_etag(request, comments):
            return Response(status_code=304)

        etag = generate_etag(comments)
        return Response(
            content=json.dumps(comments, default=str),
            media_type="application/json",
            headers={"ETag": etag}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/{task_id}/comments", response_model=CommentResponse)
async def create_comment(task_id: UUID, request: CreateCommentRequest):
    """Create a new comment"""
    try:
        comment = await comment_service.create_comment(
            task_id=task_id,
            author=request.author,
            content=request.content
        )
        return comment
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/comments/{comment_id}", response_model=CommentResponse)
async def update_comment(comment_id: UUID, request: UpdateCommentRequest):
    """Update a comment"""
    try:
        comment = await comment_service.update_comment(
            comment_id=comment_id,
            content=request.content
        )
        return comment
    except Exception as e:
        raise HTTPException(status_code=404, detail="Comment not found")

@router.delete("/comments/{comment_id}", status_code=204)
async def delete_comment(comment_id: UUID):
    """Delete a comment"""
    try:
        await comment_service.delete_comment(comment_id)
        return Response(status_code=204)
    except Exception as e:
        raise HTTPException(status_code=404, detail="Comment not found")
```

**C. Register Router**

**File**: `python/src/server/main.py`

```python
# Add import
from .api_routes.comments_api import router as comments_router

# Add router
app.include_router(comments_router)
```

#### Step 3: Frontend Implementation

**A. Create Types**

**File**: `archon-ui-main/src/features/projects/tasks/types/comment.ts`

```typescript
export interface Comment {
  id: string;
  task_id: string;
  author: string;
  content: string;
  created_at: string;
  updated_at: string;
  _localId?: string;  // For optimistic updates
  _optimistic?: boolean;
}

export interface CreateCommentRequest {
  author: string;
  content: string;
}

export interface UpdateCommentRequest {
  content: string;
}
```

**B. Create Service**

**File**: `archon-ui-main/src/features/projects/tasks/services/commentService.ts`

```typescript
import { callAPIWithETag } from "@/features/shared/api/apiClient";
import type { Comment, CreateCommentRequest, UpdateCommentRequest } from "../types/comment";

export const commentService = {
  async listComments(taskId: string): Promise<Comment[]> {
    return callAPIWithETag(`/api/tasks/${taskId}/comments`);
  },

  async createComment(
    taskId: string,
    request: CreateCommentRequest
  ): Promise<Comment> {
    return callAPIWithETag(`/api/tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },

  async updateComment(
    commentId: string,
    request: UpdateCommentRequest
  ): Promise<Comment> {
    return callAPIWithETag(`/api/tasks/comments/${commentId}`, {
      method: "PUT",
      body: JSON.stringify(request),
    });
  },

  async deleteComment(commentId: string): Promise<void> {
    return callAPIWithETag(`/api/tasks/comments/${commentId}`, {
      method: "DELETE",
    });
  },
};
```

**C. Create Query Hooks**

**File**: `archon-ui-main/src/features/projects/tasks/hooks/useCommentQueries.ts`

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { commentService } from "../services/commentService";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "@/features/shared/config/queryPatterns";
import { createOptimisticEntity, replaceOptimisticEntity } from "@/features/shared/utils/optimistic";
import type { Comment, CreateCommentRequest, UpdateCommentRequest } from "../types/comment";

// Query Key Factory
export const commentKeys = {
  all: ["comments"] as const,
  byTask: (taskId: string) => ["tasks", taskId, "comments"] as const,
};

// Query Hooks
export function useComments(taskId: string | undefined) {
  return useQuery({
    queryKey: taskId ? commentKeys.byTask(taskId) : DISABLED_QUERY_KEY,
    queryFn: () => commentService.listComments(taskId!),
    enabled: !!taskId,
    staleTime: STALE_TIMES.normal,
  });
}

// Mutation Hooks
export function useCreateComment(taskId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: CreateCommentRequest) =>
      commentService.createComment(taskId, request),

    onMutate: async (newComment) => {
      await queryClient.cancelQueries({ queryKey: commentKeys.byTask(taskId) });

      const previous = queryClient.getQueryData(commentKeys.byTask(taskId));

      const optimisticComment = createOptimisticEntity<Comment>({
        ...newComment,
        task_id: taskId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      queryClient.setQueryData(commentKeys.byTask(taskId), (old: Comment[] = []) =>
        [...old, optimisticComment]
      );

      return { previous, localId: optimisticComment._localId };
    },

    onError: (err, variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(commentKeys.byTask(taskId), context.previous);
      }
    },

    onSuccess: (data, variables, context) => {
      queryClient.setQueryData(commentKeys.byTask(taskId), (old: Comment[] = []) =>
        replaceOptimisticEntity(old, context?.localId, data)
      );
    },
  });
}

export function useUpdateComment(taskId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ commentId, request }: { commentId: string; request: UpdateCommentRequest }) =>
      commentService.updateComment(commentId, request),

    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: commentKeys.byTask(taskId) });
    },
  });
}

export function useDeleteComment(taskId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (commentId: string) => commentService.deleteComment(commentId),

    onMutate: async (commentId) => {
      await queryClient.cancelQueries({ queryKey: commentKeys.byTask(taskId) });

      const previous = queryClient.getQueryData(commentKeys.byTask(taskId));

      queryClient.setQueryData(commentKeys.byTask(taskId), (old: Comment[] = []) =>
        old.filter((c) => c.id !== commentId)
      );

      return { previous };
    },

    onError: (err, variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(commentKeys.byTask(taskId), context.previous);
      }
    },
  });
}
```

**D. Create UI Components**

**File**: `archon-ui-main/src/features/projects/tasks/components/CommentList.tsx`

```typescript
import React, { useState } from "react";
import { useComments, useCreateComment, useDeleteComment } from "../hooks/useCommentQueries";
import { Button } from "@/features/ui/primitives/button";
import { Textarea } from "@/features/ui/primitives/textarea";
import { Card, CardContent } from "@/features/ui/primitives/card";

interface CommentListProps {
  taskId: string;
  currentUser: string;
}

export function CommentList({ taskId, currentUser }: CommentListProps) {
  const [newComment, setNewComment] = useState("");
  const { data: comments = [], isLoading } = useComments(taskId);
  const createMutation = useCreateComment(taskId);
  const deleteMutation = useDeleteComment(taskId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;

    await createMutation.mutateAsync({
      author: currentUser,
      content: newComment,
    });

    setNewComment("");
  };

  if (isLoading) return <div>Loading comments...</div>;

  return (
    <div className="space-y-4">
      {/* Comment Form */}
      <form onSubmit={handleSubmit} className="space-y-2">
        <Textarea
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          placeholder="Add a comment..."
          className="w-full"
        />
        <Button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? "Posting..." : "Post Comment"}
        </Button>
      </form>

      {/* Comment List */}
      <div className="space-y-2">
        {comments.map((comment) => (
          <Card key={comment.id} className={comment._optimistic ? "opacity-50" : ""}>
            <CardContent className="p-4">
              <div className="flex justify-between items-start">
                <div>
                  <div className="font-semibold">{comment.author}</div>
                  <div className="text-sm text-gray-500">
                    {new Date(comment.created_at).toLocaleString()}
                  </div>
                </div>
                {comment.author === currentUser && !comment._optimistic && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteMutation.mutate(comment.id)}
                  >
                    Delete
                  </Button>
                )}
              </div>
              <div className="mt-2">{comment.content}</div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

**E. Integrate into Task Detail**

**File**: `archon-ui-main/src/features/projects/tasks/components/TaskEditModal.tsx`

```typescript
import { CommentList } from "./CommentList";

// Add to modal content
<div className="space-y-4">
  {/* Existing task fields... */}

  {/* Comments Section */}
  <div className="border-t pt-4">
    <h3 className="text-lg font-semibold mb-2">Comments</h3>
    <CommentList taskId={task.id} currentUser="User" />
  </div>
</div>
```

#### Step 4: Testing

**A. Backend Tests**

**File**: `python/tests/server/services/test_comment_service.py`

```python
import pytest
from uuid import uuid4
from src.server.services.projects.comment_service import comment_service

@pytest.mark.asyncio
async def test_create_comment(mock_supabase):
    task_id = uuid4()
    comment = await comment_service.create_comment(
        task_id=task_id,
        author="Test User",
        content="Test comment"
    )

    assert comment["author"] == "Test User"
    assert comment["content"] == "Test comment"

@pytest.mark.asyncio
async def test_list_comments(mock_supabase):
    task_id = uuid4()
    comments = await comment_service.list_comments_for_task(task_id)

    assert isinstance(comments, list)
```

**B. Frontend Tests**

**File**: `archon-ui-main/src/features/projects/tasks/hooks/tests/useCommentQueries.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useComments, useCreateComment } from "../useCommentQueries";
import { commentService } from "../../services/commentService";

vi.mock("../../services/commentService");

describe("useCommentQueries", () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("fetches comments", async () => {
    const mockComments = [{ id: "1", content: "Test" }];
    vi.mocked(commentService.listComments).mockResolvedValue(mockComments);

    const { result } = renderHook(() => useComments("task-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockComments);
  });

  it("creates comment with optimistic update", async () => {
    const { result } = renderHook(() => useCreateComment("task-1"), { wrapper });

    const newComment = { author: "User", content: "New comment" };
    await result.current.mutateAsync(newComment);

    expect(commentService.createComment).toHaveBeenCalledWith("task-1", newComment);
  });
});
```

#### Step 5: Documentation

Update relevant documentation:

```markdown
<!-- PRPs/ai_docs/API_NAMING_CONVENTIONS.md -->

## Task Comments

**Endpoints**:
- `GET /api/tasks/{task_id}/comments` - List comments
- `POST /api/tasks/{task_id}/comments` - Create comment
- `PUT /api/tasks/comments/{comment_id}` - Update comment
- `DELETE /api/tasks/comments/{comment_id}` - Delete comment

**Frontend Hooks**:
- `useComments(taskId)` - List query
- `useCreateComment(taskId)` - Creation mutation
- `useUpdateComment(taskId)` - Update mutation
- `useDeleteComment(taskId)` - Deletion mutation
```

---

## Modifying Existing Features

### Changing Database Schema

**Example: Add `priority` field to comments**

#### 1. Create Migration

**File**: `migration/0.1.0/018_add_comment_priority.sql`

```sql
-- Add priority column
ALTER TABLE archon_task_comments
ADD COLUMN priority INTEGER DEFAULT 0;

-- Add index
CREATE INDEX archon_task_comments_priority_idx
ON archon_task_comments(priority);
```

#### 2. Update Backend Types

**File**: `python/src/server/services/projects/comment_service.py`

```python
async def create_comment(
    self,
    task_id: UUID,
    author: str,
    content: str,
    priority: int = 0  # NEW
) -> dict:
    comment_data = {
        "task_id": str(task_id),
        "author": author,
        "content": content,
        "priority": priority  # NEW
    }
    # ... rest of code
```

#### 3. Update API Models

**File**: `python/src/server/api_routes/comments_api.py`

```python
class CreateCommentRequest(BaseModel):
    author: str
    content: str
    priority: int = 0  # NEW
```

#### 4. Update Frontend Types

**File**: `archon-ui-main/src/features/projects/tasks/types/comment.ts`

```typescript
export interface Comment {
  id: string;
  task_id: string;
  author: string;
  content: string;
  priority: number;  // NEW
  created_at: string;
  updated_at: string;
}

export interface CreateCommentRequest {
  author: string;
  content: string;
  priority?: number;  // NEW
}
```

#### 5. Update UI

**File**: `archon-ui-main/src/features/projects/tasks/components/CommentList.tsx`

```typescript
// Add priority selector
<Select value={String(priority)} onValueChange={(v) => setPriority(Number(v))}>
  <SelectTrigger>
    <SelectValue />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="0">Low</SelectItem>
    <SelectItem value="1">Medium</SelectItem>
    <SelectItem value="2">High</SelectItem>
  </SelectContent>
</Select>
```

---

## API Development

### Adding New Endpoint

**Example: Bulk delete comments**

#### 1. Add Service Method

**File**: `python/src/server/services/projects/comment_service.py`

```python
async def bulk_delete_comments(self, comment_ids: list[UUID]) -> int:
    """Delete multiple comments"""
    logger.info(f"Bulk deleting {len(comment_ids)} comments")

    response = await self.supabase.table("archon_task_comments") \
        .delete() \
        .in_("id", [str(cid) for cid in comment_ids]) \
        .execute()

    return len(response.data)
```

#### 2. Add API Route

**File**: `python/src/server/api_routes/comments_api.py`

```python
class BulkDeleteRequest(BaseModel):
    comment_ids: list[UUID]

@router.delete("/comments/bulk", status_code=200)
async def bulk_delete_comments(request: BulkDeleteRequest):
    """Delete multiple comments"""
    try:
        deleted_count = await comment_service.bulk_delete_comments(request.comment_ids)
        return {"deleted": deleted_count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
```

#### 3. Test Endpoint

```bash
curl -X DELETE http://localhost:8181/api/tasks/comments/bulk \
  -H "Content-Type: application/json" \
  -d '{"comment_ids": ["uuid1", "uuid2"]}'
```

### Implementing Streaming Endpoint

**Example: Streaming task generation**

```python
from fastapi import StreamingResponse
from typing import AsyncGenerator

@router.post("/tasks/generate-stream")
async def generate_tasks_stream(project_id: UUID) -> StreamingResponse:
    """Generate tasks with streaming"""

    async def event_generator() -> AsyncGenerator[str, None]:
        # Simulate task generation
        for i in range(5):
            task = await generate_task(project_id, i)
            yield f"data: {json.dumps(task)}\n\n"
            await asyncio.sleep(1)

        yield "data: {\"type\": \"complete\"}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream"
    )
```

**Frontend Consumption**:
```typescript
const eventSource = new EventSource('/api/tasks/generate-stream');

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'complete') {
    eventSource.close();
  } else {
    // Add task to UI
    addTask(data);
  }
};
```

---

## Frontend Development

### Creating New UI Component

**Example: TaskPriorityBadge**

**File**: `archon-ui-main/src/features/projects/tasks/components/TaskPriorityBadge.tsx`

```typescript
import React from "react";
import { Badge } from "@/features/ui/primitives/badge";

interface TaskPriorityBadgeProps {
  priority: number;
  className?: string;
}

export function TaskPriorityBadge({ priority, className }: TaskPriorityBadgeProps) {
  const variants = {
    0: { label: "Low", variant: "secondary" as const },
    1: { label: "Medium", variant: "default" as const },
    2: { label: "High", variant: "destructive" as const },
  };

  const config = variants[priority] || variants[0];

  return (
    <Badge variant={config.variant} className={className}>
      {config.label}
    </Badge>
  );
}
```

**Usage**:
```typescript
<TaskPriorityBadge priority={task.priority} />
```

### Creating New Page

**Example: Analytics Page**

#### 1. Create Page Component

**File**: `archon-ui-main/src/pages/AnalyticsPage.tsx`

```typescript
import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/features/ui/primitives/card";

export function AnalyticsPage() {
  return (
    <div className="container mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Analytics</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Total Projects</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold">42</div>
          </CardContent>
        </Card>

        {/* More cards... */}
      </div>
    </div>
  );
}
```

#### 2. Add Route

**File**: `archon-ui-main/src/App.tsx`

```typescript
import { AnalyticsPage } from "@/pages/AnalyticsPage";

const router = createBrowserRouter([
  // ... existing routes
  { path: "/analytics", element: <AnalyticsPage /> },
]);
```

#### 3. Add Navigation

**File**: `archon-ui-main/src/components/Navigation.tsx`

```typescript
<Link to="/analytics" className="nav-link">
  Analytics
</Link>
```

### Using Radix UI Primitives

**Available Primitives** (`archon-ui-main/src/features/ui/primitives/`):
- Accordion
- Alert
- Avatar
- Badge
- Button
- Card
- Checkbox
- Dialog
- DropdownMenu
- Input
- Label
- Popover
- RadioGroup
- Select
- Separator
- Sheet
- Skeleton
- Switch
- Table
- Tabs
- Textarea
- Toast
- Tooltip

**Example: Creating a Modal**:

```typescript
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/features/ui/primitives/dialog";
import { Button } from "@/features/ui/primitives/button";

export function MyModal() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Open Modal</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Modal Title</DialogTitle>
        </DialogHeader>
        <div className="p-4">
          Modal content here
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

---

## Database Modifications

### Creating Migrations

#### Migration Naming Convention

```
{sequential_number}_{description}.sql

Examples:
001_add_source_url_display_name.sql
002_add_hybrid_search_tsvector.sql
017_add_task_comments.sql
```

#### Migration Template

```sql
-- {migration_number}_{description}.sql
-- Description: What this migration does

-- Add new table
CREATE TABLE IF NOT EXISTS new_table (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add indexes
CREATE INDEX new_table_name_idx ON new_table(name);

-- Add foreign keys
ALTER TABLE other_table
ADD COLUMN new_table_id UUID REFERENCES new_table(id) ON DELETE CASCADE;

-- Update existing data (if needed)
UPDATE existing_table SET new_column = default_value WHERE new_column IS NULL;

-- Record migration
INSERT INTO migration_tracking (version, name)
VALUES ('0.1.0', '{migration_number}_{description}');
```

#### Applying Migrations

**Option 1: Supabase Dashboard**
1. Navigate to SQL Editor in Supabase dashboard
2. Paste migration SQL
3. Run query

**Option 2: Supabase CLI**
```bash
# Initialize Supabase (first time only)
supabase init

# Link to your project
supabase link --project-ref YOUR_PROJECT_REF

# Push migrations
supabase db push
```

#### Rolling Back Migrations

**Create Rollback SQL**:

**File**: `migration/0.1.0/017_add_task_comments_rollback.sql`

```sql
-- Rollback: Remove task comments

DROP TABLE IF EXISTS archon_task_comments;

-- Remove from tracking
DELETE FROM migration_tracking
WHERE name = '017_add_task_comments';
```

### Working with Indexes

**When to Add Indexes**:
- Foreign keys (always)
- Frequently queried columns
- Columns used in WHERE, ORDER BY, JOIN

**Index Types**:
```sql
-- B-tree (default, good for equality and range)
CREATE INDEX idx_name ON table(column);

-- GIN (full-text search)
CREATE INDEX idx_tsvector ON table USING GIN(tsvector_column);

-- IVFFlat (vector search)
CREATE INDEX idx_embedding ON table USING ivfflat (embedding vector_cosine_ops);

-- Composite (multiple columns)
CREATE INDEX idx_composite ON table(column1, column2);

-- Partial (conditional)
CREATE INDEX idx_active ON table(column) WHERE active = true;
```

---

## MCP Tool Development

### Adding New MCP Tool

**Example: Search Tasks**

#### 1. Create Tool Function

**File**: `python/src/mcp_server/features/tasks/task_tools.py`

```python
from mcp.server.fastmcp import FastMCP
from typing import Optional
import httpx

mcp = FastMCP("Archon Task Tools")

# Initialize HTTP client
service_client = httpx.AsyncClient(
    base_url="http://archon-server:8181",
    timeout=30.0
)

@mcp.tool()
async def search_tasks(
    query: str,
    project_id: Optional[str] = None,
    status: Optional[str] = None
) -> list[dict]:
    """
    Search tasks with optional filters.

    Args:
        query: Search query string
        project_id: Optional project ID to filter by
        status: Optional status (todo, doing, review, done)

    Returns:
        List of matching tasks
    """
    params = {"query": query}
    if project_id:
        params["project_id"] = project_id
    if status:
        params["status"] = status

    response = await service_client.get("/api/tasks/search", params=params)
    response.raise_for_status()

    return response.json()
```

#### 2. Register Tool

**File**: `python/src/mcp_server/features/tasks/__init__.py`

```python
from .task_tools import mcp

__all__ = ["mcp"]
```

#### 3. Test Tool

**Via MCP UI** (`http://localhost:3737/mcp`):
1. Select tool: `archon:search_tasks`
2. Input parameters: `{"query": "bug fix"}`
3. Execute
4. Verify results

**Via Cursor/Windsurf**:
1. Configure MCP server in IDE
2. Use tool in AI chat:
   ```
   Find all tasks related to "authentication"
   ```
3. AI invokes: `archon:search_tasks(query="authentication")`

#### 4. Document Tool

Update MCP documentation:

```markdown
<!-- docs/MCP_TOOLS.md -->

### `archon:search_tasks`

Search tasks with optional filters.

**Parameters**:
- `query` (string, required): Search query
- `project_id` (string, optional): Filter by project
- `status` (string, optional): Filter by status (todo, doing, review, done)

**Returns**: Array of task objects

**Example**:
```json
{
  "query": "bug fix",
  "status": "todo"
}
```
```

---

## AI Agent Development

### Creating Custom Agent

**Example: Code Review Agent**

#### 1. Create Agent Class

**File**: `python/src/agents/code_review_agent.py`

```python
from pydantic_ai import Agent
from typing import AsyncIterator
import logging

logger = logging.getLogger(__name__)

class CodeReviewAgent:
    """Agent for code review tasks"""

    def __init__(self, model: str = "claude-3-5-sonnet-20241022"):
        self.agent = Agent(
            model=model,
            system_prompt="""You are an expert code reviewer.
            Analyze code for:
            - Security vulnerabilities
            - Performance issues
            - Code style violations
            - Best practice violations

            Provide actionable, specific feedback.
            """,
        )

    async def review_code(
        self,
        code: str,
        language: str,
        context: str = ""
    ) -> dict:
        """Review code and return findings"""
        logger.info(f"Reviewing {language} code")

        prompt = f"""Review this {language} code:

```{language}
{code}
```

Context: {context}

Provide your review in JSON format:
{{
  "security_issues": [],
  "performance_issues": [],
  "style_issues": [],
  "suggestions": []
}}
"""

        result = await self.agent.run(prompt)
        return result.data

    async def review_code_stream(
        self,
        code: str,
        language: str
    ) -> AsyncIterator[str]:
        """Review code with streaming response"""
        prompt = f"Review this {language} code:\n\n{code}"

        async for chunk in self.agent.run_stream(prompt):
            yield chunk.data

# Singleton
code_review_agent = CodeReviewAgent()
```

#### 2. Add API Endpoint

**File**: `python/src/agents/server.py`

```python
from fastapi import APIRouter
from .code_review_agent import code_review_agent
from pydantic import BaseModel

router = APIRouter(prefix="/api/agents", tags=["agents"])

class CodeReviewRequest(BaseModel):
    code: str
    language: str
    context: str = ""

@router.post("/code-review")
async def review_code(request: CodeReviewRequest):
    """Review code using AI agent"""
    result = await code_review_agent.review_code(
        code=request.code,
        language=request.language,
        context=request.context
    )
    return result

# Streaming endpoint
from fastapi.responses import StreamingResponse

@router.post("/code-review-stream")
async def review_code_stream(request: CodeReviewRequest):
    """Review code with streaming response"""

    async def event_generator():
        async for chunk in code_review_agent.review_code_stream(
            code=request.code,
            language=request.language
        ):
            yield f"data: {json.dumps({'chunk': chunk})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream"
    )
```

#### 3. Add MCP Tool Integration

```python
@mcp.tool()
async def review_code_with_ai(code: str, language: str) -> dict:
    """Review code using AI agent"""
    response = await agent_client.post(
        "/api/agents/code-review",
        json={"code": code, "language": language}
    )
    return response.json()
```

---

## Testing Guide

### Backend Testing

#### Unit Tests

**File**: `python/tests/server/services/test_comment_service.py`

```python
import pytest
from uuid import uuid4
from unittest.mock import AsyncMock, MagicMock
from src.server.services.projects.comment_service import CommentService

@pytest.fixture
def mock_supabase():
    """Mock Supabase client"""
    mock = MagicMock()
    mock.table.return_value.select.return_value.eq.return_value.execute = AsyncMock(
        return_value=MagicMock(data=[])
    )
    return mock

@pytest.fixture
def comment_service(mock_supabase):
    """Comment service with mocked Supabase"""
    service = CommentService()
    service.supabase = mock_supabase
    return service

@pytest.mark.asyncio
async def test_create_comment(comment_service, mock_supabase):
    """Test creating a comment"""
    task_id = uuid4()
    expected = {
        "id": str(uuid4()),
        "task_id": str(task_id),
        "author": "Test User",
        "content": "Test comment"
    }

    mock_supabase.table.return_value.insert.return_value.execute = AsyncMock(
        return_value=MagicMock(data=[expected])
    )

    result = await comment_service.create_comment(
        task_id=task_id,
        author="Test User",
        content="Test comment"
    )

    assert result["author"] == "Test User"
    assert result["content"] == "Test comment"
```

#### Integration Tests

```python
@pytest.mark.asyncio
@pytest.mark.integration
async def test_comment_api_flow():
    """Test full comment creation flow"""
    async with AsyncClient(app=app, base_url="http://test") as client:
        # Create comment
        response = await client.post(
            f"/api/tasks/{task_id}/comments",
            json={"author": "Test", "content": "Test comment"}
        )
        assert response.status_code == 200
        comment_id = response.json()["id"]

        # List comments
        response = await client.get(f"/api/tasks/{task_id}/comments")
        assert response.status_code == 200
        assert len(response.json()) == 1

        # Delete comment
        response = await client.delete(f"/api/tasks/comments/{comment_id}")
        assert response.status_code == 204
```

#### Running Tests

```bash
# All tests
cd python
uv run pytest

# Specific test file
uv run pytest tests/server/services/test_comment_service.py

# With coverage
uv run pytest --cov=src --cov-report=html

# Only integration tests
uv run pytest -m integration

# Verbose output
uv run pytest -v -s
```

### Frontend Testing

#### Component Tests

**File**: `archon-ui-main/src/features/projects/tasks/components/tests/CommentList.test.tsx`

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommentList } from "../CommentList";
import * as commentQueries from "../../hooks/useCommentQueries";

vi.mock("../../hooks/useCommentQueries");

describe("CommentList", () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("renders comments", async () => {
    const mockComments = [
      { id: "1", author: "User", content: "Test comment", created_at: new Date().toISOString() },
    ];

    vi.mocked(commentQueries.useComments).mockReturnValue({
      data: mockComments,
      isLoading: false,
    } as any);

    render(<CommentList taskId="task-1" currentUser="User" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Test comment")).toBeInTheDocument();
    });
  });

  it("creates comment on submit", async () => {
    const mockMutate = vi.fn();
    vi.mocked(commentQueries.useCreateComment).mockReturnValue({
      mutateAsync: mockMutate,
      isPending: false,
    } as any);

    render(<CommentList taskId="task-1" currentUser="User" />, { wrapper });

    const input = screen.getByPlaceholderText("Add a comment...");
    const submitButton = screen.getByText("Post Comment");

    await userEvent.type(input, "New comment");
    await userEvent.click(submitButton);

    expect(mockMutate).toHaveBeenCalledWith({
      author: "User",
      content: "New comment",
    });
  });
});
```

#### Running Tests

```bash
cd archon-ui-main

# All tests
npm run test

# Watch mode
npm run test

# UI mode
npm run test:ui

# Coverage
npm run test:coverage:stream

# Specific file
npx vitest run src/features/projects/tasks/components/tests/CommentList.test.tsx
```

---

## Common Development Tasks

### Adding a New Status to Tasks

**Example: Add "blocked" status**

#### 1. Update Database

```sql
-- No schema change needed (TEXT column)
-- Just update validation in application
```

#### 2. Update Backend Type

**File**: `python/src/server/services/projects/task_service.py`

```python
VALID_STATUSES = ["todo", "doing", "review", "done", "blocked"]  # Add "blocked"

def validate_status(status: str) -> bool:
    return status in VALID_STATUSES
```

#### 3. Update Frontend Type

**File**: `archon-ui-main/src/features/projects/tasks/types/task.ts`

```typescript
export type TaskStatus = "todo" | "doing" | "review" | "done" | "blocked";  // Add "blocked"
```

#### 4. Update UI

**File**: `archon-ui-main/src/features/projects/tasks/views/BoardView.tsx`

```typescript
const columns: TaskStatus[] = ["todo", "doing", "review", "done", "blocked"];  // Add column

const columnConfig = {
  // ... existing
  blocked: { title: "Blocked", color: "red" },  // Add config
};
```

### Enabling a Feature Flag

**Example: Enable agent work orders feature**

#### 1. Add Setting to Database

```sql
INSERT INTO archon_settings (key, value)
VALUES ('agent_work_orders_enabled', 'true');
```

#### 2. Add to Settings Context

**File**: `archon-ui-main/src/contexts/SettingsContext.tsx`

```typescript
interface Settings {
  projectsEnabled: boolean;
  agentWorkOrdersEnabled: boolean;  // Add
  // ...
}
```

#### 3. Conditionally Render UI

**File**: `archon-ui-main/src/App.tsx`

```typescript
const { settings } = useSettings();

{settings.agentWorkOrdersEnabled && (
  <>
    <Route path="/agent-work-orders" element={<AgentWorkOrdersPage />} />
  </>
)}
```

### Adding Environment Variable

#### 1. Add to .env.example

**File**: `python/.env.example`

```bash
# New Feature Configuration
NEW_FEATURE_ENABLED=false
NEW_FEATURE_API_KEY=your-key-here
```

#### 2. Load in Config

**File**: `python/src/server/config/config.py`

```python
def load_environment_config():
    # ... existing

    # New feature
    new_feature_enabled = os.getenv("NEW_FEATURE_ENABLED", "false").lower() == "true"
    new_feature_api_key = os.getenv("NEW_FEATURE_API_KEY")

    if new_feature_enabled and not new_feature_api_key:
        logger.warning("NEW_FEATURE_ENABLED is true but NEW_FEATURE_API_KEY is not set")

    return {
        # ... existing
        "new_feature_enabled": new_feature_enabled,
        "new_feature_api_key": new_feature_api_key,
    }
```

#### 3. Use in Code

```python
from ..config.config import load_environment_config

config = load_environment_config()

if config["new_feature_enabled"]:
    # Use feature
    api_key = config["new_feature_api_key"]
```

---

## Troubleshooting

### Common Issues

#### Issue: "Invalid Supabase key" on Startup

**Cause**: Using anon key instead of service key

**Solution**:
```bash
# In Supabase dashboard:
# Settings → API → Project API keys → service_role (secret)
# Copy the service_role key, NOT the anon key

# Update .env
SUPABASE_SERVICE_KEY=eyJ...  # Should start with eyJ
```

#### Issue: Frontend Can't Connect to Backend

**Cause**: Port mismatch or proxy misconfiguration

**Solution**:
```typescript
// Check vite.config.ts
server: {
  proxy: {
    '/api': {
      target: 'http://localhost:8181',  // Adjust if backend on different port
      changeOrigin: true,
    },
  },
},
```

#### Issue: TanStack Query Not Refetching

**Cause**: Stale time too long or query disabled

**Solution**:
```typescript
// Check staleTime
useQuery({
  queryKey: myKeys.detail(id),
  staleTime: STALE_TIMES.instant,  // Force fresh data
  refetchInterval: 5000,  // Poll every 5s
});

// Check enabled flag
enabled: !!id,  // Make sure condition is true
```

#### Issue: Database Migration Fails

**Cause**: Missing dependencies or circular references

**Solution**:
```sql
-- Ensure extensions are enabled first
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Check table creation order (foreign keys)
-- Parent tables must exist before children
```

#### Issue: Docker Container Crashes

**Cause**: Missing environment variables

**Solution**:
```bash
# Check logs
docker compose logs archon-server

# Verify .env file exists
ls python/.env

# Ensure all required vars are set
docker compose config  # Shows merged config
```

### Debugging Tips

#### Backend Debugging

```python
# Add detailed logging
logger.debug(f"Input: {input_data}")
logger.debug(f"Query result: {result}")

# Use breakpoint
breakpoint()

# Print stack trace
import traceback
logger.error(f"Error: {e}", exc_info=True)
```

#### Frontend Debugging

```typescript
// Log query state
const query = useMyQuery();
console.log("Query state:", {
  data: query.data,
  isLoading: query.isLoading,
  error: query.error,
  fetchStatus: query.fetchStatus,
});

// Check React Query DevTools
// Bottom-left panel shows all queries and their state
```

#### Network Debugging

```bash
# Check service health
curl http://localhost:8181/health
curl http://localhost:8051/health

# Test API endpoint
curl http://localhost:8181/api/projects

# Check with verbose output
curl -v http://localhost:8181/api/projects

# Test with ETag
curl -H "If-None-Match: \"abc123\"" http://localhost:8181/api/projects
```

---

## Best Practices

### Code Organization

#### Follow Vertical Slice Architecture

**Good**:
```
features/
  my-feature/
    components/
    hooks/
    services/
    types/
```

**Bad**:
```
components/
  MyFeatureComponent1.tsx
  MyFeatureComponent2.tsx
hooks/
  useMyFeature1.ts
  useMyFeature2.ts
```

#### Keep Files Focused

- **Single responsibility**: One component/service per file
- **Max 300 lines**: Split large files into smaller modules
- **Clear naming**: `TaskCard.tsx`, `useTaskQueries.ts`, `taskService.ts`

### API Design

#### Use RESTful Conventions

```
GET    /api/resources           # List
POST   /api/resources           # Create
GET    /api/resources/{id}      # Get one
PUT    /api/resources/{id}      # Update
DELETE /api/resources/{id}      # Delete
```

#### Return Consistent Shapes

```python
# Success
return {
  "id": "...",
  "data": {...},
  "created_at": "..."
}

# Error
return {
  "error": "Message",
  "detail": "Details",
  "statusCode": 400
}
```

### State Management

#### Use TanStack Query for Server State

**Good**:
```typescript
const { data: tasks } = useTasks();
```

**Bad**:
```typescript
const [tasks, setTasks] = useState([]);
useEffect(() => {
  fetch('/api/tasks').then(r => r.json()).then(setTasks);
}, []);
```

#### Use Query Key Factories

**Good**:
```typescript
const taskKeys = {
  all: ["tasks"] as const,
  lists: () => [...taskKeys.all, "list"] as const,
  detail: (id: string) => [...taskKeys.all, "detail", id] as const,
};
```

**Bad**:
```typescript
queryKey: ["tasks", id]  // Hard to maintain
```

### Error Handling

#### Backend: Fail Fast for Critical Errors

```python
# Critical: Crash immediately
if not supabase_key:
    raise ValueError("SUPABASE_SERVICE_KEY is required")

# Non-critical: Log and continue
try:
    optional_feature()
except Exception as e:
    logger.warning(f"Optional feature failed: {e}")
```

#### Frontend: Graceful Degradation

```typescript
const { data, error, isLoading } = useMyQuery();

if (isLoading) return <Spinner />;
if (error) return <ErrorMessage error={error} />;
if (!data) return <EmptyState />;

return <DataDisplay data={data} />;
```

### Testing

#### Test Behavior, Not Implementation

**Good**:
```typescript
it("creates task on submit", async () => {
  render(<TaskForm />);
  await userEvent.type(screen.getByLabelText("Title"), "New task");
  await userEvent.click(screen.getByText("Create"));
  expect(screen.getByText("Task created")).toBeInTheDocument();
});
```

**Bad**:
```typescript
it("calls createTask service", async () => {
  const spy = vi.spyOn(taskService, "createTask");
  // ... test implementation details
});
```

#### Mock at Service Boundaries

```typescript
// Mock the service, not HTTP
vi.mock("../../services/taskService");

// NOT: vi.mock("fetch")
```

### Performance

#### Use Optimistic Updates

```typescript
onMutate: async (newData) => {
  const optimistic = createOptimisticEntity(newData);
  queryClient.setQueryData(keys.lists(), (old) => [...old, optimistic]);
  return { localId: optimistic._localId };
},
```

#### Implement Smart Polling

```typescript
const refetchInterval = useSmartPolling(5000);  // Adapts to visibility
```

#### Use ETags for Caching

Already implemented in `apiClient.ts` - browser handles automatically.

### Security

#### Validate All Inputs

```python
# Backend
from pydantic import BaseModel, Field

class CreateTaskRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(max_length=5000)
```

#### Use Parameterized Queries

```python
# Good (Supabase client handles)
await supabase.table("tasks").select("*").eq("id", task_id).execute()

# Bad (SQL injection risk)
await supabase.rpc(f"SELECT * FROM tasks WHERE id = '{task_id}'")
```

#### Don't Expose Secrets

```python
# Backend: Never log secrets
logger.info(f"Using API key: {api_key}")  # BAD

# Frontend: Never hardcode secrets
const API_KEY = "sk-...";  # BAD
```

---

## Conclusion

This documentation covers the essential workflows for modifying and extending Archon:

1. **Setup**: Get development environment running
2. **Features**: Add complete features end-to-end
3. **Modifications**: Change existing functionality
4. **API**: Add new endpoints and services
5. **Frontend**: Build UI components and pages
6. **Database**: Create and apply migrations
7. **MCP**: Develop IDE integration tools
8. **Agents**: Build AI-powered features
9. **Testing**: Ensure quality and prevent regressions
10. **Best Practices**: Write maintainable, performant code

For questions or issues:
- Check troubleshooting section
- Review existing code examples
- Consult ARCHITECTURE.md for system design
- Refer to CLAUDE.md for development guidelines

Happy coding! 🚀
