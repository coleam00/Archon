# ETag Implementation

## Current Implementation

Our ETag implementation provides efficient HTTP caching for polling endpoints to reduce bandwidth usage.

### What It Does
- **Generates ETags**: Creates MD5 hashes of JSON response data
- **Checks ETags**: Simple string equality comparison between client's `If-None-Match` header and current data's ETag
- **Returns 304**: When ETags match, returns `304 Not Modified` with no body (saves bandwidth)

### How It Works
1. Server generates ETag from response data using MD5 hash
2. Client sends previous ETag in `If-None-Match` header
3. Server compares ETags:
   - **Match**: Returns 304 (no body)
   - **No match**: Returns 200 with new data and new ETag

### Example
```python
# Server generates: ETag: "a3c2f1e4b5d6789"
# Client sends: If-None-Match: "a3c2f1e4b5d6789"
# Server returns: 304 Not Modified (no body)
```

## Limitations

Our implementation is simplified and doesn't support full RFC 7232 features:
- ❌ Wildcard (`*`) matching
- ❌ Multiple ETags (`"etag1", "etag2"`)
- ❌ Weak validators (`W/"etag"`)
- ✅ Single ETag comparison only

This works perfectly for our browser-to-API polling use case but may need enhancement for CDN/proxy support.

## Files
- Implementation: `python/src/server/utils/etag_utils.py`
- Tests: `python/tests/server/utils/test_etag_utils.py`
- Used in: Progress API, Projects API polling endpoints