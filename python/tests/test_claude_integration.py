"""Test Claude integration with prompt caching."""

import asyncio
import os

import pytest

# Skip all tests if Anthropic API key is not available
pytestmark = pytest.mark.skipif(
    not os.getenv("ANTHROPIC_API_KEY"), reason="ANTHROPIC_API_KEY not set"
)


@pytest.mark.asyncio
async def test_claude_service_initialization():
    """Test Claude service can initialize with API key."""
    from src.server.services.llm.claude_service import get_claude_service

    service = get_claude_service()
    result = await service.initialize()

    assert result is True, "Claude service should initialize successfully"
    assert service.available is True, "Claude service should be available"
    assert service.client is not None, "Claude client should be created"


@pytest.mark.asyncio
async def test_claude_message_creation():
    """Test creating a simple message with Claude."""
    from src.server.services.llm.claude_service import get_claude_service

    service = get_claude_service()
    await service.initialize()

    messages = [{"role": "user", "content": "What is 2+2? Answer with just the number."}]

    response = await service.create_message(
        messages=messages, max_tokens=100, use_caching=False  # Don't use caching for simple test
    )

    assert "content" in response, "Response should contain content"
    assert "usage" in response, "Response should contain usage stats"
    assert "4" in response["content"], "Response should contain the answer"


@pytest.mark.asyncio
async def test_claude_prompt_caching():
    """Test that prompt caching works with Claude."""
    from src.server.services.llm.claude_service import get_claude_service

    service = get_claude_service()
    await service.initialize()

    system_prompt = """You are a helpful assistant that answers questions about Python programming.

    Python is a high-level, interpreted programming language known for its simplicity and readability.
    It supports multiple programming paradigms including procedural, object-oriented, and functional programming.
    Python has a comprehensive standard library and a vast ecosystem of third-party packages.

    Common Python features include:
    - Dynamic typing
    - Automatic memory management
    - List comprehensions
    - Decorators
    - Context managers
    - Generators and iterators
    """

    messages = [{"role": "user", "content": "What is Python?"}]

    response1 = await service.create_message(
        messages=messages, system=system_prompt, max_tokens=200, use_caching=True
    )

    assert "usage" in response1
    cache_creation = response1["usage"].get("cache_creation_tokens", 0)
    assert cache_creation > 0, "First request should create cache"

    messages2 = [{"role": "user", "content": "What are Python decorators?"}]

    response2 = await service.create_message(
        messages=messages2, system=system_prompt, max_tokens=200, use_caching=True
    )

    cache_read = response2["usage"].get("cache_read_tokens", 0)
    assert cache_read > 0, "Second request should read from cache"

    print(f"\nCache stats:")
    print(f"  First request - Cache creation: {cache_creation} tokens")
    print(f"  Second request - Cache read: {cache_read} tokens")
    print(f"  Approximate savings: ~90% on cached tokens")


@pytest.mark.asyncio
async def test_model_router():
    """Test model router selects appropriate models."""
    from src.server.services.llm.model_router import get_model_router

    router = get_model_router()

    provider, model = router.select_model_for_rag(
        query="Simple question", context_length=500, enable_caching=True
    )
    assert provider == "claude"
    assert "haiku" in model.lower(), "Simple queries should use Haiku for speed"

    provider, model = router.select_model_for_rag(
        query="Complex question about programming", context_length=5000, enable_caching=True
    )
    assert provider == "claude"
    assert "sonnet" in model.lower(), "Complex queries with large context should use Sonnet"


@pytest.mark.asyncio
async def test_answer_generation_service():
    """Test answer generation service with Claude."""
    from src.server.services.llm.answer_generation_service import get_answer_generation_service

    service = get_answer_generation_service()

    search_results = [
        {
            "content": "Python is a high-level programming language created by Guido van Rossum.",
            "url": "https://example.com/python-intro",
        },
        {
            "content": "Python emphasizes code readability and uses significant whitespace.",
            "url": "https://example.com/python-features",
        },
    ]

    result = await service.generate_answer(
        query="What is Python?", search_results=search_results, use_claude=True, enable_caching=True
    )

    assert result["success"] is True, "Answer generation should succeed"
    assert "answer" in result, "Result should contain an answer"
    assert "usage" in result, "Result should contain usage stats"
    assert result["provider"] == "claude", "Should use Claude provider"
    assert len(result["answer"]) > 0, "Answer should not be empty"

    print(f"\nAnswer generated:")
    print(f"  Provider: {result['provider']}")
    print(f"  Model: {result['model']}")
    print(f"  Input tokens: {result['usage']['input_tokens']}")
    print(f"  Output tokens: {result['usage']['output_tokens']}")
    print(f"  Cache read: {result['usage']['cache_read_tokens']}")
    print(f"  Answer preview: {result['answer'][:100]}...")


if __name__ == "__main__":
    # Run tests manually for development
    print("Testing Claude integration...")

    async def run_all_tests():
        """Run all tests sequentially."""
        if not os.getenv("ANTHROPIC_API_KEY"):
            print("⚠️  ANTHROPIC_API_KEY not set. Skipping tests.")
            return

        print("\n1. Testing Claude service initialization...")
        await test_claude_service_initialization()
        print("✅ Initialization test passed")

        print("\n2. Testing message creation...")
        await test_claude_message_creation()
        print("✅ Message creation test passed")

        print("\n3. Testing prompt caching...")
        await test_claude_prompt_caching()
        print("✅ Prompt caching test passed")

        print("\n4. Testing model router...")
        await test_model_router()
        print("✅ Model router test passed")

        print("\n5. Testing answer generation...")
        await test_answer_generation_service()
        print("✅ Answer generation test passed")

        print("\n🎉 All tests passed!")

    asyncio.run(run_all_tests())
