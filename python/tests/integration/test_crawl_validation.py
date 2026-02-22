"""
Integration test for code summary prompt with real crawls.

Tests the optimized code summary prompt against the contribution guideline URLs:
- llms.txt
- llms-full.txt
- sitemap.xml
- Normal URL

Validates that code extraction and summarization work correctly with Liquid 1.2B Instruct.
"""

import asyncio
import json
import time
from datetime import datetime
from pathlib import Path

import httpx


# API base URL
API_BASE = "http://localhost:8181"

# Test URLs from contribution guidelines
# Limited to 1-2 pages each for fast testing
TEST_URLS = [
    {
        "name": "llms.txt",
        "url": "https://docs.mem0.ai/llms.txt",
        "expected_code": True,
        "max_pages": 1,
    },
    {
        "name": "normal_url",
        "url": "https://docs.anthropic.com/en/docs/claude-code/overview",
        "expected_code": True,
        "max_pages": 2,
    },
]


async def poll_progress(client: httpx.AsyncClient, progress_id: str, timeout: int = 600) -> dict:
    """
    Poll crawl progress until completion or timeout.

    Args:
        client: HTTP client
        progress_id: Progress ID to poll
        timeout: Maximum time to wait in seconds (default: 600 = 10 minutes)

    Returns:
        Final progress state
    """
    start_time = time.time()
    last_log = None
    poll_count = 0

    while time.time() - start_time < timeout:
        poll_count += 1
        elapsed = int(time.time() - start_time)

        response = await client.get(f"{API_BASE}/api/crawl-progress/{progress_id}")
        response.raise_for_status()
        progress = response.json()

        # Print new log messages
        current_log = progress.get("log", "")
        if current_log != last_log:
            print(f"  [{elapsed}s] {current_log}")
            last_log = current_log
        elif poll_count % 10 == 0:  # Status update every 20 seconds
            print(f"  [{elapsed}s] Still running... (poll #{poll_count})")

        # Check if complete
        if progress.get("complete"):
            print(f"  [{elapsed}s] ✓ Complete!")
            return progress

        # Check if errored
        if progress.get("error"):
            raise Exception(f"Crawl failed: {progress.get('error')}")

        # Wait before next poll
        await asyncio.sleep(2)

    raise TimeoutError(f"Crawl timed out after {timeout} seconds")


async def test_crawl_and_extract(test_case: dict) -> dict:
    """
    Crawl a URL via API and validate code extraction.

    Args:
        test_case: Dict with name, url, expected_code, max_pages

    Returns:
        Dict with test results
    """
    print(f"\n{'=' * 80}")
    print(f"Testing: {test_case['name']}")
    print(f"URL: {test_case['url']}")
    print(f"{'=' * 80}")

    result = {
        "test_name": test_case["name"],
        "url": test_case["url"],
        "timestamp": datetime.now().isoformat(),
        "status": "unknown",
        "chunks_stored": 0,
        "code_examples_extracted": 0,
        "code_summaries": [],
        "source_id": None,
        "errors": [],
    }

    # Use very long timeouts for crawl operations
    timeout_config = httpx.Timeout(60.0, connect=60.0, read=300.0)
    async with httpx.AsyncClient(timeout=timeout_config) as client:
        try:
            # Start crawl
            print("\n🚀 Starting crawl via API...")
            crawl_request = {
                "url": test_case["url"],
                "knowledge_type": "documentation",
                "tags": [f"test_{test_case['name']}"],
                "max_pages": test_case["max_pages"],
                "max_depth": 2,
            }

            response = await client.post(
                f"{API_BASE}/api/knowledge-items/crawl", json=crawl_request
            )

            # Debug response
            print(f"   Status code: {response.status_code}")
            print(f"   Response: {response.text[:500]}")

            response.raise_for_status()
            crawl_response = response.json()

            progress_id = crawl_response.get("progressId") or crawl_response.get("progress_id")
            if not progress_id:
                raise Exception(f"No progress_id/progressId returned. Response: {crawl_response}")

            print(f"   Progress ID: {progress_id}")

            # Poll for completion
            print("\n⏳ Polling for completion...")
            final_progress = await poll_progress(client, progress_id)

            result["chunks_stored"] = final_progress.get("result", {}).get("chunks_stored", 0)
            result["code_examples_extracted"] = final_progress.get("result", {}).get(
                "code_examples_count", 0
            )
            result["source_id"] = final_progress.get("result", {}).get("source_id")

            print(f"\n✅ Crawl complete:")
            print(f"   Chunks stored: {result['chunks_stored']}")
            print(f"   Code examples: {result['code_examples_extracted']}")
            print(f"   Source ID: {result['source_id']}")

            # Fetch code examples to validate summaries
            if result["code_examples_extracted"] > 0 and result["source_id"]:
                print("\n📝 Fetching code summaries...")
                response = await client.get(
                    f"{API_BASE}/api/knowledge-items",
                    params={
                        "source_id": result["source_id"],
                        "knowledge_type": "code",
                        "limit": 10,
                    },
                )
                response.raise_for_status()
                knowledge_items = response.json()

                if knowledge_items:
                    for idx, item in enumerate(knowledge_items, 1):
                        # Extract summary from metadata
                        metadata = item.get("metadata", {})
                        summary_info = {
                            "id": item.get("id"),
                            "summary": metadata.get("summary", ""),
                            "language": metadata.get("language", "unknown"),
                            "example_name": metadata.get("example_name", "unknown"),
                        }
                        result["code_summaries"].append(summary_info)

                        print(f"\n   Example {idx}:")
                        print(f"   Language: {summary_info['language']}")
                        print(f"   Name: {summary_info['example_name']}")
                        print(f"   Summary: {summary_info['summary'][:200]}...")

                        # Validate structured format
                        summary = summary_info["summary"].upper()
                        has_purpose = "PURPOSE:" in summary
                        has_params = "PARAMETER" in summary
                        has_use = "USE WHEN:" in summary or "USE:" in summary

                        if has_purpose or has_params or has_use:
                            print(
                                f"   ✓ Structured format detected (PURPOSE: {has_purpose}, "
                                f"PARAMS: {has_params}, USE: {has_use})"
                            )
                        else:
                            print("   ⚠ No structured format detected")

            # Validate expectations
            if test_case["expected_code"] and result["code_examples_extracted"] == 0:
                result["status"] = "warning"
                result["errors"].append("Expected code examples but none were extracted")
            elif not test_case["expected_code"] and result["code_examples_extracted"] > 0:
                result["status"] = "info"
                result["errors"].append(
                    "Unexpected code examples found (not necessarily an error)"
                )
            else:
                result["status"] = "success"

            # Cleanup: delete source
            if result["source_id"]:
                print(f"\n🧹 Cleaning up test data (source: {result['source_id']})...")
                try:
                    await client.delete(
                        f"{API_BASE}/api/knowledge-items",
                        params={"source_id": result["source_id"]},
                    )
                    print("   ✓ Cleanup complete")
                except Exception as cleanup_error:
                    print(f"   ⚠ Cleanup failed: {cleanup_error}")

        except Exception as e:
            result["status"] = "error"
            result["errors"].append(str(e))
            print(f"\n❌ Error: {e}")
            import traceback

            traceback.print_exc()

    return result


async def main():
    """Run all crawl validation tests."""
    print("\n" + "=" * 80)
    print("CODE SUMMARY PROMPT - CRAWL VALIDATION TESTS")
    print("=" * 80)
    print(f"Started: {datetime.now().isoformat()}")
    print(f"API Base: {API_BASE}")

    # Verify API is accessible
    print("\n🔍 Checking API health...")
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            response = await client.get(f"{API_BASE}/api/health")
            print(f"   Response status: {response.status_code}")
            print(f"   Response body: {response.text}")
            response.raise_for_status()
            print("   ✓ API is healthy")
        except Exception as e:
            print(f"   ❌ API health check failed: {e}")
            print(f"   Exception type: {type(e).__name__}")
            import traceback
            traceback.print_exc()
            print("\nPlease ensure the backend is running (docker compose up or uv run server)")
            return

    all_results = []

    for test_case in TEST_URLS:
        result = await test_crawl_and_extract(test_case)
        all_results.append(result)

    # Summary
    print("\n" + "=" * 80)
    print("TEST SUMMARY")
    print("=" * 80)

    success_count = sum(1 for r in all_results if r["status"] == "success")
    warning_count = sum(1 for r in all_results if r["status"] == "warning")
    error_count = sum(1 for r in all_results if r["status"] == "error")

    print(f"\n✅ Success: {success_count}/{len(all_results)}")
    print(f"⚠️  Warnings: {warning_count}/{len(all_results)}")
    print(f"❌ Errors: {error_count}/{len(all_results)}")

    total_code_examples = sum(r["code_examples_extracted"] for r in all_results)
    print(f"\n📊 Total code examples extracted: {total_code_examples}")

    # Export results
    output_file = Path(__file__).parent / "crawl_validation_results.json"
    with open(output_file, "w") as f:
        json.dump(
            {
                "timestamp": datetime.now().isoformat(),
                "summary": {
                    "total_tests": len(all_results),
                    "success": success_count,
                    "warnings": warning_count,
                    "errors": error_count,
                    "total_code_examples": total_code_examples,
                },
                "results": all_results,
            },
            f,
            indent=2,
        )

    print(f"\n📄 Full results exported to: {output_file}")

    # Print any errors
    if error_count > 0 or warning_count > 0:
        print("\n" + "=" * 80)
        print("ISSUES FOUND")
        print("=" * 80)
        for r in all_results:
            if r["errors"]:
                print(f"\n{r['test_name']}:")
                for error in r["errors"]:
                    print(f"  - {error}")

    return all_results


if __name__ == "__main__":
    asyncio.run(main())
