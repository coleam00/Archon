#!/usr/bin/env python3
"""
Test script for the new 1.2B-optimized code summary prompt.

Usage:
    uv run python test_code_summary_prompt.py

This tests the updated prompt in code_storage_service.py with various code samples.
"""

import asyncio
import json
import sys
from pathlib import Path

# Add src to path so we can import from server
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from server.services.storage.code_storage_service import _generate_code_example_summary_async

# Sample code blocks for testing
SAMPLE_CODE_BLOCKS = [
    {
        "name": "Python - Database Connection",
        "language": "python",
        "code": """import psycopg2
from psycopg2 import pool

def create_connection_pool(host, port, database, user, password):
    \"\"\"Create a PostgreSQL connection pool.\"\"\"
    return psycopg2.pool.SimpleConnectionPool(
        1, 20,
        host=host,
        port=port,
        database=database,
        user=user,
        password=password
    )""",
        "context_before": "Database utilities for the application.",
        "context_after": "Use this pool for all database operations.",
    },
    {
        "name": "TypeScript - API Fetch",
        "language": "typescript",
        "code": """async function fetchUserData(userId: string): Promise<User> {
  const response = await fetch(`/api/users/${userId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return await response.json();
}""",
        "context_before": "Client-side user management utilities.",
        "context_after": "Returns user object with profile data.",
    },
    {
        "name": "JavaScript - Form Validation",
        "language": "javascript",
        "code": """function validateEmail(email) {
  const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  return emailRegex.test(email);
}

function validateForm(formData) {
  const errors = {};

  if (!formData.email || !validateEmail(formData.email)) {
    errors.email = "Valid email required";
  }

  if (!formData.password || formData.password.length < 8) {
    errors.password = "Password must be at least 8 characters";
  }

  return errors;
}""",
        "context_before": "Form handling utilities for user registration.",
        "context_after": "Returns object with validation errors.",
    },
    {
        "name": "Python - List Comprehension",
        "language": "python",
        "code": """def filter_active_users(users):
    \"\"\"Filter list to only active users with verified emails.\"\"\"
    return [
        user for user in users
        if user.get('active') and user.get('email_verified')
    ]""",
        "context_before": "User management utilities.",
        "context_after": "Use for dashboard display.",
    },
    {
        "name": "Rust - Error Handling",
        "language": "rust",
        "code": """use std::fs::File;
use std::io::{self, Read};

fn read_file_contents(path: &str) -> Result<String, io::Error> {
    let mut file = File::open(path)?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    Ok(contents)
}""",
        "context_before": "File system utilities for configuration loading.",
        "context_after": "Returns file contents or IO error.",
    },
]


async def run_single_summary(sample: dict, provider: str = None):
    """Test summary generation for a single code sample."""
    print(f"\n{'=' * 80}")
    print(f"Testing: {sample['name']}")
    print(f"Language: {sample['language']}")
    print(f"{'=' * 80}")

    print("\nCode snippet (first 200 chars):")
    print(f"{sample['code'][:200]}...")

    try:
        result = await _generate_code_example_summary_async(
            code=sample["code"],
            context_before=sample["context_before"],
            context_after=sample["context_after"],
            language=sample["language"],
            provider=provider,
        )

        print("\n✅ SUCCESS - Generated summary:")
        print(f"   Example Name: {result['example_name']}")
        print(f"   Summary: {result['summary']}")

        # Verify JSON structure
        assert "example_name" in result, "Missing 'example_name' field"
        assert "summary" in result, "Missing 'summary' field"
        assert len(result["example_name"]) > 0, "Empty 'example_name'"
        assert len(result["summary"]) > 0, "Empty 'summary'"

        # Check if summary follows the structured format
        has_purpose = "PURPOSE:" in result["summary"].upper() or "purpose" in result["summary"].lower()
        has_params = "PARAMETERS:" in result["summary"].upper() or "parameter" in result["summary"].lower()
        has_use = "USE WHEN:" in result["summary"].upper() or "use" in result["summary"].lower()

        structure_score = sum([has_purpose, has_params, has_use])
        print(f"   Structure indicators: {structure_score}/3 (PURPOSE/PARAMETERS/USE WHEN)")

        return True, result

    except Exception as e:
        print("\n❌ FAILED with error:")
        print(f"   {type(e).__name__}: {str(e)}")
        return False, None


async def main():
    """Run all tests."""
    print("=" * 80)
    print("CODE SUMMARY PROMPT TEST - 1.2B-Optimized Version")
    print("=" * 80)
    print("\nThis script tests the updated prompt in code_storage_service.py")
    print("Testing with various code samples across different languages...\n")

    # Allow provider override via command line
    provider = None
    if len(sys.argv) > 1:
        provider = sys.argv[1]
        print(f"Using provider: {provider}")
    else:
        print("Using default provider from settings")

    results = []

    for sample in SAMPLE_CODE_BLOCKS:
        success, result = await run_single_summary(sample, provider)
        results.append({"name": sample["name"], "language": sample["language"], "success": success, "result": result})

        # Small delay between tests to avoid rate limiting
        await asyncio.sleep(1)

    # Print summary
    print("\n" + "=" * 80)
    print("TEST SUMMARY")
    print("=" * 80)

    successful = sum(1 for r in results if r["success"])
    total = len(results)

    print(f"\nResults: {successful}/{total} tests passed")
    print("\nDetailed results:")

    for r in results:
        status = "✅ PASS" if r["success"] else "❌ FAIL"
        print(f"  {status} - {r['name']} ({r['language']})")
        if r["result"]:
            print(f"          Name: {r['result']['example_name']}")
            summary_preview = (
                r["result"]["summary"][:80] + "..." if len(r["result"]["summary"]) > 80 else r["result"]["summary"]
            )
            print(f"          Summary: {summary_preview}")

    # Export results to JSON for inspection
    output_file = Path(__file__).parent / "code_summary_test_results.json"
    with open(output_file, "w") as f:
        json.dump(results, f, indent=2)

    print(f"\n📄 Full results exported to: {output_file}")

    if successful == total:
        print("\n🎉 All tests passed!")
        return 0
    else:
        print(f"\n⚠️  {total - successful} test(s) failed")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
