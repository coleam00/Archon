# Archon UI - Knowledge Engine Web Interface

A modern React-based web interface for the Archon Knowledge Engine MCP Server. Built with TypeScript, Vite, and Tailwind CSS.

## 🎨 UI Overview

Archon UI provides a comprehensive dashboard for managing your AI's knowledge base:

![UI Architecture](https://via.placeholder.com/800x400?text=Archon+UI+Architecture)

### Key Features

- **📊 MCP Dashboard**: Monitor and control the MCP server
- **⚙️ Settings Management**: Configure credentials and RAG strategies
- **🕷️ Web Crawling**: Crawl documentation sites and build knowledge base
- **📚 Knowledge Management**: Browse, search, and organize knowledge items
- **💬 Interactive Chat**: Test RAG queries with real-time responses
- **📈 Real-time Updates**: WebSocket-based live updates across the UI

## 🏗️ Architecture

### Technology Stack Architecture

**Frontend (port 3737)**:
- **React 18.3**: Modern React with hooks and functional components
- **TypeScript**: Full type safety and IntelliSense support
- **Vite**: Fast build tool and dev server
- **Tailwind CSS**: Utility-first styling
- **Framer Motion**: Smooth animations and transitions
- **Lucide Icons**: Beautiful and consistent iconography
- **React Router**: Client-side routing

**Backend (Python)**:
- **FastAPI**: High-performance async API framework
- **Repository Pattern**: Advanced data access with lazy loading (98% startup improvement)
- **Supabase**: PostgreSQL + pgvector for embeddings
- **MCP Server**: Model Context Protocol integration
- **Socket.IO**: Real-time updates and communication

### Repository Pattern Benefits

The backend implements a sophisticated repository pattern with:

- **🚀 Lazy Loading**: 98% startup time reduction (520ms → 9ms)
- **🔒 Type Safety**: Full generic type safety with comprehensive interfaces
- **⚡ High Performance**: <0.1ms cached repository access
- **🔄 Transaction Management**: ACID compliance with Unit of Work pattern
- **📊 Monitoring**: Built-in performance statistics and health checks

```python
# Example: Type-safe, lazy-loaded repository access
db = LazySupabaseDatabase(supabase_client)

# Repositories loaded only when accessed
source = await db.sources.create(Source(
    url="https://example.com",
    source_type=SourceType.WEBSITE
))

# Transactional operations
async with db.transaction() as uow:
    project = await uow.projects.create(project_data)
    await uow.tasks.create_batch(initial_tasks)
```

### Project Structure

```
archon-ui-main/
├── src/
│   ├── components/          # Reusable UI components
│   │   ├── ui/             # Base UI components (Button, Card, etc.)
│   │   ├── layouts/        # Layout components (Sidebar, Header)
│   │   └── animations/     # Animation components
│   ├── pages/              # Page components
│   │   ├── MCPPage.tsx     # MCP Dashboard
│   │   ├── Settings.tsx    # Settings page
│   │   ├── Crawl.tsx       # Web crawling interface
│   │   ├── KnowledgeBase.tsx # Knowledge management
│   │   └── Chat.tsx        # RAG chat interface
│   ├── services/           # API and service layers
│   │   ├── api.ts          # Base API configuration
│   │   ├── mcpService.ts   # MCP server communication
│   │   └── chatService.ts  # Chat/RAG service
│   ├── contexts/           # React contexts
│   │   └── ToastContext.tsx # Toast notifications
│   ├── hooks/              # Custom React hooks
│   │   └── useStaggeredEntrance.ts # Animation hook
│   ├── types/              # TypeScript type definitions
│   └── lib/                # Utility functions
├── public/                 # Static assets
└── test/                   # Test files
```

## 📄 Pages Documentation

### 1. MCP Dashboard (`/mcp`)

The central control panel for the MCP server.

**Components:**
- **Server Control Panel**: Start/stop server, view status, select transport mode
- **Server Logs Viewer**: Real-time log streaming with auto-scroll
- **Available Tools Table**: Dynamic tool discovery and documentation
- **MCP Test Panel**: Interactive tool testing interface

**Features:**
- Dual transport support (SSE/stdio)
- Real-time status polling (5-second intervals)
- WebSocket-based log streaming
- Copy-to-clipboard configuration
- Tool parameter validation

### 2. Settings (`/settings`)

Comprehensive configuration management.

**Sections:**
- **Credentials**: 
  - OpenAI API key (encrypted storage)
  - Supabase connection details
  - MCP server configuration
- **RAG Strategies**:
  - Contextual Embeddings toggle
  - Hybrid Search toggle
  - Agentic RAG (code extraction) toggle
  - Reranking toggle

**Features:**
- Secure credential storage with encryption
- Real-time validation
- Toast notifications for actions
- Default value management

### 3. Web Crawling (`/crawl`)

Interface for crawling documentation sites.

**Components:**
- **URL Input**: Smart URL validation
- **Crawl Options**: Max depth, concurrent sessions
- **Progress Monitoring**: Real-time crawl status
- **Results Summary**: Pages crawled, chunks stored

**Features:**
- Intelligent URL type detection
- Sitemap support
- Recursive crawling
- Batch processing

### 4. Knowledge Base (`/knowledge`)

Browse and manage your knowledge items.

**Components:**
- **Knowledge Grid**: Card-based knowledge display
- **Search/Filter**: Search by title, type, tags
- **Knowledge Details**: View full item details
- **Actions**: Delete, refresh, organize

**Features:**
- Pagination support
- Real-time updates via WebSocket
- Type-based filtering (technical/business)
- Metadata display

### 5. RAG Chat (`/chat`)

Interactive chat interface for testing RAG queries.

**Components:**
- **Chat Messages**: Threaded conversation view
- **Input Area**: Query input with source selection
- **Results Display**: Formatted RAG results
- **Source Selector**: Filter by knowledge source

**Features:**
- Real-time streaming responses
- Source attribution
- Markdown rendering
- Copy functionality

## 🧩 Component Library

### Base UI Components

#### Button
```tsx
<Button 
  variant="primary|secondary|ghost" 
  size="sm|md|lg"
  accentColor="blue|green|purple|orange|pink"
  onClick={handleClick}
>
  Click me
</Button>
```

#### Card
```tsx
<Card accentColor="blue" className="p-6">
  <h3>Card Title</h3>
  <p>Card content</p>
</Card>
```

#### LoadingSpinner
```tsx
<LoadingSpinner size="sm|md|lg" />
```

### Layout Components

#### Sidebar
- Collapsible navigation
- Active route highlighting
- Icon + text navigation items
- Responsive design

#### Header
- Dark mode toggle
- User menu
- Breadcrumb navigation

### Animation Components

#### PageTransition
Wraps pages with smooth fade/slide animations:
```tsx
<PageTransition>
  <YourPageContent />
</PageTransition>
```

## 🔌 Services

### mcpService
Handles all MCP server communication:
- `startServer()`: Start the MCP server
- `stopServer()`: Stop the MCP server
- `getStatus()`: Get current server status
- `streamLogs()`: WebSocket log streaming
- `getAvailableTools()`: Fetch MCP tools

### api
Base API configuration with:
- Automatic error handling
- Request/response interceptors
- Base URL configuration
- TypeScript generics

### chatService
RAG query interface:
- `sendMessage()`: Send RAG query
- `streamResponse()`: Stream responses
- `getSources()`: Get available sources

## 🎨 Styling

### Tailwind Configuration
- Custom color palette
- Dark mode support
- Custom animations
- Responsive breakpoints

### Theme Variables
```css
--primary: Blue accent colors
--secondary: Gray/neutral colors
--success: Green indicators
--warning: Orange indicators
--error: Red indicators
```

## 🚀 Development

### Setup
```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

### Environment Variables
```env
VITE_API_URL=http://localhost:8080
```

### Hot Module Replacement
Vite provides instant HMR for:
- React components
- CSS modules
- TypeScript files

## 🧪 Testing

### Unit Tests
- Component testing with React Testing Library
- Service mocking with MSW
- Hook testing with @testing-library/react-hooks

### Integration Tests
- Page-level testing
- API integration tests
- WebSocket testing

## 📦 Build & Deployment

### Docker Support
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3737
CMD ["npm", "run", "preview"]
```

### Production Optimization
- Code splitting by route
- Lazy loading for pages
- Image optimization
- Bundle size analysis

## 🔧 Configuration Files

### vite.config.ts
- Path aliases
- Build optimization
- Development server config

### tsconfig.json
- Strict type checking
- Path mappings
- Compiler options

### tailwind.config.js
- Custom theme
- Plugin configuration
- Purge settings

## 📚 Backend Documentation

The Python backend implements an advanced repository pattern with comprehensive documentation:

### Core Documentation

- **[Repository Pattern Specification](../python/docs/REPOSITORY_PATTERN_SPECIFICATION.md)**: Complete architecture overview
- **[API Reference](../python/docs/REPOSITORY_API_REFERENCE.md)**: Comprehensive API documentation with type annotations
- **[Testing Guide](../python/docs/TESTING_GUIDE.md)**: Testing strategies and patterns
- **[Lazy Loading Performance Guide](../python/docs/LAZY_LOADING_PERFORMANCE_GUIDE.md)**: Performance optimization details

### Performance Characteristics

| Metric | Traditional Loading | Lazy Loading | Improvement |
|--------|-------------------|--------------|-------------|
| Startup time | 520ms | 9ms | 98.3% faster |
| Memory usage | 45MB | 0.66MB | 98.5% less |
| First access | N/A | 12ms | New capability |
| Cached access | N/A | 0.08ms | Ultra-fast |

### Repository Domains

- **Knowledge Domain**: Sources, documents, code examples with vector search
- **Project Domain**: Projects, tasks, version control with transaction support
- **Settings Domain**: Configuration, prompt templates with type safety

### Quick Backend Commands

```bash
# Backend development (from /python directory)
uv sync                    # Install dependencies
uv run pytest             # Run tests
uv run python -m src.server.main  # Start server

# Performance testing
uv run python -m src.server.repositories.debug benchmark
uv run pytest tests/performance/ -v

# Code quality
uv run ruff check --fix src/
uv run mypy src/
```

## 🤝 Contributing

### Code Style
- ESLint configuration
- Prettier formatting
- TypeScript strict mode
- Component naming conventions

### Git Workflow
- Feature branches
- Conventional commits
- PR templates
- Code review process
