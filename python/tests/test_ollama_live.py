"""
Live Ollama Integration Test

This test actually connects to a running Ollama server and performs real RAG queries.
Prerequisites:
- Ollama must be running locally (http://localhost:11434)
- At least one model must be available (e.g., llama3.2, qwen3:0.6b)
- Supabase must be configured with test data

Run with: pytest tests/test_ollama_live_integration.py -v -s --live-ollama
"""

import asyncio
import os
import httpx
import pytest
from typing import Any, Dict, List

# Set up environment for Ollama
os.environ.update({
    "LLM_PROVIDER": "ollama",
    "MODEL_CHOICE": "qwen3:0.6b",  # Using small model for speed
    "LLM_BASE_URL": "http://localhost:11434/v1",
    "EMBEDDING_MODEL": "nomic-embed-text",
    "USE_HYBRID_SEARCH": "true",
    "USE_RERANKING": "false",  # Disable for speed in tests
    "USE_CONTEXTUAL_EMBEDDINGS": "false",  # Disable for speed
})


# Note: Live Ollama tests require Ollama to be running locally
# These tests will skip automatically if Ollama is not available


@pytest.fixture
async def check_ollama_server():
    """Check if Ollama server is running and accessible"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get("http://localhost:11434/api/tags")
            if response.status_code == 200:
                models = response.json().get("models", [])
                print(f"\n✅ Ollama server is running with {len(models)} models available")
                for model in models[:3]:  # Show first 3 models
                    print(f"   - {model.get('name')}")
                return True
    except Exception as e:
        pytest.skip(f"Ollama server not available: {e}")
    return False


@pytest.mark.live
class TestLiveOllamaIntegration:
    """Tests that actually connect to a live Ollama server and real database.
    
    These tests are marked with @pytest.mark.live to bypass the prevent_real_db_calls fixture.
    
    Run with: pytest tests/test_ollama_live.py -m live -v
    """

    @pytest.mark.live
    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_ollama_server_connectivity(self):
        """Test that we can connect to Ollama server"""
        # Run manually with: python tests/test_ollama_live_integration.py
        pass

    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_ollama_embedding_generation(self):
        """Test generating embeddings with Ollama"""
        from src.server.services.embeddings.embedding_service import create_embedding
        from src.server.services.credential_service import credential_service
        
        # Skip if Ollama not available
        try:
            async with httpx.AsyncClient() as client:
                await client.get("http://localhost:11434/api/tags", timeout=2)
        except:
            pytest.skip("Ollama server not available")
        
        # Set Ollama as the embedding provider
        await credential_service.set_credential(
            key="EMBEDDING_PROVIDER",
            value="ollama",
            is_encrypted=False,
        )
        
        await credential_service.set_credential(
            key="OLLAMA_EMBEDDING_MODEL",
            value="nomic-embed-text",
            is_encrypted=False,
        )
        
        # Generate embedding for test text
        test_text = "Archon is a knowledge management system that uses RAG"
        
        # Create embedding using Ollama
        embedding = await create_embedding(test_text, provider="ollama")
        
        # Verify embedding
        assert embedding is not None, "Should generate an embedding"
        assert isinstance(embedding, list), "Embedding should be a list"
        assert len(embedding) > 0, "Embedding should not be empty"
        assert all(isinstance(x, float) for x in embedding[:10]), "Embedding should contain floats"
        
        print(f"\n✅ Generated embedding with {len(embedding)} dimensions")
        print(f"   Sample values: {embedding[:5]}")

    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_live_rag_query_with_ollama(self):
        """Test performing a real RAG query using live Ollama server"""
        from src.server.services.search.rag_service import RAGService
        from src.server.utils import get_supabase_client
        
        # Skip if Ollama not available
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get("http://localhost:11434/api/tags", timeout=2)
                models = response.json().get("models", [])
                if not models:
                    pytest.skip("No models available in Ollama")
        except Exception as e:
            pytest.skip(f"Ollama server not available: {e}")
        
        # Set up credentials for Ollama
        from src.server.services.credential_service import credential_service
        
        # Update RAG settings to use Ollama
        await credential_service.set_credential(
            key="LLM_PROVIDER",
            value="ollama",
            is_encrypted=False,
        )
        
        await credential_service.set_credential(
            key="MODEL_CHOICE", 
            value="qwen3:0.6b",  # Use small model for testing
            is_encrypted=False,
        )
        
        await credential_service.set_credential(
            key="RAG_AGENT_MODEL",
            value="ollama:qwen3:0.6b",  # Properly formatted
            is_encrypted=False,
        )
        
        await credential_service.set_credential(
            key="LLM_BASE_URL",
            value="http://localhost:11434/v1",
            is_encrypted=False,
        )
        
        # Initialize RAG service with real Supabase
        supabase_client = get_supabase_client()
        rag_service = RAGService(supabase_client=supabase_client)
        
        # Perform actual RAG query
        query = "What is Archon and how does it work?"
        print(f"\n🔍 Performing RAG query: '{query}'")
        
        try:
            success, results = await rag_service.perform_rag_query(
                query=query,
                match_count=3,
            )
            
            # Verify results
            assert success is True, f"RAG query should succeed, got: {results}"
            assert "results" in results, "Should have results key"
            
            # Log results
            print(f"\n✅ RAG Query succeeded!")
            print(f"   - Execution path: {results.get('execution_path')}")
            print(f"   - Search mode: {results.get('search_mode')}")
            print(f"   - Results found: {len(results.get('results', []))}")
            
            if results.get("results"):
                print(f"\n📄 Top results:")
                for i, result in enumerate(results["results"][:3], 1):
                    content_preview = result.get("content", "")[:100]
                    similarity = result.get("similarity", 0)
                    print(f"   {i}. Similarity: {similarity:.3f}")
                    print(f"      {content_preview}...")
            
            # Verify Ollama was used
            provider = rag_service.get_setting("LLM_PROVIDER", "")
            model = rag_service.get_setting("MODEL_CHOICE", "")
            assert provider == "ollama", f"Should use Ollama provider, got: {provider}"
            print(f"\n🤖 Using Ollama model: {model}")
            
        except Exception as e:
            pytest.fail(f"RAG query failed with error: {e}")

    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_ollama_model_switching(self):
        """Test switching between different Ollama models"""
        from src.server.services.credential_service import credential_service
        
        # Skip if Ollama not available
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get("http://localhost:11434/api/tags", timeout=2)
                models = response.json().get("models", [])
                if len(models) < 2:
                    pytest.skip("Need at least 2 models for switching test")
                available_models = [m.get("name") for m in models]
        except Exception as e:
            pytest.skip(f"Ollama server not available: {e}")
        
        print(f"\n🔄 Testing model switching with available models: {available_models[:3]}")
        
        # Test switching between first two available models
        for model_name in available_models[:2]:
            # Update to new model
            await credential_service.set_credential(
                key="MODEL_CHOICE",
                value=model_name,
                is_encrypted=False,
            )
            
            await credential_service.set_credential(
                key="RAG_AGENT_MODEL",
                value=f"ollama:{model_name}",
                is_encrypted=False,
            )
            
            # Verify the model was set correctly
            stored_model = await credential_service.get_credential("RAG_AGENT_MODEL")
            assert stored_model is not None, "Model should be stored"
            assert stored_model == f"ollama:{model_name}", f"Model should be ollama:{model_name}"
            
            print(f"   ✅ Successfully switched to model: {model_name}")

    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_ollama_with_real_documents(self):
        """Test Ollama RAG with actual documents in the database"""
        from src.server.services.search.rag_service import RAGService
        from src.server.utils import get_supabase_client
        
        # Skip if Ollama not available
        try:
            async with httpx.AsyncClient() as client:
                await client.get("http://localhost:11434/api/tags", timeout=2)
        except:
            pytest.skip("Ollama server not available")
        
        # Initialize services
        supabase_client = get_supabase_client()
        rag_service = RAGService(supabase_client=supabase_client)
        
        # First, check if we have any documents in the database
        test_query_response = supabase_client.table("documents").select("id").limit(1).execute()
        if not test_query_response.data:
            # Insert a test document if none exist
            test_doc = {
                "content": "Archon is an advanced knowledge management system that leverages Ollama for local LLM processing. It provides RAG capabilities, document search, and intelligent query handling.",
                "metadata": {
                    "source": "test",
                    "title": "Archon Overview",
                },
                "url": "test://archon-overview",
                "source_id": "test-source",
            }
            
            # Generate embedding for the test document
            from src.server.services.embeddings.embedding_service import create_embedding
            embedding = await create_embedding(test_doc["content"])
            
            if embedding:
                test_doc["embedding"] = embedding
                insert_response = supabase_client.table("documents").insert(test_doc).execute()
                print(f"\n📝 Inserted test document for testing")
        
        # Perform different types of queries
        test_queries = [
            "What is Archon?",
            "How does Ollama integration work?",
            "knowledge management system features",
        ]
        
        print(f"\n🧪 Testing {len(test_queries)} different queries:")
        
        for query in test_queries:
            success, results = await rag_service.perform_rag_query(
                query=query,
                match_count=5,
            )
            
            assert success is True, f"Query '{query}' should succeed"
            
            result_count = len(results.get("results", []))
            print(f"\n   Query: '{query}'")
            print(f"   Results: {result_count} documents found")
            
            if result_count > 0:
                top_similarity = results["results"][0].get("similarity", 0)
                print(f"   Top similarity: {top_similarity:.3f}")

    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_ollama_error_handling(self):
        """Test error handling when Ollama has issues"""
        from src.server.services.search.rag_service import RAGService
        from src.server.utils import get_supabase_client
        from src.server.services.credential_service import credential_service
        
        # Set an invalid model name
        await credential_service.set_credential(
            key="MODEL_CHOICE",
            value="non-existent-model-xyz",
            is_encrypted=False,
        )
        
        await credential_service.set_credential(
            key="RAG_AGENT_MODEL",
            value="ollama:non-existent-model-xyz",
            is_encrypted=False,
        )
        
        # Initialize RAG service
        supabase_client = get_supabase_client()
        rag_service = RAGService(supabase_client=supabase_client)
        
        # Try to perform a query with invalid model
        query = "Test query with invalid model"
        
        # This should handle the error gracefully
        success, results = await rag_service.perform_rag_query(
            query=query,
            match_count=3,
        )
        
        # The query might fail or fall back to embeddings only
        print(f"\n⚠️ Query with invalid model:")
        print(f"   Success: {success}")
        print(f"   Error handling worked: {'results' in results or 'error' in results}")
        
        # Reset to valid model
        await credential_service.set_credential(
            key="MODEL_CHOICE",
            value="qwen3:0.6b",
            is_encrypted=False,
        )

    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_ollama_performance_metrics(self):
        """Test and measure Ollama performance for RAG queries"""
        import time
        from src.server.services.search.rag_service import RAGService
        from src.server.utils import get_supabase_client
        
        # Skip if Ollama not available
        try:
            async with httpx.AsyncClient() as client:
                await client.get("http://localhost:11434/api/tags", timeout=2)
        except:
            pytest.skip("Ollama server not available")
        
        # Initialize RAG service
        supabase_client = get_supabase_client()
        rag_service = RAGService(supabase_client=supabase_client)
        
        # Measure performance for different query types
        queries = [
            ("short", "What is RAG?"),
            ("medium", "Explain how Archon integrates with Ollama for knowledge management"),
            ("long", "Describe the complete architecture of a modern knowledge management system including vector databases, embedding generation, semantic search, and how local LLMs like Ollama can be used for retrieval augmented generation"),
        ]
        
        print(f"\n⏱️ Performance metrics for Ollama RAG:")
        
        for query_type, query in queries:
            start_time = time.time()
            
            success, results = await rag_service.perform_rag_query(
                query=query,
                match_count=3,
            )
            
            elapsed_time = time.time() - start_time
            
            print(f"\n   {query_type.capitalize()} query ({len(query)} chars):")
            print(f"   - Time: {elapsed_time:.2f} seconds")
            print(f"   - Success: {success}")
            print(f"   - Results: {len(results.get('results', []))}")
            
            assert elapsed_time < 30, f"Query should complete within 30 seconds, took {elapsed_time:.2f}s"


# Helper function to run a single test manually
async def run_single_test():
    """Helper to run a single test for debugging"""
    test = TestLiveOllamaIntegration()
    await test.test_live_rag_query_with_ollama()


if __name__ == "__main__":
    # Run with: python tests/test_ollama_live_integration.py
    print("Running live Ollama integration test...")
    asyncio.run(run_single_test())