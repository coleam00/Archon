"""
Clario Main Application
The Knowledge Engine for Founder - built on Archon's proven infrastructure

This application:
1. Receives data from n8n workflows (business platform integrations)
2. Processes data through Archon's proven document pipeline
3. Provides unified search across all platforms
4. Offers TypeScript-friendly APIs for Founder frontend integration
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from typing import List
import uvicorn
import httpx
from datetime import datetime

# Import Clario extensions that build on Archon
from extensions.n8n_integration.ingestion_api import create_n8n_router
from extensions.unified_search.archon_search import ArchonUnifiedSearch, UniversalSearchQuery


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle management"""
    print("🚀 Starting Clario Knowledge Engine...")
    print("   ├─ Built on Archon's proven infrastructure")
    print("   ├─ n8n business platform integrations")  
    print("   ├─ Unified search across all company tools")
    print("   └─ AI-powered Q&A with source attribution")
    
    # Verify Archon services are running
    await verify_archon_services()
    
    yield
    
    print("🛑 Shutting down Clario...")


async def verify_archon_services():
    """Verify that Archon's core services are running"""
    
    archon_services = {
        "Archon API": "http://localhost:8181/health",
        "Archon MCP": "http://localhost:8051/health"
    }
    
    print("\n🔍 Verifying Archon services (required for Clario)...")
    
    all_healthy = True
    async with httpx.AsyncClient() as client:
        for service, url in archon_services.items():
            try:
                response = await client.get(url, timeout=5.0)
                if response.status_code == 200:
                    print(f"   ✅ {service}: Running and healthy")
                else:
                    print(f"   ⚠️ {service}: Responding but status {response.status_code}")
                    all_healthy = False
            except Exception as e:
                print(f"   ❌ {service}: Not available ({e})")
                all_healthy = False
    
    if not all_healthy:
        print(f"\n⚠️ Some Archon services not available.")
        print("   Start Archon first: docker-compose up -d")
        print("   Clario will still start but functionality may be limited.")
    else:
        print("\n✅ All Archon services healthy - Clario ready for full operation!")


def create_clario_app() -> FastAPI:
    """Create the main Clario FastAPI application"""
    
    app = FastAPI(
        title="Clario Knowledge Engine",
        description="Business intelligence layer for Founder, powered by Archon infrastructure",
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc"
    )
    
    # CORS for Founder frontend and n8n
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:3000",    # Founder dev server
            "http://127.0.0.1:3000",   # Alternative local
            "http://localhost:3737",    # Archon UI
            "http://localhost:5678",    # n8n UI
            "https://*.n8n.cloud",      # n8n cloud
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"]
    )
    
    # Initialize unified search engine
    search_engine = ArchonUnifiedSearch()
    
    # Root endpoint
    @app.get("/")
    async def root():
        return {
            "service": "Clario Knowledge Engine",
            "description": "Transforms Founder into a company-wide AI assistant",
            "powered_by": "Archon infrastructure + n8n integrations",
            "version": "1.0.0",
            "endpoints": {
                "n8n_ingestion": "/api/n8n/",
                "founder_search": "/api/search/",
                "health": "/health",
                "docs": "/docs"
            },
            "setup_guides": [
                "N8N_INTEGRATION_STRATEGY.md",
                "FORK_STRATEGY.md", 
                "FINAL_SUMMARY.md"
            ]
        }
    
    # Health check
    @app.get("/health")
    async def health():
        return {
            "service": "clario",
            "status": "healthy",
            "timestamp": datetime.utcnow(),
            "version": "1.0.0",
            "archon_integration": "active",
            "capabilities": [
                "n8n data ingestion",
                "Archon document processing",
                "Unified cross-platform search",
                "AI-powered Q&A",
                "Founder 4-node classification"
            ]
        }
    
    # Include n8n ingestion router
    n8n_router = create_n8n_router()
    app.include_router(n8n_router, prefix="/api/n8n", tags=["n8n Integration"])
    
    # Founder-friendly search endpoints
    @app.post("/api/search/universal")
    async def universal_search(query: UniversalSearchQuery):
        """
        Universal search across all connected business platforms.
        This is the main search endpoint for Founder's command palette.
        """
        try:
            results = await search_engine.search(query)
            
            return {
                "success": True,
                "query": query.query,
                "results": [result.dict() for result in results],
                "total": len(results),
                "platforms_searched": query.platforms or ["all"],
                "powered_by": "Archon RAG + Clario business intelligence"
            }
            
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")
    
    @app.post("/api/search/ask")
    async def ask_question(
        question: str,
        context_platforms: List[str] = []
    ):
        """
        AI-powered Q&A using company data as context.
        Perfect for Founder's "?question" mode in command palette.
        """
        try:
            response = await search_engine.ask_question(
                question=question,
                context_platforms=context_platforms
            )
            
            return {
                "success": True,
                **response,
                "powered_by": "Archon RAG + Clario intelligence"
            }
            
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"AI Q&A failed: {str(e)}")
    
    @app.get("/api/stats")
    async def get_stats():
        """Get Clario statistics and platform breakdown"""
        try:
            stats = await search_engine.get_stats()
            
            return {
                "success": True,
                "clario_stats": stats,
                "archon_integration": "active",
                "timestamp": datetime.utcnow()
            }
            
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Stats failed: {str(e)}")
    
    return app


# Create the application
app = create_clario_app()


if __name__ == "__main__":
    print("""
🎯 Clario Knowledge Engine for Founder

Perfect Architecture:
┌─ Business Platforms (Jira, Notion, Slack, GitHub...)
├─ n8n Workflows (400+ pre-built integrations)
├─ Clario API (this service - intelligent processing)  
├─ Archon Pipeline (proven RAG + embeddings)
└─ Founder Frontend (unified search + AI Q&A)

Starting Clario on http://localhost:8080
Integrates with Archon running on http://localhost:8181

Ready to receive data from n8n workflows!
    """)
    
    uvicorn.run(
        "clario_app:app",
        host="0.0.0.0",
        port=8080,
        reload=True,
        log_level="info"
    )
