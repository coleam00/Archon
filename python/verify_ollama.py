#!/usr/bin/env python
"""
Verify Ollama Integration Script

This script verifies that Ollama is properly integrated with Archon by:
1. Checking Ollama server connectivity
2. Testing embedding generation
3. Performing a RAG query
4. Writing test data to the database

Run with: python verify_ollama.py
"""

import asyncio
import os
import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent))

# Configure environment for Ollama
# Note: host.docker.internal is needed when services are running in Docker
os.environ.update({
    "SUPABASE_URL": os.getenv("SUPABASE_URL", "http://localhost:8000"),
    "SUPABASE_SERVICE_KEY": os.getenv("SUPABASE_SERVICE_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q"),
    "EMBEDDING_PROVIDER": "ollama",
    "OLLAMA_BASE_URL": "http://localhost:11434",
    "OLLAMA_EMBEDDING_MODEL": "nomic-embed-text",
    "OLLAMA_MODEL": "qwen2.5:3b",
})


async def verify_ollama():
    """Verify Ollama integration with Archon."""
    print("🚀 Verifying Ollama Integration with Archon\n")
    
    # Step 1: Check Ollama server
    print("1️⃣ Checking Ollama server...")
    import httpx
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get("http://localhost:11434/api/tags", timeout=5)
            if response.status_code == 200:
                models = response.json().get("models", [])
                print(f"   ✅ Ollama server is running with {len(models)} models")
                for model in models[:3]:
                    print(f"      - {model.get('name')}")
            else:
                print(f"   ❌ Ollama server returned status {response.status_code}")
                return False
    except Exception as e:
        print(f"   ❌ Cannot connect to Ollama: {e}")
        return False
    
    # Step 2: Configure credentials
    print("\n2️⃣ Configuring Ollama credentials...")
    from src.server.services.credential_service import credential_service
    
    await credential_service.set_credential("EMBEDDING_PROVIDER", "ollama", is_encrypted=False)
    await credential_service.set_credential("OLLAMA_EMBEDDING_MODEL", "nomic-embed-text", is_encrypted=False)
    await credential_service.set_credential("LLM_PROVIDER", "ollama", is_encrypted=False)
    await credential_service.set_credential("MODEL_CHOICE", "qwen2.5:3b", is_encrypted=False)
    await credential_service.set_credential("RAG_AGENT_MODEL", "ollama:qwen2.5:3b", is_encrypted=False)
    await credential_service.set_credential("LLM_BASE_URL", "http://localhost:11434/v1", is_encrypted=False)
    print("   ✅ Credentials configured")
    
    # Step 3: Test embedding generation
    print("\n3️⃣ Testing embedding generation...")
    from src.server.services.embeddings.embedding_service import create_embedding
    
    test_text = "Archon is a powerful knowledge management system"
    try:
        embedding = await create_embedding(test_text, provider="ollama")
        if embedding and len(embedding) > 0:
            print(f"   ✅ Generated embedding with {len(embedding)} dimensions")
            print(f"      Sample values: {embedding[:3]}")
        else:
            print("   ❌ Failed to generate embedding")
            return False
    except Exception as e:
        print(f"   ❌ Error generating embedding: {e}")
        return False
    
    # Step 4: Insert test document
    print("\n4️⃣ Inserting test document into database...")
    from src.server.utils import get_supabase_client
    import uuid
    
    supabase = get_supabase_client()
    
    # First create a source if it doesn't exist
    source_id = str(uuid.uuid4())
    test_source = {
        "source_id": source_id,
        "url": "test://ollama-verification",
        "title": "Ollama Test Source",
        "metadata": {
            "type": "test",
            "status": "completed",
            "processing_status": "completed",
        },
        "summary": "Test source for Ollama verification",
    }
    
    try:
        # Check if test source already exists
        existing_source = supabase.table("archon_sources").select("source_id").eq("url", test_source["url"]).execute()
        
        if existing_source.data:
            source_id = existing_source.data[0]["source_id"]
            print(f"   ℹ️ Using existing source: {source_id}")
        else:
            # Insert new source
            source_response = supabase.table("archon_sources").insert(test_source).execute()
            print(f"   ✅ Created test source: {source_id}")
    except Exception as e:
        print(f"   ⚠️ Source handling: {e}")
        source_id = str(uuid.uuid4())  # Fallback to random ID
    
    # Create test document with embedding
    test_doc = {
        "content": "Archon V2 is a next-generation knowledge management system that uses Ollama for local LLM processing. It provides advanced RAG capabilities, semantic search, and intelligent document processing.",
        "metadata": {
            "source": "ollama-test",
            "title": "Archon V2 with Ollama",
            "test": True,
        },
        "url": "test://archon-ollama-verification",
        "source_id": source_id,
        "embedding": embedding,  # Use the embedding we just generated
        "chunk_number": 1,  # Required field
    }
    
    try:
        # Check if test document already exists
        existing = supabase.table("archon_crawled_pages").select("id").eq("url", test_doc["url"]).execute()
        
        if existing.data:
            # Update existing document
            response = supabase.table("archon_crawled_pages").update(test_doc).eq("url", test_doc["url"]).execute()
            print(f"   ✅ Updated existing test document")
        else:
            # Insert new document
            response = supabase.table("archon_crawled_pages").insert(test_doc).execute()
            print(f"   ✅ Inserted new test document")
            
    except Exception as e:
        print(f"   ❌ Error with database: {e}")
        return False
    
    # Step 5: Perform RAG query
    print("\n5️⃣ Performing RAG query...")
    from src.server.services.search.rag_service import RAGService
    
    rag_service = RAGService(supabase_client=supabase)
    
    queries = [
        "What is Archon V2?",
        "How does Ollama integration work?",
        "Tell me about the knowledge management features",
    ]
    
    for query in queries:
        print(f"\n   Query: '{query}'")
        try:
            success, results = await rag_service.perform_rag_query(
                query=query,
                match_count=3,
            )
            
            if success:
                result_count = len(results.get("results", []))
                print(f"   ✅ Found {result_count} results")
                
                if result_count > 0:
                    top_result = results["results"][0]
                    similarity = top_result.get("similarity", 0)
                    content_preview = top_result.get("content", "")[:100]
                    print(f"      Top match (similarity: {similarity:.3f}): {content_preview}...")
            else:
                print(f"   ⚠️ Query returned no results: {results}")
                
        except Exception as e:
            print(f"   ❌ Error performing query: {e}")
    
    # Step 6: Verify Ollama was used
    print("\n6️⃣ Verifying Ollama provider...")
    provider = await credential_service.get_credential("LLM_PROVIDER")
    model = await credential_service.get_credential("MODEL_CHOICE")
    
    if provider == "ollama":
        print(f"   ✅ Using Ollama provider with model: {model}")
    else:
        print(f"   ❌ Not using Ollama provider (current: {provider})")
        return False
    
    print("\n✨ Ollama integration verified successfully!")
    return True


async def cleanup_test_data():
    """Clean up test data from the database."""
    print("\n🧹 Cleaning up test data...")
    from src.server.utils import get_supabase_client
    
    supabase = get_supabase_client()
    
    try:
        # Delete test documents
        doc_response = supabase.table("archon_crawled_pages").delete().eq("url", "test://archon-ollama-verification").execute()
        print("   ✅ Cleaned up test documents")
        
        # Delete test source
        source_response = supabase.table("archon_sources").delete().eq("url", "test://ollama-verification").execute()
        print("   ✅ Cleaned up test source")
    except Exception as e:
        print(f"   ⚠️ Could not clean up: {e}")


async def main():
    """Main function."""
    try:
        success = await verify_ollama()
        
        if success:
            # Ask if user wants to clean up
            response = input("\nDo you want to clean up the test data? (y/n): ")
            if response.lower() == 'y':
                await cleanup_test_data()
        
        return 0 if success else 1
        
    except KeyboardInterrupt:
        print("\n\n⚠️ Verification interrupted by user")
        return 1
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)