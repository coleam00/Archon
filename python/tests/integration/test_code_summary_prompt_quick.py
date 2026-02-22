"""
Quick validation test for the optimized code summary prompt.

This test directly calls the code summarization function to validate
that the new prompt works correctly with Liquid 1.2B Instruct,
without requiring full crawl operations.
"""

import asyncio
import json
from datetime import datetime
from pathlib import Path

# Test code samples matching contribution guideline scenarios
TEST_SAMPLES = [
    {
        "name": "python_async_function",
        "code": """async def fetch_data(url: str, session: aiohttp.ClientSession) -> dict:
    \"\"\"Fetch JSON data from a URL.\"\"\"
    async with session.get(url) as response:
        response.raise_for_status()
        return await response.json()
""",
        "language": "python",
    },
    {
        "name": "typescript_react_component",
        "code": """export function UserProfile({ userId }: { userId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['user', userId],
    queryFn: () => fetchUser(userId),
  });

  if (isLoading) return <LoadingSpinner />;
  if (!data) return <ErrorMessage />;

  return (
    <div className="profile">
      <h2>{data.name}</h2>
      <p>{data.email}</p>
    </div>
  );
}
""",
        "language": "typescript",
    },
    {
        "name": "rust_error_handling",
        "code": """pub fn parse_config(path: &Path) -> Result<Config, ConfigError> {
    let content = fs::read_to_string(path)
        .map_err(|e| ConfigError::IoError(e))?;

    toml::from_str(&content)
        .map_err(|e| ConfigError::ParseError(e))
}
""",
        "language": "rust",
    },
]


async def test_prompt_directly():
    """Test the code summary prompt directly."""
    print("\n" + "=" * 80)
    print("CODE SUMMARY PROMPT - QUICK VALIDATION TEST")
    print("=" * 80)
    print(f"Started: {datetime.now().isoformat()}")

    # Import the function directly
    try:
        from src.server.services.storage.code_storage_service import (
            _generate_code_example_summary_async,
        )
    except ImportError as e:
        print(f"\n❌ Failed to import code summary function: {e}")
        print("\nPlease ensure you're running from the python/ directory")
        return

    results = []

    for sample in TEST_SAMPLES:
        print(f"\n{'=' * 80}")
        print(f"Testing: {sample['name']}")
        print(f"Language: {sample['language']}")
        print(f"{'=' * 80}")

        try:
            # Call the function directly
            result = await _generate_code_example_summary_async(
                code=sample["code"],
                context_before="",
                context_after="",
                language=sample["language"],
                provider=None,  # Use configured provider
            )

            print(f"\n✅ Summary generated:")
            print(f"   Example name: {result.get('example_name', 'N/A')}")
            print(f"   Summary: {result.get('summary', 'N/A')[:200]}...")

            # Validate structure
            has_example_name = bool(result.get("example_name"))
            has_summary = bool(result.get("summary"))

            # Check for structured format indicators
            summary_upper = result.get("summary", "").upper()
            has_purpose = "PURPOSE:" in summary_upper
            has_params = "PARAMETER" in summary_upper
            has_use = "USE WHEN:" in summary_upper or "USE:" in summary_upper

            structured = has_purpose or has_params or has_use

            results.append(
                {
                    "name": sample["name"],
                    "language": sample["language"],
                    "success": has_example_name and has_summary,
                    "structured_format": structured,
                    "result": result,
                }
            )

            print(f"\n   Validation:")
            print(f"   ✓ Has example_name: {has_example_name}")
            print(f"   ✓ Has summary: {has_summary}")
            print(
                f"   {'✓' if structured else '⚠'} Structured format: {structured}"
            )

        except Exception as e:
            print(f"\n❌ Error generating summary: {e}")
            import traceback

            traceback.print_exc()
            results.append(
                {
                    "name": sample["name"],
                    "language": sample["language"],
                    "success": False,
                    "error": str(e),
                }
            )

    # Summary
    print("\n" + "=" * 80)
    print("TEST SUMMARY")
    print("=" * 80)

    success_count = sum(1 for r in results if r.get("success", False))
    structured_count = sum(1 for r in results if r.get("structured_format", False))

    print(f"\n✅ Successful: {success_count}/{len(results)}")
    print(f"📝 Structured format: {structured_count}/{len(results)}")

    # Export results
    output_file = Path(__file__).parent / "code_summary_quick_test_results.json"
    with open(output_file, "w") as f:
        json.dump(
            {
                "timestamp": datetime.now().isoformat(),
                "summary": {
                    "total": len(results),
                    "successful": success_count,
                    "structured": structured_count,
                },
                "results": results,
            },
            f,
            indent=2,
        )

    print(f"\n📄 Results exported to: {output_file}")

    if success_count == len(results):
        print("\n🎉 All tests passed!")
    else:
        print(f"\n⚠️  {len(results) - success_count} test(s) failed")

    return results


if __name__ == "__main__":
    asyncio.run(test_prompt_directly())
