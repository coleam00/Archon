# Documentation Structure

## Overview

The Archon documentation has been simplified to focus on developer-friendly reference material without excessive styling or marketing language.

## Key Changes

### Architecture Documentation
- Created `architecture.mdx` - Clear explanation of system design and our recent changes
- Shows how FastAPI uses services directly while MCP uses HTTP
- Includes code examples of correct patterns

### Simplified Reference Section
- **server-overview.mdx** - Reduced from 278 to 120 lines, removed hero sections
- **server-services.mdx** - Replaced verbose cards with clean tables
- **mcp-server.mdx** - Emphasized HTTP-only architecture, simplified diagrams
- **api-reference.mdx** - Added new `DELETE /api/sources/{source_id}` endpoint

### Consolidated Files
- Combined all testing docs into single `testing.mdx`
- Simplified sidebar structure from 4 levels to 2 levels
- Removed redundant MCP and agent documentation files

## Documentation Principles

1. **Reference = Facts Only** - No heroes, cards, or marketing
2. **Tables Over Prose** - Easy to scan information
3. **Code Examples** - Show correct usage patterns
4. **Clean Hierarchy** - Simple, logical organization
5. **No Duplication** - Say things once, clearly

## File Structure

```
docs/
├── intro.mdx              # Marketing-friendly introduction
├── getting-started/       # Setup and configuration
├── features/              # Feature overviews
├── reference/             # Technical documentation (clean, no fluff)
│   ├── architecture.mdx   # System design
│   ├── server-*.mdx       # Server documentation
│   ├── api-reference.mdx  # REST API endpoints
│   ├── mcp-server.mdx     # MCP tools
│   └── socketio.mdx      # Socket.IO events and real-time communication
└── guides/                # How-to guides
```

## Architecture Changes Documented

### Delete Operation Fix
- FastAPI: `SourceManagementService.delete_source()` - Direct service usage
- API: `DELETE /api/sources/{source_id}` - New endpoint
- MCP: HTTP call to API endpoint - No direct imports

### Crawl Operation Fix
- FastAPI: Uses `CrawlingService` directly with smart URL detection
- Progress callbacks for real-time updates
- Proper service separation maintained

### Socket.IO Simplification (2025 Pattern)
- **Official Socket.IO 2025 pattern** - Removed complex namespace classes, using simple @sio.event decorators
- **Eliminated database polling** - Removed 2-second polling system for task/project changes
- **Direct Socket.IO emission** - Services emit events directly to rooms with `sio.emit()`
- **Root namespace only** - Everything runs on `/` namespace, no complex namespace management
- **Simple room management** - Direct `sio.enter_room()` and `sio.leave_room()` calls
- **Simplified flow**: MCP → HTTP API → Services → @sio.event → Rooms → UI

The documentation now clearly reflects that:
- **Server contains ALL business logic**
- **MCP is HTTP-only** (no direct imports)
- **Services are the single source of truth**
- **Socket.IO follows official 2025 patterns** - Simple, clean, and maintainable