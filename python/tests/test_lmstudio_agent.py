"""
Test script for verifying LM-Studio chat provider integration with PydanticAI agents.

This test verifies:
1. LM-Studio model string is correctly processed by base_agent
2. Agent can be instantiated with lmstudio: prefix
3. Model preparation creates proper OpenAIChatModel
"""

import asyncio
import os
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from agents.base_agent import _prepare_model_for_agent
from agents.rag_agent import RagAgent, RagDependencies


def test_lmstudio_model_preparation():
    """Test that lmstudio: model strings are correctly processed."""
    print("Testing LM-Studio model preparation...")

    # Test with lmstudio prefix
    model_string = "lmstudio:llama-3.2-1b-instruct"
    result = _prepare_model_for_agent(model_string)

    # Result should be an OpenAIChatModel object, not a string
    from pydantic_ai.models.openai import OpenAIChatModel
    assert isinstance(result, OpenAIChatModel), f"Expected OpenAIChatModel, got {type(result)}"
    print(f"✓ LM-Studio model correctly prepared: {type(result).__name__}")

    # Test with openai prefix (should pass through as string)
    openai_string = "openai:gpt-4o"
    result2 = _prepare_model_for_agent(openai_string)
    assert isinstance(result2, str), f"Expected string for OpenAI, got {type(result2)}"
    print(f"✓ OpenAI model correctly passed through: {result2}")

    return True


def test_rag_agent_instantiation():
    """Test that RAG agent can be instantiated with LM-Studio model."""
    print("\nTesting RAG agent instantiation with LM-Studio...")

    # Set environment variable for base URL (if not already set)
    if not os.getenv("LM_STUDIO_BASE_URL"):
        os.environ["LM_STUDIO_BASE_URL"] = "http://localhost:1234/v1"

    try:
        # Create agent with LM-Studio model
        agent = RagAgent(model="lmstudio:llama-3.2-1b-instruct")
        print(f"✓ RAG agent created successfully with LM-Studio model")
        print(f"  Agent name: {agent.name}")
        print(f"  Model type: {type(agent.model).__name__}")

        # Verify the model is properly configured
        from pydantic_ai.models.openai import OpenAIChatModel
        assert isinstance(agent.model, OpenAIChatModel), "Agent model should be OpenAIChatModel"
        print(f"✓ Agent model is correctly configured as OpenAIChatModel")

        return True
    except Exception as e:
        print(f"✗ Failed to create RAG agent: {e}")
        import traceback
        traceback.print_exc()
        return False


async def test_lmstudio_connection_mock():
    """
    Mock test for LM-Studio connection.

    Note: This test doesn't actually connect to LM-Studio (which may not be running),
    but verifies that the agent configuration is correct.
    """
    print("\nTesting LM-Studio agent configuration (mock)...")

    try:
        # Create agent
        agent = RagAgent(model="lmstudio:llama-3.2-1b-instruct")

        # Verify agent's internal model configuration
        from pydantic_ai.models.openai import OpenAIChatModel
        assert isinstance(agent.model, OpenAIChatModel), "Model should be OpenAIChatModel"

        # Check that the underlying PydanticAI agent was created
        assert agent._agent is not None, "PydanticAI agent should be initialized"
        print(f"✓ Agent configuration is valid for LM-Studio")

        return True
    except Exception as e:
        print(f"✗ Agent configuration failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    """Run all tests."""
    print("=" * 60)
    print("LM-Studio Chat Provider Integration Tests")
    print("=" * 60)

    results = []

    # Test 1: Model preparation
    try:
        results.append(("Model Preparation", test_lmstudio_model_preparation()))
    except Exception as e:
        print(f"✗ Model preparation test failed: {e}")
        results.append(("Model Preparation", False))

    # Test 2: Agent instantiation
    try:
        results.append(("Agent Instantiation", test_rag_agent_instantiation()))
    except Exception as e:
        print(f"✗ Agent instantiation test failed: {e}")
        results.append(("Agent Instantiation", False))

    # Test 3: Mock connection test
    try:
        result = asyncio.run(test_lmstudio_connection_mock())
        results.append(("Agent Configuration", result))
    except Exception as e:
        print(f"✗ Agent configuration test failed: {e}")
        results.append(("Agent Configuration", False))

    # Summary
    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)

    for test_name, passed in results:
        status = "✓ PASSED" if passed else "✗ FAILED"
        print(f"{test_name}: {status}")

    all_passed = all(passed for _, passed in results)

    if all_passed:
        print("\n🎉 All tests passed!")
        return 0
    else:
        print("\n❌ Some tests failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
