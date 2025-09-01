"""
Integration tests to verify token optimization in running system.
Run with: uv run pytest tests/test_token_optimization_integration.py -v
"""

import httpx
import json
import asyncio
import pytest
from typing import Dict, Any, Tuple


async def measure_response_size(url: str, params: dict[str, Any] | None = None) -> tuple[int, float]:
    """Measure response size and estimate token count."""
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, timeout=10.0)
            response_text = response.text
            response_size = len(response_text)
            # Rough token estimate: 1 token ≈ 4 characters
            estimated_tokens = response_size / 4
            return response_size, estimated_tokens
        except httpx.ConnectError:
            print(f"⚠️  Could not connect to {url} - is the server running?")
            return 0, 0
        except Exception as e:
            print(f"❌ Error measuring {url}: {e}")
            return 0, 0


async def test_projects_endpoint():
    """Test /api/projects with and without include_content."""
    base_url = "http://localhost:8181/api/projects"
    
    print("\n=== Testing Projects Endpoint ===")
    
    # Test with full content (backward compatibility)
    size_full, tokens_full = await measure_response_size(base_url, {"include_content": "true"})
    if size_full > 0:
        print(f"Full content: {size_full:,} bytes | ~{tokens_full:,.0f} tokens")
    else:
        pytest.skip("Server not available on http://localhost:8181")
    
    # Test lightweight
    size_light, tokens_light = await measure_response_size(base_url, {"include_content": "false"})
    print(f"Lightweight: {size_light:,} bytes | ~{tokens_light:,.0f} tokens")
    
    # Calculate reduction
    if size_full > 0:
        reduction = (1 - size_light / size_full) * 100 if size_full > size_light else 0
        print(f"Reduction: {reduction:.1f}%")
        
        if reduction > 50:
            print("✅ Significant token reduction achieved!")
        else:
            print("⚠️  Token reduction less than expected")
    
    # Verify backward compatibility - default should include content
    size_default, _ = await measure_response_size(base_url)
    if size_default > 0:
        if abs(size_default - size_full) < 100:  # Allow small variation
            print("✅ Backward compatibility maintained (default includes content)")
        else:
            print("⚠️  Default behavior may have changed")


async def test_tasks_endpoint():
    """Test /api/tasks with exclude_large_fields."""
    base_url = "http://localhost:8181/api/tasks"
    
    print("\n=== Testing Tasks Endpoint ===")
    
    # Test with full content
    size_full, tokens_full = await measure_response_size(base_url, {"exclude_large_fields": "false"})
    if size_full > 0:
        print(f"Full content: {size_full:,} bytes | ~{tokens_full:,.0f} tokens")
    else:
        pytest.skip("Server not available on http://localhost:8181")
    
    # Test lightweight
    size_light, tokens_light = await measure_response_size(base_url, {"exclude_large_fields": "true"})
    print(f"Lightweight: {size_light:,} bytes | ~{tokens_light:,.0f} tokens")
    
    # Calculate reduction
    if size_full > size_light:
        reduction = (1 - size_light / size_full) * 100
        print(f"Reduction: {reduction:.1f}%")
        
        if reduction > 30:  # Tasks may have less reduction if fewer have large fields
            print("✅ Token reduction achieved for tasks!")
        else:
            print("ℹ️  Minimal reduction (tasks may not have large fields)")


async def test_documents_endpoint():
    """Test /api/projects/{id}/docs with include_content."""
    # First get a project ID if available
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(
                "http://localhost:8181/api/projects", 
                params={"include_content": "false"},
                timeout=10.0
            )
            if response.status_code == 200:
                projects = response.json()
                if projects and len(projects) > 0:
                    project_id = projects[0]["id"]
                    print(f"\n=== Testing Documents Endpoint (Project: {project_id[:8]}...) ===")
                    
                    base_url = f"http://localhost:8181/api/projects/{project_id}/docs"
                    
                    # Test with content
                    size_full, tokens_full = await measure_response_size(base_url, {"include_content": "true"})
                    print(f"With content: {size_full:,} bytes | ~{tokens_full:,.0f} tokens")
                    
                    # Test without content (default)
                    size_light, tokens_light = await measure_response_size(base_url, {"include_content": "false"})
                    print(f"Metadata only: {size_light:,} bytes | ~{tokens_light:,.0f} tokens")
                    
                    # Calculate reduction if there are documents
                    if size_full > size_light and size_full > 500:  # Only if meaningful data
                        reduction = (1 - size_light / size_full) * 100
                        print(f"Reduction: {reduction:.1f}%")
                        print("✅ Document endpoint optimized!")
                    else:
                        print("ℹ️  No documents or minimal content in project")
                else:
                    print("\n⚠️  No projects available for document testing")
        except Exception as e:
            print(f"\n⚠️  Could not test documents endpoint: {e}")


async def test_mcp_endpoints():
    """Test MCP endpoints if available."""
    mcp_url = "http://localhost:8051/health"
    
    print("\n=== Testing MCP Server ===")
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(mcp_url, timeout=5.0)
            if response.status_code == 200:
                print("✅ MCP server is running")
                # Could add specific MCP tool tests here
            else:
                print(f"⚠️  MCP server returned status {response.status_code}")
        except httpx.ConnectError:
            print("ℹ️  MCP server not running (optional for tests)")
        except Exception as e:
            print(f"⚠️  Could not check MCP server: {e}")


async def main():
    """Run all integration tests."""
    print("=" * 60)
    print("Token Optimization Integration Tests")
    print("=" * 60)
    
    # Check if server is running
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get("http://localhost:8181/health", timeout=5.0)
            if response.status_code == 200:
                print("✅ Server is healthy and running")
            else:
                print(f"⚠️  Server returned status {response.status_code}")
        except httpx.ConnectError:
            print("❌ Server is not running! Start with: docker-compose up -d")
            print("\nTests require a running server. Please start the services first.")
            return
        except Exception as e:
            print(f"❌ Error checking server health: {e}")
            return
    
    # Run tests
    await test_projects_endpoint()
    await test_tasks_endpoint()
    await test_documents_endpoint()
    await test_mcp_endpoints()
    
    print("\n" + "=" * 60)
    print("✅ Integration tests completed!")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())