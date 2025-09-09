# API Error Contract Specification

## Unified Error Response Format

All error responses MUST follow this structure:

```json
{
  "detail": "Human-readable error message",
  "error_code": "MACHINE_READABLE_CODE",
  "context": {
    // Optional additional context data
  }
}
```

## Status Code Standards

### 400 Bad Request
- Invalid request syntax or malformed JSON
- Missing required query parameters
```json
{
  "detail": "Invalid request format",
  "error_code": "INVALID_REQUEST"
}
```

### 401 Unauthorized
- Missing or invalid authentication
```json
{
  "detail": "Authentication required",
  "error_code": "AUTH_REQUIRED"
}
```

### 403 Forbidden
- User authenticated but lacks permission for resource
- NEVER return 403 for non-existent resources (use 404 instead to avoid information leakage)
```json
{
  "detail": "Insufficient permissions",
  "error_code": "PERMISSION_DENIED"
}
```

### 404 Not Found
- Resource does not exist OR user has no access (security through obscurity)
- Use same message format whether resource doesn't exist or user lacks access
```json
{
  "detail": "Resource not found",
  "error_code": "RESOURCE_NOT_FOUND"
}
```

### 422 Unprocessable Entity
- Validation errors on request data
```json
{
  "detail": "Validation failed",
  "error_code": "VALIDATION_ERROR",
  "context": {
    "field": "description",
    "constraint": "max_length",
    "max_length": 50000,
    "provided_length": 55000
  }
}
```

### 500 Internal Server Error
- NEVER expose internal details
- Log full details server-side with correlation ID
```json
{
  "detail": "Internal server error",
  "error_code": "INTERNAL_ERROR",
  "context": {
    "request_id": "req_abc123"  // For support correlation only
  }
}
```

## Project Context Patterns

### Pattern 1: Hierarchical REST (RECOMMENDED)
```
GET /projects/{project_id}/tasks
POST /projects/{project_id}/tasks
GET /projects/{project_id}/tasks/{task_id}
```

**Advantages:**
- Clear resource hierarchy
- RESTful design
- Automatic project context validation

**Error Handling:**
- 404 if project doesn't exist or user lacks access
- 404 if task doesn't exist within project
- Never leak project existence via different error codes

### Pattern 2: Flat Resources with Query Parameter
```
GET /tasks?project_id={project_id}
POST /tasks (with project_id in body)
GET /tasks/{task_id}
```

**Advantages:**
- Simpler routing
- Task IDs globally unique

**Error Handling:**
- 400 if project_id missing when required
- 404 if project doesn't exist
- 404 if task doesn't exist

### Pattern 3: Authorization Scope (NOT RECOMMENDED for Beta)
```
Authorization: Bearer <token with project scope>
GET /tasks  // Returns only tasks for authorized projects
```

**Avoid in Beta:** Adds complexity without clear benefit

## Implementation Guidelines

### Python/FastAPI Example
```python
from fastapi import HTTPException, status
from typing import Optional, Dict, Any

class APIError(HTTPException):
    def __init__(
        self,
        status_code: int,
        error_code: str,
        detail: str,
        context: Optional[Dict[str, Any]] = None
    ):
        super().__init__(
            status_code=status_code,
            detail={
                "detail": detail,
                "error_code": error_code,
                "context": context or {}
            }
        )

# Usage examples:

# 404 - Resource not found
raise APIError(
    status_code=status.HTTP_404_NOT_FOUND,
    error_code="TASK_NOT_FOUND",
    detail="Task not found"
)

# 422 - Validation error
raise APIError(
    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
    error_code="TASK_DESCRIPTION_TOO_LONG",
    detail="Task description exceeds maximum length",
    context={
        "max_length": 50000,
        "provided_length": len(description)
    }
)

# 500 - Internal error (log details, don't expose)
import uuid
request_id = str(uuid.uuid4())
logger.error(f"Database connection failed | request_id={request_id}", exc_info=True)
raise APIError(
    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
    error_code="INTERNAL_ERROR",
    detail="Internal server error",
    context={"request_id": request_id}
)
```

### Error Code Naming Convention
- Format: `{RESOURCE}_{ACTION}_{REASON}`
- Examples:
  - `TASK_CREATE_INVALID_PROJECT`
  - `TASK_UPDATE_NOT_FOUND`
  - `TASK_DESCRIPTION_TOO_LONG`
  - `PROJECT_ACCESS_DENIED`

### Security Considerations
1. **Never differentiate** between "doesn't exist" and "no access" (always 404)
2. **Never expose** internal error details in 5xx responses
3. **Always log** full error details server-side with correlation IDs
4. **Rate limit** error responses to prevent enumeration attacks

## Migration Path

### Phase 1: Standardize New Endpoints
- All new endpoints follow this contract
- Document in OpenAPI spec

### Phase 2: Retrofit Existing Endpoints
- Update existing endpoints gradually
- Maintain backward compatibility with deprecation notices

### Phase 3: Remove Legacy Error Formats
- After client migration period
- Version API if breaking changes needed

## Testing Requirements

Each endpoint MUST have tests for:
1. Success case (2xx)
2. Each possible error status code
3. Error response format validation
4. Security: No information leakage in errors

## Client Integration

### TypeScript/Frontend Example
```typescript
interface APIError {
  detail: string;
  error_code: string;
  context?: Record<string, any>;
}

async function handleAPIError(response: Response): Promise<never> {
  const error: APIError = await response.json();
  
  switch (response.status) {
    case 404:
      throw new NotFoundError(error.detail);
    case 422:
      if (error.error_code === 'TASK_DESCRIPTION_TOO_LONG') {
        const maxLength = error.context?.max_length;
        throw new ValidationError(`Description too long (max: ${maxLength})`);
      }
      throw new ValidationError(error.detail);
    case 500:
      console.error(`Server error, request ID: ${error.context?.request_id}`);
      throw new ServerError('Something went wrong. Please try again.');
    default:
      throw new Error(error.detail);
  }
}
```

## Monitoring & Observability

- Track error rates by status code and error_code
- Alert on 5xx error spikes
- Log all 4xx errors for security analysis
- Correlate errors with request_id for debugging