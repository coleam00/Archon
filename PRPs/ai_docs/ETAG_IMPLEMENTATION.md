# ETag Implementation

## Overview

Archon implements HTTP ETag caching to optimize bandwidth usage by reducing redundant data transfers. The implementation leverages browser-native HTTP caching combined with backend ETag generation for efficient cache validation.

## How It Works

### Backend ETag Generation
**Location**: `python/src/server/utils/etag_utils.py`

The backend generates ETags for API responses:
- Creates MD5 hash of JSON-serialized response data
- Returns quoted ETag string (RFC 7232 format)
- Sets `Cache-Control: no-cache, must-revalidate` headers
- Compares client's `If-None-Match` header with current data's ETag
- Returns `304 Not Modified` when ETags match

### Frontend Handling
**Location**: `archon-ui-main/src/features/shared/api/apiClient.ts`

The frontend relies on browser-native HTTP caching:
- Browser automatically sends `If-None-Match` headers with cached ETags
- Browser handles 304 responses by returning cached data from HTTP cache
- No manual ETag tracking or cache management needed
- TanStack Query manages data freshness through `staleTime` configuration

#### Browser vs Non-Browser Behavior
- **Standard Browsers**: Per the Fetch spec, a 304 response freshens the HTTP cache and returns the cached body to JavaScript
- **Non-Browser Runtimes** (React Native, custom fetch): May surface 304 with empty body to JavaScript
- **Client Fallback**: The `apiClient.ts` implementation handles both scenarios, ensuring consistent behavior across environments

## Implementation Details

### Backend API Integration

ETags are used in these API routes:
- **Projects**: `python/src/server/api_routes/projects_api.py`
  - Project lists
  - Task lists
  - Task counts
- **Progress**: `python/src/server/api_routes/progress_api.py`
  - Active operations tracking

### ETag Generation Process

1. **Data Serialization**: Response data is JSON-serialized with sorted keys for consistency
2. **Hash Creation**: MD5 hash generated from JSON string
3. **Format**: Returns quoted string per RFC 7232 (e.g., `"a3c2f1e4b5d6789"`)

### Cache Validation Flow

1. **Initial Request**: Server generates ETag and sends with response
2. **Subsequent Requests**: Browser sends `If-None-Match` header with cached ETag
3. **Server Validation**:
   - ETags match → Returns `304 Not Modified` (no body)
   - ETags differ → Returns `200 OK` with new data and new ETag
4. **Browser Behavior**: On 304, browser serves cached response to JavaScript

## Key Design Decisions

### Browser-Native Caching
The implementation leverages browser HTTP caching instead of manual cache management:
- Reduces code complexity
- Eliminates cache synchronization issues
- Works seamlessly with TanStack Query
- Maintains bandwidth optimization

### No Manual ETag Tracking
Unlike previous implementations, the current approach:
- Does NOT maintain ETag maps in JavaScript
- Does NOT manually handle 304 responses
- Lets browser and TanStack Query handle caching layers

## Integration with TanStack Query

### Cache Coordination
- **Browser Cache**: Handles HTTP-level caching (ETags/304s)
- **TanStack Query Cache**: Manages application-level data freshness
- **Separation of Concerns**: HTTP caching for bandwidth, TanStack for state

### Configuration
Cache behavior is controlled through TanStack Query's `staleTime`:
- See `archon-ui-main/src/features/shared/config/queryPatterns.ts` for standard times
- See `archon-ui-main/src/features/shared/config/queryClient.ts` for global configuration

## Performance Benefits

### Bandwidth Reduction
- ~70% reduction in data transfer for unchanged responses (based on internal measurements)
- Especially effective for polling patterns
- Significant improvement for mobile/slow connections

### Server Load
- Reduced JSON serialization for 304 responses
- Lower network I/O
- Faster response times for cached data

## Files and References

### Core Implementation
- **Backend Utilities**: `python/src/server/utils/etag_utils.py`
- **Frontend Client**: `archon-ui-main/src/features/shared/api/apiClient.ts`
- **Tests**: `python/tests/server/utils/test_etag_utils.py`

### Usage Examples
- **Projects API**: `python/src/server/api_routes/projects_api.py` (lines with `generate_etag`, `check_etag`)
- **Progress API**: `python/src/server/api_routes/progress_api.py` (active operations tracking)

## Testing

### Backend Testing
Tests in `python/tests/server/utils/test_etag_utils.py` verify:
- Correct ETag generation format
- Consistent hashing for same data
- Different hashes for different data
- Proper quote formatting

### Frontend Testing
Browser DevTools verification:
1. Network tab shows `If-None-Match` headers on requests
2. 304 responses have no body
3. Response served from cache on 304
4. New ETag values when data changes

## Monitoring

### How to Verify ETags are Working
1. Open Chrome DevTools → Network tab
2. Make a request to a supported endpoint
3. Note the `ETag` response header
4. Refresh or re-request the same data
5. Observe:
   - Request includes `If-None-Match` header
   - Server returns `304 Not Modified` if unchanged
   - Response body is empty on 304
   - Browser serves cached data

### Metrics to Track
- Ratio of 304 vs 200 responses
- Bandwidth saved through 304 responses
- Cache hit rate in production

## Future Considerations

- Consider implementing strong vs weak ETags for more granular control
- Evaluate adding ETag support to more endpoints
- Monitor cache effectiveness in production
- Consider Last-Modified headers as supplementary validation