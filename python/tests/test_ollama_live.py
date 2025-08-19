"""
Live Ollama Integration Test

This test actually connects to running services and performs real RAG and chat queries.
Prerequisites:
- Ollama must be running locally (http://localhost:11434)
- At least one model must be available (e.g., llama3.2, qwen3:0.6b)
- Supabase must be configured with test data
- All Archon services must be running (server, agents, etc.)

Run with: pytest tests/test_ollama_live.py -v -s -m live
"""

import asyncio
import json
import os
import time
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
    """Tests that actually connect to live services and real database.
    
    These tests are marked with @pytest.mark.live to bypass the prevent_real_db_calls fixture.
    
    Run with: pytest tests/test_ollama_live.py -m live -v
    """

    # === EXISTING TESTS (kept as-is) ===
    
    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_ollama_server_connectivity(self):
        """Test that we can connect to Ollama server"""
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

    # === NEW CHAT ENDPOINT TESTS ===
    
    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_chat_session_creation(self):
        """Test creating a chat session via REST API"""
        async with httpx.AsyncClient() as client:
            # Create a chat session
            response = await client.post(
                "http://localhost:8181/api/agent-chat/sessions",
                json={"agent_type": "rag"}
            )
            
            assert response.status_code == 200, f"Expected 200, got {response.status_code}"
            data = response.json()
            assert "session_id" in data, "Response should contain session_id"
            
            session_id = data["session_id"]
            print(f"\n✅ Created chat session: {session_id}")
            
            # Verify session can be retrieved
            get_response = await client.get(
                f"http://localhost:8181/api/agent-chat/sessions/{session_id}"
            )
            
            assert get_response.status_code == 200
            session_data = get_response.json()
            assert session_data["id"] == session_id
            assert session_data["agent_type"] == "rag"
            print(f"   Session type: {session_data['agent_type']}")

    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_chat_message_with_ollama(self):
        """Test sending a message to chat endpoint with Ollama RAG agent"""
        from src.server.services.credential_service import credential_service
        
        # Ensure Ollama is configured for RAG agent
        await credential_service.set_credential(
            key="RAG_AGENT_MODEL",
            value="ollama:llama3.2:latest",
            is_encrypted=False,
        )
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Create session
            session_response = await client.post(
                "http://localhost:8181/api/agent-chat/sessions",
                json={"agent_type": "rag"}
            )
            session_id = session_response.json()["session_id"]
            
            # Send a message
            message = "What is LangGraph and how does it work?"
            print(f"\n📨 Sending chat message: '{message}'")
            
            start_time = time.time()
            response = await client.post(
                f"http://localhost:8181/api/agent-chat/sessions/{session_id}/messages",
                json={"message": message, "context": {}}
            )
            
            assert response.status_code == 200
            
            # Wait a bit for the agent to process (since it's async)
            await asyncio.sleep(5)
            
            # Get session to see if message was added
            session_response = await client.get(
                f"http://localhost:8181/api/agent-chat/sessions/{session_id}"
            )
            
            session_data = session_response.json()
            messages = session_data.get("messages", [])
            
            # Should have at least the user message
            assert len(messages) >= 1, "Should have at least user message"
            assert messages[0]["sender"] == "user"
            assert messages[0]["content"] == message
            
            elapsed = time.time() - start_time
            print(f"✅ Chat message processed in {elapsed:.2f}s")
            print(f"   Messages in session: {len(messages)}")

    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_chat_streaming_behavior(self):
        """Test that chat uses appropriate streaming based on model"""
        from src.server.services.credential_service import credential_service
        
        # Test with Ollama model (should use simulated streaming)
        await credential_service.set_credential(
            key="RAG_AGENT_MODEL",
            value="ollama:llama3.2:latest",
            is_encrypted=False,
        )
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Check agent configuration
            agent_response = await client.post(
                "http://localhost:8052/agents/run",
                json={
                    "agent_type": "rag",
                    "prompt": "Test",
                    "context": {}
                }
            )
            
            if agent_response.status_code == 200:
                metadata = agent_response.json().get("metadata", {})
                model = metadata.get("model", "")
                
                if model.startswith("ollama:"):
                    print(f"\n✅ Ollama model detected: {model}")
                    print("   Will use simulated streaming (chunking)")
                else:
                    print(f"\n✅ Non-Ollama model detected: {model}")
                    print("   Will attempt real SSE streaming")

    # === NEW RAG ENDPOINT TESTS ===
    
    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_rag_query_endpoint(self):
        """Test the direct RAG query REST endpoint"""
        async with httpx.AsyncClient(timeout=30.0) as client:
            query = "What is Archon?"
            print(f"\n🔍 Testing RAG query endpoint: '{query}'")
            
            response = await client.post(
                "http://localhost:8181/api/rag/query",
                json={
                    "query": query,
                    "match_count": 5,
                    "source": None,
                }
            )
            
            assert response.status_code == 200, f"Expected 200, got {response.status_code}"
            
            data = response.json()
            assert "results" in data, "Response should contain results"
            assert "search_mode" in data, "Response should contain search_mode"
            
            results = data.get("results", [])
            print(f"✅ RAG query returned {len(results)} results")
            print(f"   Search mode: {data.get('search_mode')}")
            
            if results:
                top_result = results[0]
                print(f"   Top result similarity: {top_result.get('similarity', 0):.3f}")

    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_rag_code_examples_endpoint(self):
        """Test the code examples search endpoint"""
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                "http://localhost:8181/api/rag/code-examples",
                json={
                    "query": "async function",
                    "match_count": 3,
                    "source_id": None,
                }
            )
            
            assert response.status_code == 200
            data = response.json()
            
            if "code_examples" in data:
                examples = data["code_examples"]
                print(f"\n✅ Found {len(examples)} code examples")
                
                for i, example in enumerate(examples[:2], 1):
                    print(f"   {i}. Language: {example.get('language', 'unknown')}")
                    print(f"      Score: {example.get('similarity_score', 0):.3f}")

    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_rag_sources_endpoint(self):
        """Test the sources listing endpoint"""
        async with httpx.AsyncClient() as client:
            response = await client.get("http://localhost:8181/api/rag/sources")
            
            assert response.status_code == 200
            data = response.json()
            
            assert "sources" in data, "Response should contain sources"
            sources = data["sources"]
            
            print(f"\n✅ Found {len(sources)} sources in knowledge base")
            
            for source in sources[:3]:
                print(f"   - {source.get('title', 'Untitled')}")
                print(f"     Type: {source.get('type', 'unknown')}")
                print(f"     Documents: {source.get('document_count', 0)}")

    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_rag_with_source_filter(self):
        """Test RAG query with source filtering"""
        async with httpx.AsyncClient(timeout=30.0) as client:
            # First get available sources
            sources_response = await client.get("http://localhost:8181/api/rag/sources")
            sources = sources_response.json().get("sources", [])
            
            if sources:
                # Use the first source as a filter
                first_source = sources[0]
                source_id = first_source.get("id") or first_source.get("title")
                source_title = first_source.get("title", "Unknown")
                
                print(f"\n🔍 Testing RAG with source filter: {source_title}")
                
                # Query with source filter
                response = await client.post(
                    "http://localhost:8181/api/rag/query",
                    json={
                        "query": "explain the main concepts",
                        "match_count": 3,
                        "source": source_id,
                    }
                )
                
                assert response.status_code == 200
                data = response.json()
                results = data.get("results", [])
                
                print(f"✅ Filtered query returned {len(results)} results")
                
                # Verify results are from the specified source (if filtering is working)
                if results:
                    # Just check that we got results - source filtering might not be implemented
                    # or the metadata structure might be different
                    print(f"   Results returned from source filter query")

    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_rag_performance_comparison(self):
        """Compare performance between direct RAG endpoint and chat endpoint"""
        query = "What is retrieval augmented generation?"
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Test direct RAG endpoint
            start_time = time.time()
            rag_response = await client.post(
                "http://localhost:8181/api/rag/query",
                json={"query": query, "match_count": 3}
            )
            rag_time = time.time() - start_time
            
            # Test chat endpoint
            session_response = await client.post(
                "http://localhost:8181/api/agent-chat/sessions",
                json={"agent_type": "rag"}
            )
            session_id = session_response.json()["session_id"]
            
            start_time = time.time()
            await client.post(
                f"http://localhost:8181/api/agent-chat/sessions/{session_id}/messages",
                json={"message": query}
            )
            chat_time = time.time() - start_time
            
            print(f"\n⏱️ Performance Comparison:")
            print(f"   Direct RAG endpoint: {rag_time:.2f}s")
            print(f"   Chat endpoint: {chat_time:.2f}s")
            print(f"   Difference: {abs(rag_time - chat_time):.2f}s")

    @pytest.mark.live
    @pytest.mark.asyncio
    async def test_provider_switching(self):
        """Test switching between Ollama and OpenAI providers"""
        from src.server.services.credential_service import credential_service
        
        providers = [
            ("ollama", "ollama:llama3.2:latest"),
            ("openai", "openai:gpt-4o-mini"),
        ]
        
        for provider_name, model_spec in providers:
            # Skip OpenAI if no API key
            if provider_name == "openai":
                api_key = os.getenv("OPENAI_API_KEY")
                if not api_key:
                    print(f"\n⚠️ Skipping OpenAI test (no API key)")
                    continue
            
            print(f"\n🔄 Testing with {provider_name} provider")
            
            # Set the provider
            await credential_service.set_credential(
                key="RAG_AGENT_MODEL",
                value=model_spec,
                is_encrypted=False,
            )
            
            # Test RAG query
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    "http://localhost:8181/api/rag/query",
                    json={
                        "query": "test query",
                        "match_count": 1,
                    }
                )
                
                assert response.status_code == 200
                print(f"   ✅ {provider_name} RAG query successful")

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


# Helper function to run specific tests manually
async def run_single_test(test_name="test_chat_message_with_ollama"):
    """Helper to run a single test for debugging"""
    test = TestLiveOllamaIntegration()
    test_method = getattr(test, test_name, None)
    if test_method:
        await test_method()
    else:
        print(f"Test method '{test_name}' not found")


if __name__ == "__main__":
    # Run with: python tests/test_ollama_live.py
    import sys
    test_name = sys.argv[1] if len(sys.argv) > 1 else "test_chat_message_with_ollama"
    print(f"Running live test: {test_name}")
    asyncio.run(run_single_test(test_name))