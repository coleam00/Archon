# Polling Architecture Documentation

## Overview
Archon V2 uses HTTP polling instead of WebSockets for real-time updates. This simplifies the architecture, reduces complexity, and improves maintainability while providing adequate responsiveness for project management tasks.

## Core Components

### 1. usePolling Hook (`archon-ui-main/src/hooks/usePolling.ts`)
Generic polling hook that manages periodic data fetching with smart optimizations.

**Key Features:**
- Configurable polling intervals (default: 3 seconds)
- Automatic pause during browser tab inactivity
- ETag-based caching to reduce bandwidth
- Manual refresh capability

**Usage:**
```typescript
const { data, isLoading, error, refetch } = usePolling('/api/projects', {
  interval: 5000,
  enabled: true,
  onSuccess: (data) => console.log('Projects updated:', data)
});
```

### 2. Specialized Progress Services
Individual services handle specific progress tracking needs:

**CrawlProgressService (`archon-ui-main/src/services/crawlProgressService.ts`)**
- Tracks website crawling operations
- Maps backend status to UI-friendly format
- Includes in-flight request guard to prevent overlapping fetches
- 1-second polling interval during active crawls

**Polling Endpoints:**
- `/api/projects` - Project list updates
- `/api/projects/{project_id}/tasks` - Task list for active project
- `/api/crawl-progress/{progress_id}` - Website crawling progress
- `/api/agent-chat/sessions/{session_id}/messages` - Chat messages

## Backend Support

### ETag Implementation (`python/src/server/utils/etag_utils.py`)
Server-side optimization to reduce unnecessary data transfer.

**How it works:**
1. Server generates ETag hash from response data
2. Client sends `If-None-Match` header with cached ETag
3. Server returns 304 Not Modified if data unchanged
4. Client uses cached data, reducing bandwidth by ~70%

### Progress API (`python/src/server/api_routes/progress_api.py`)
Dedicated endpoints for progress tracking:
- `GET /api/crawl-progress/{progress_id}` - Returns crawling status with ETag support
- Includes completion percentage, current step, and error details

## State Management

### Loading States
Visual feedback during operations:
- `movingTaskIds: Set<string>` - Tracks tasks being moved
- `isSwitchingProject: boolean` - Project transition state
- Loading overlays prevent concurrent operations

## Error Handling

### Retry Strategy
```typescript
retryCount: 3
retryDelay: attempt => Math.min(1000 * 2 ** attempt, 30000)
```
- Exponential backoff: 1s, 2s, 4s...
- Maximum retry delay: 30 seconds
- Automatic recovery after network issues

### User Feedback
- Toast notifications for errors
- Loading spinners during operations
- Clear error messages with recovery actions

## Performance Optimizations

### 1. Request Deduplication
Prevents multiple components from making identical requests:
```typescript
const cacheKey = `${endpoint}-${JSON.stringify(params)}`;
if (pendingRequests.has(cacheKey)) {
  return pendingRequests.get(cacheKey);
}
```

### 2. Smart Polling Intervals
- Active operations: 1-2 second intervals
- Background data: 5-10 second intervals
- Paused when tab inactive (visibility API)

### 3. Selective Updates
Only polls active/relevant data:
- Tasks poll only for selected project
- Progress polls only during active operations
- Chat polls only for open sessions

## Architecture Benefits

### What We Have
- **Simple HTTP polling** - Standard request/response pattern
- **Automatic error recovery** - Built-in retry with exponential backoff
- **ETag caching** - 70% bandwidth reduction via 304 responses
- **Easy debugging** - Standard HTTP requests visible in DevTools
- **No connection limits** - Scales with standard HTTP infrastructure
- **Consolidated polling hooks** - Single pattern for all data fetching

### Trade-offs
- **Latency:** 1-5 second delay vs instant updates
- **Bandwidth:** More requests, but mitigated by ETags
- **Battery:** Slightly higher mobile battery usage

## Developer Guidelines

### Adding New Polling Endpoint

1. **Frontend - Use the usePolling hook:**
```typescript
// In your component or custom hook
const { data, isLoading, error, refetch } = usePolling('/api/new-endpoint', {
  interval: 5000,
  enabled: true,
  staleTime: 2000
});
```

2. **Backend - Add ETag support:**
```python
from ..utils.etag_utils import generate_etag, check_etag

@router.get("/api/new-endpoint")
async def get_data(request: Request):
    data = fetch_data()
    etag = generate_etag(data)
    
    if check_etag(request, etag):
        return Response(status_code=304)
    
    return JSONResponse(
        content=data,
        headers={"ETag": etag}
    )
```

3. **For progress tracking, use useCrawlProgressPolling:**
```typescript
const { data, isLoading } = useCrawlProgressPolling(operationId, {
  onSuccess: (data) => {
    if (data.status === 'completed') {
      // Handle completion
    }
  }
});
```

### Best Practices

1. **Always provide loading states** - Users should know when data is updating
2. **Handle errors gracefully** - Show toast notifications with clear messages
3. **Respect polling intervals** - Don't poll faster than necessary
4. **Clean up on unmount** - Cancel pending requests when components unmount
5. **Use ETag caching** - Reduce bandwidth with 304 responses

## Testing Polling Behavior

### Manual Testing
1. Open Network tab in DevTools
2. Look for requests with 304 status (cache hits)
3. Verify polling stops when switching tabs
4. Test error recovery by stopping backend

### Debugging Tips
- Check `localStorage` for cached ETags
- Monitor `console.log` for polling lifecycle events
- Use React DevTools to inspect hook states
- Watch for memory leaks in long-running sessions

## Future Improvements

### Planned Enhancements
- WebSocket fallback for critical updates
- Configurable per-user polling rates
- Smart polling based on user activity patterns
- GraphQL subscriptions for selective field updates

### Considered Alternatives
- Server-Sent Events (SSE) - One-way real-time updates
- Long polling - Reduced request frequency
- WebRTC data channels - P2P updates between clients