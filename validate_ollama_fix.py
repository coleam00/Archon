#!/usr/bin/env python3
"""
Validation script to test the Ollama contextual embeddings fix in the actual environment.
Run this after deploying the fix to verify it works correctly.
"""
import sys
import os
import asyncio

# Add the src directory to path (container environment)
sys.path.append('/app/src')

async def test_ollama_contextual_embeddings():
    """Test the actual Ollama contextual embeddings functionality"""
    print("=== Testing Ollama Contextual Embeddings Fix ===")
    
    try:
        # Import the services
        from server.services.embeddings.contextual_embedding_service import generate_contextual_embedding
        
        print("\n1. Testing model retrieval...")
        
        # Test with a small chunk
        test_document = """
        Ollama is a tool for running large language models locally. 
        It provides an API compatible with OpenAI's format, making it easy to integrate with existing applications.
        The tool supports various models including Llama, Qwen, and others.
        """
        
        test_chunk = "Ollama is a tool for running large language models locally."
        
        print("2. Calling generate_contextual_embedding...")
        print(f"Document preview: {test_document[:100]}...")
        print(f"Chunk: {test_chunk}")
        
        # This should work now with the fix
        contextual_text, success = await generate_contextual_embedding(
            full_document=test_document,
            chunk=test_chunk,
            provider="ollama"  # Explicitly use Ollama
        )
        
        if success:
            print("✅ SUCCESS: Contextual embedding generated successfully!")
            print(f"Original chunk length: {len(test_chunk)}")
            print(f"Contextual text length: {len(contextual_text)}")
            print("✅ Ollama chat model is working properly")
        else:
            print("❌ FAILED: Contextual embedding failed")
            print("Check logs for specific error messages")
            
    except Exception as e:
        print(f"❌ Error during test: {e}")
        import traceback
        traceback.print_exc()
        
        # Check if it's the original "model is required" error
        if "model is required" in str(e):
            print("❌ ISSUE: The original 'model is required' error still occurs")
            print("   The fix may not have been applied correctly")
        else:
            print("   This appears to be a different error (possibly environment-related)")

async def validate_configuration():
    """Validate that the configuration is set up correctly"""
    print("\n=== Configuration Validation ===")
    
    try:
        from server.services.credential_service import credential_service
        
        # Check provider configuration
        provider_config = await credential_service.get_active_provider("llm")
        print(f"Active provider: {provider_config.get('provider', 'NOT SET')}")
        print(f"Base URL: {provider_config.get('base_url', 'NOT SET')}")
        print(f"Chat model: '{provider_config.get('chat_model', 'EMPTY')}'")
        
        # Check specific Ollama settings
        try:
            ollama_chat_model = await credential_service.get_credential("OLLAMA_CHAT_MODEL")
            print(f"OLLAMA_CHAT_MODEL: {ollama_chat_model or 'NOT SET'}")
        except:
            print("OLLAMA_CHAT_MODEL: NOT ACCESSIBLE")
            
        # Check model choice fallback
        from server.services.embeddings.contextual_embedding_service import _get_model_choice
        model = await _get_model_choice()
        print(f"Final model choice: '{model}'")
        
        if model and model.strip():
            print("✅ Model configuration looks good")
        else:
            print("❌ Model configuration still has issues")
            
    except Exception as e:
        print(f"❌ Error validating configuration: {e}")

if __name__ == "__main__":
    print("Starting Ollama contextual embeddings validation...")
    print("This will test the fix against your actual environment.")
    
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    
    try:
        loop.run_until_complete(validate_configuration())
        loop.run_until_complete(test_ollama_contextual_embeddings())
    finally:
        loop.close()
    
    print("\n=== Validation Complete ===")
    print("If you see '✅ SUCCESS' messages, the fix is working correctly!")
    print("If you see '❌ FAILED' messages, check the error details above.")