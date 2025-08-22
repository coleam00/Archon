# OpenAI Error Handling Enhancement

**Related to GitHub Issue #362**

## Problem
Users experienced silent failures when OpenAI API quota was exhausted, receiving empty RAG query results without any error indication.

## Solution
Enhanced error handling throughout the stack to catch, preserve, and display specific OpenAI API errors with actionable user guidance.

## Changes Made

### Backend (Python)

#### 1. Fixed Error Propagation in RAG Service
**File**: `python/src/server/services/search/rag_service.py`

- Enhanced `search_documents()` method to re-raise specific embedding errors instead of returning empty lists
- Added imports for `EmbeddingQuotaExhaustedError`, `EmbeddingRateLimitError`, `EmbeddingAPIError`

```python
except (EmbeddingQuotaExhaustedError, EmbeddingRateLimitError, EmbeddingAPIError):
    # Re-raise embedding errors so they propagate to the API layer with specific error info
    raise
```

#### 2. Enhanced API Error Handling
**File**: `python/src/server/api_routes/knowledge_api.py`

- Added specific error handling for OpenAI errors in `perform_rag_query()` endpoint
- Returns HTTP 429 with detailed error information for quota/rate limit errors
- Returns HTTP 502 with specific messages for API errors

```python
if isinstance(e, EmbeddingQuotaExhaustedError):
    raise HTTPException(
        status_code=429,
        detail={
            "error": "OpenAI API quota exhausted",
            "message": "Your OpenAI API key has no remaining credits...",
            "error_type": "quota_exhausted",
            "tokens_used": getattr(e, "tokens_used", None),
        }
    )
```

#### 3. Comprehensive Test Coverage
**File**: `python/tests/test_openai_quota_error_handling.py`

- Tests error propagation from embedding service through RAG service to API endpoint
- Verifies correct HTTP status codes and error details
- Ensures successful queries still work after changes

### Frontend (TypeScript/React)

#### 1. Error Parsing and Enhancement
**File**: `archon-ui-main/src/services/knowledgeBaseErrorHandler.ts`

- Parses API errors to identify OpenAI-specific issues
- Provides user-friendly error messages and suggested actions
- Categorizes errors by severity level

#### 2. Enhanced Knowledge Base Service
**File**: `archon-ui-main/src/services/knowledgeBaseService.ts`

- Integrated error handler into API request pipeline
- Preserves OpenAI error details through the service layer

#### 3. React Components for Error Display
**Files**: 
- `archon-ui-main/src/components/ui/ErrorAlert.tsx`
- `archon-ui-main/src/components/ui/Alert.tsx`

- Provides specialized UI components for displaying OpenAI errors
- Shows actionable guidance (e.g., "Check your OpenAI billing dashboard")
- Includes error severity indicators and suggested actions

## Usage Examples

### Backend API Response (Before)
```json
{
  "detail": {"error": "RAG query failed: Unknown error"}
}
```

### Backend API Response (After)
```json
{
  "detail": {
    "error": "OpenAI API quota exhausted",
    "message": "Your OpenAI API key has no remaining credits. Please add credits to your OpenAI account or check your billing settings.",
    "error_type": "quota_exhausted",
    "tokens_used": 1000
  }
}
```

### Frontend Usage
```tsx
import { useErrorHandler, ErrorAlert } from '../components/ui/ErrorAlert';
import { knowledgeBaseService } from '../services/knowledgeBaseService';

function SearchComponent() {
  const { error, setError, clearError } = useErrorHandler();
  
  const handleSearch = async (query: string) => {
    try {
      clearError();
      const results = await knowledgeBaseService.searchKnowledgeBase(query);
      // Handle successful results...
    } catch (err) {
      setError(err as EnhancedError);
    }
  };

  return (
    <>
      <ErrorAlert error={error} onDismiss={clearError} />
      {/* Search UI components */}
    </>
  );
}
```

## Error Types Handled

1. **Quota Exhausted** (HTTP 429)
   - Message: "Your OpenAI API key has no remaining credits..."
   - Action: "Check your OpenAI billing dashboard and add credits"

2. **Rate Limited** (HTTP 429) 
   - Message: "Too many requests to OpenAI API..."
   - Action: "Wait 30 seconds and try again"

3. **API Error** (HTTP 502)
   - Message: "OpenAI API error: [specific error]"
   - Action: "Verify your OpenAI API key in Settings"

## Testing

Run the comprehensive test suite:
```bash
cd python
uv run pytest tests/test_openai_quota_error_handling.py -v
```

## Benefits

1. **Clear Error Messages**: Users now see specific, actionable error messages instead of silent failures
2. **Better Debugging**: Developers get detailed error context in logs
3. **Improved UX**: Users understand what went wrong and how to fix it
4. **Reduced Support Load**: Self-service error resolution with guided actions

This enhancement resolves GitHub issue #362 and significantly improves the user experience when OpenAI API issues occur.