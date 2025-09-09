# Step 06 — Backend: Server-side validation (50k description limit)

Goal
- Enforce description length limit server-side to fail fast on invalid data.

Why
- Prevents oversized payloads and ensures data integrity per Beta Guidelines.

Scope (isolated)
- New schema: `python/src/server/schemas/tasks.py`
- Integrate into create/update paths in services/routes

Acceptance criteria
- Requests with `description` > 50,000 characters are rejected with HTTP 422 (Unprocessable Entity).
- Error response format:
  ```json
  {
    "error_code": "TASK_DESCRIPTION_TOO_LONG",
    "message": "Task description exceeds maximum length of 50000 characters",
    "max_length": 50000,
    "provided_length": <actual_length>
  }
  ```
- Valid requests continue to work unchanged.

Implementation checklist
1) Add Pydantic schemas:
   ```python
   from pydantic import BaseModel, Field, field_validator
   from typing import Optional

   class TaskUpdate(BaseModel):
       description: Optional[str] = Field(None, max_length=50000)
       # add other fields as needed
       
       @field_validator('description')
       @classmethod
       def validate_description_length(cls, v: Optional[str]) -> Optional[str]:
           if v and len(v) > 50000:
               raise ValueError(f"Description length {len(v)} exceeds maximum of 50000")
           return v
   ```
2) Handle validation errors in API routes:
   ```python
   from fastapi import HTTPException
   from pydantic import ValidationError
   
   try:
       task_data = TaskUpdate(**request.dict())
   except ValidationError as e:
       for error in e.errors():
           if error['loc'] == ('description',) and 'exceeds maximum' in str(error['msg']):
               raise HTTPException(
                   status_code=422,
                   detail={
                       "error_code": "TASK_DESCRIPTION_TOO_LONG",
                       "message": "Task description exceeds maximum length of 50000 characters",
                       "max_length": 50000,
                       "provided_length": len(request.description) if request.description else 0
                   }
               )
       raise HTTPException(status_code=422, detail=e.errors())
   ```
3) Add detailed logging for validation errors.

Tests (backend)
- Location: `python/tests/test_task_validation.py`
- Cases: valid boundary (50,000), reject 50,001, null allowed.

Validation commands (safe)
- `uv run pytest -k task_validation -v`

Rollback
- Remove schema usage (not recommended).

Time estimate
- 30–45 minutes

