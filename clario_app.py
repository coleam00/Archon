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
    
    # Simple ingestion endpoints for n8n nodes
    @app.post("/api/ingest/batch")
    async def ingest_batch_from_n8n(items: List[Dict[str, Any]]):
        """
        Receive clean data from n8n nodes (Jira, Notion, Slack, etc.)
        and process through Archon's proven pipeline.
        
        n8n handles: API calls, authentication, data extraction
        Clario handles: Processing, chunking, embedding, search
        """
        try:
            if not items:
                return {"success": True, "processed": 0, "message": "No items to process"}
            
            # Transform n8n extracted data for Archon processing
            archon_items = []
            
            for item in items:
                # n8n already extracted everything, we just format for Archon
                formatted_content = _format_n8n_data_for_search(item)
                
                archon_item = {
                    "url": item.get("url", f"https://unknown/{item.get('id', 'unknown')}"),
                    "chunk_number": 0,
                    "content": formatted_content,
                    "metadata": {
                        "integration_type": item.get("platform", "unknown"),
                        "content_type": item.get("type", "document"),
                        "extracted_by": "n8n_node",
                        "extracted_at": datetime.utcnow().isoformat(),
                        "business_metadata": item.get("metadata", {}),
                        **item.get("metadata", {})  # Include all n8n extracted metadata
                    }
                }
                archon_items.append(archon_item)
            
            # Process through Archon's proven document pipeline
            from python.src.server.services.storage.document_storage_service import add_documents_to_supabase
            
            urls = [item["url"] for item in archon_items]
            chunk_numbers = [item["chunk_number"] for item in archon_items]
            contents = [item["content"] for item in archon_items]
            metadatas = [item["metadata"] for item in archon_items]
            url_to_full_document = {item["url"]: item["content"] for item in archon_items}
            
            result = await add_documents_to_supabase(
                client=search_engine.supabase_client,
                urls=urls,
                chunk_numbers=chunk_numbers,
                contents=contents,
                metadatas=metadatas,
                url_to_full_document=url_to_full_document,
                enable_parallel_batches=True
            )
            
            logger.info(f"Processed {len(items)} items from n8n through Archon pipeline")
            
            return {
                "success": True,
                "processed": len(items),
                "archon_result": result,
                "platforms": list(set(item.get("platform") for item in items)),
                "message": f"Processed {len(items)} items through Archon pipeline"
            }
            
        except Exception as e:
            logger.error(f"Batch ingestion failed: {e}")
            raise HTTPException(status_code=500, detail=f"Processing failed: {str(e)}")
    
    @app.post("/api/ingest/{platform}")
    async def ingest_platform_data(platform: str, items: List[Dict[str, Any]]):
        """Platform-specific ingestion endpoint"""
        
        # Add platform info to each item
        for item in items:
            item["platform"] = platform
            
        # Use the batch endpoint
        return await ingest_batch_from_n8n(items)
    
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


def _format_n8n_data_for_search(item: Dict[str, Any]) -> str:
    """Format data extracted by n8n nodes for optimal search"""
    
    platform = item.get("platform", "unknown")
    metadata = item.get("metadata", {})
    
    if platform == "jira":
        # Format Jira data extracted by n8n Jira node
        parts = [
            f"# {item.get('key', '')}: {item.get('title', '')}",
            f"**Project:** {metadata.get('project', {}).get('name', '')}",
            f"**Type:** {metadata.get('issue_type', {}).get('name', '')}",
            f"**Status:** {metadata.get('status', {}).get('name', '')}",
        ]
        
        if metadata.get('assignee'):
            parts.append(f"**Assignee:** {metadata['assignee'].get('displayName', '')}")
        
        if metadata.get('labels'):
            parts.append(f"**Labels:** {', '.join(metadata['labels'])}")
        
        if item.get("content"):
            parts.extend(["", "## Description", item["content"]])
        
        # Add comments if n8n extracted them
        if metadata.get("comments"):
            parts.append("\n## Comments")
            for comment in metadata["comments"][:3]:  # Latest 3 comments
                author = comment.get("author", {}).get("displayName", "Unknown")
                body = comment.get("body", "")[:200]
                parts.append(f"**{author}:** {body}...")
                
    elif platform == "notion":
        # Format Notion data extracted by n8n Notion node
        parts = [
            f"# {item.get('title', 'Notion Page')}",
            f"**Platform:** Notion",
            f"**Workspace:** {metadata.get('workspace', '')}",
        ]
        
        if item.get("content"):
            parts.extend(["", "## Content", item["content"]])
            
    elif platform == "slack":
        # Format Slack data extracted by n8n Slack node
        channel = metadata.get("channel", {}).get("name", "unknown")
        user = metadata.get("user", {}).get("name", "Unknown")
        
        parts = [
            f"# Message in #{channel}",
            f"**Author:** {user}",
            f"**Channel:** #{channel}",
            f"**Date:** {metadata.get('ts', '')}",
        ]
        
        if item.get("content"):
            parts.extend(["", "## Message", item["content"]])
    
    else:
        # Generic formatting for other platforms
        parts = [
            f"# {item.get('title', 'Content')}",
            f"**Platform:** {platform.title()}",
        ]
        
        if item.get("content"):
            parts.extend(["", "## Content", item["content"]])
    
    # Add source link
    if item.get("url"):
        parts.append(f"\n**Source:** [View in {platform.title()}]({item['url']})")
    
    return "\n".join(parts)


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
