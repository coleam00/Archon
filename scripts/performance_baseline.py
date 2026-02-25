#!/usr/bin/env python3
"""
Archon Performance Baseline Testing

Measures and documents system performance metrics:
- MCP tool response times
- Database query performance
- API endpoint latency
- Concurrent request handling
- Calculates p50, p95, p99 percentiles

Usage:
    python scripts/performance_baseline.py
"""

import asyncio
import json
import os
import statistics
import time
from datetime import datetime
from typing import Any

import httpx

# Configuration
API_BASE_URL = os.getenv("ARCHON_SERVER_URL", "http://localhost:8181")
PROJECT_ID = "7c3528df-b1a2-4fde-9fee-68727c15b6c6"  # Shared Memory project
TIMEOUT = httpx.Timeout(30.0, connect=5.0)

# Test parameters
SINGLE_REQUEST_ITERATIONS = 20  # For latency measurement
CONCURRENT_REQUEST_COUNT = 10  # For concurrent load test


def calculate_percentiles(data: list[float]) -> dict[str, float]:
    """Calculate p50, p95, p99 percentiles."""
    if not data:
        return {"p50": 0, "p95": 0, "p99": 0, "mean": 0, "min": 0, "max": 0}

    sorted_data = sorted(data)
    return {
        "p50": statistics.quantiles(sorted_data, n=100)[49],  # Median
        "p95": statistics.quantiles(sorted_data, n=100)[94],
        "p99": statistics.quantiles(sorted_data, n=100)[98],
        "mean": statistics.mean(data),
        "min": min(data),
        "max": max(data),
        "count": len(data),
    }


async def measure_endpoint(
    client: httpx.AsyncClient,
    method: str,
    endpoint: str,
    iterations: int = SINGLE_REQUEST_ITERATIONS,
    **kwargs: Any,
) -> dict[str, Any]:
    """Measure response time for an endpoint."""
    latencies = []
    success_count = 0
    error_count = 0
    errors = []

    for _ in range(iterations):
        start = time.perf_counter()
        try:
            response = await client.request(method, f"{API_BASE_URL}{endpoint}", **kwargs)
            elapsed = (time.perf_counter() - start) * 1000  # Convert to ms

            if response.status_code < 400:
                success_count += 1
                latencies.append(elapsed)
            else:
                error_count += 1
                errors.append(f"HTTP {response.status_code}")
        except Exception as e:
            error_count += 1
            errors.append(str(e))
            elapsed = (time.perf_counter() - start) * 1000

        # Small delay between requests
        await asyncio.sleep(0.05)

    return {
        "endpoint": f"{method} {endpoint}",
        "iterations": iterations,
        "success_count": success_count,
        "error_count": error_count,
        "success_rate": (success_count / iterations) * 100 if iterations > 0 else 0,
        "latency_ms": calculate_percentiles(latencies),
        "errors": list(set(errors))[:5],  # Unique errors, max 5
    }


async def test_api_endpoints() -> dict[str, Any]:
    """Test core API endpoints."""
    print("\n" + "=" * 70)
    print("API ENDPOINT PERFORMANCE")
    print("=" * 70)

    results = {}

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        # 1. Health check
        print("\n📍 Testing: Health check...")
        results["health_check"] = await measure_endpoint(
            client, "GET", "/api/health"
        )

        # 2. Project list
        print("📍 Testing: List projects...")
        results["list_projects"] = await measure_endpoint(
            client, "GET", "/api/projects"
        )

        # 3. Specific project
        print("📍 Testing: Get specific project...")
        results["get_project"] = await measure_endpoint(
            client, "GET", f"/api/projects/{PROJECT_ID}"
        )

        # 4. Project tasks
        print("📍 Testing: Get project tasks...")
        results["get_project_tasks"] = await measure_endpoint(
            client, "GET", f"/api/projects/{PROJECT_ID}/tasks"
        )

        # 5. Task list (all)
        print("📍 Testing: List all tasks...")
        results["list_tasks"] = await measure_endpoint(
            client, "GET", "/api/tasks", params={"include_closed": "true"}
        )

        # 6. Task with filters
        print("📍 Testing: Filtered task list...")
        results["list_tasks_filtered"] = await measure_endpoint(
            client, "GET", "/api/tasks", params={"status": "todo", "per_page": "10"}
        )

        # 7. Knowledge sources
        print("📍 Testing: Get knowledge sources...")
        results["knowledge_sources"] = await measure_endpoint(
            client, "GET", "/api/knowledge-items/summary", params={"per_page": "10"}
        )

    return results


async def test_concurrent_requests() -> dict[str, Any]:
    """Test concurrent request handling."""
    print("\n" + "=" * 70)
    print("CONCURRENT REQUEST PERFORMANCE")
    print("=" * 70)

    async def single_request(client: httpx.AsyncClient, request_id: int) -> dict[str, Any]:
        """Make a single request and measure time."""
        endpoint = f"/api/projects/{PROJECT_ID}/tasks"
        start = time.perf_counter()
        try:
            response = await client.get(f"{API_BASE_URL}{endpoint}")
            elapsed = (time.perf_counter() - start) * 1000
            return {
                "request_id": request_id,
                "latency_ms": elapsed,
                "status_code": response.status_code,
                "success": response.status_code < 400,
            }
        except Exception as e:
            elapsed = (time.perf_counter() - start) * 1000
            return {
                "request_id": request_id,
                "latency_ms": elapsed,
                "error": str(e),
                "success": False,
            }

    print(f"\n📍 Testing: {CONCURRENT_REQUEST_COUNT} concurrent requests...")

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        start_time = time.perf_counter()

        # Launch all requests concurrently
        tasks = [single_request(client, i) for i in range(CONCURRENT_REQUEST_COUNT)]
        results = await asyncio.gather(*tasks)

        total_time = (time.perf_counter() - start_time) * 1000

    # Analyze results
    latencies = [r["latency_ms"] for r in results]
    success_count = sum(1 for r in results if r["success"])

    return {
        "concurrent_requests": CONCURRENT_REQUEST_COUNT,
        "total_time_ms": total_time,
        "requests_per_second": (CONCURRENT_REQUEST_COUNT / total_time) * 1000,
        "success_count": success_count,
        "error_count": CONCURRENT_REQUEST_COUNT - success_count,
        "success_rate": (success_count / CONCURRENT_REQUEST_COUNT) * 100,
        "latency_ms": calculate_percentiles(latencies),
    }


async def test_database_queries() -> dict[str, Any]:
    """Test database query performance by timing specific operations."""
    print("\n" + "=" * 70)
    print("DATABASE QUERY PERFORMANCE")
    print("=" * 70)

    results = {}

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        # 1. Simple query (health check - minimal DB access)
        print("\n📍 Testing: Simple query (health)...")
        results["simple_query"] = await measure_endpoint(
            client, "GET", "/api/health", iterations=30
        )

        # 2. Single record fetch (get specific task)
        print("📍 Testing: Single record fetch...")
        # First get a task ID
        response = await client.get(
            f"{API_BASE_URL}/api/projects/{PROJECT_ID}/tasks",
            params={"per_page": "1"}
        )
        tasks_data = response.json()
        if tasks_data and len(tasks_data) > 0:
            task_id = tasks_data[0]["id"]
            results["single_record_fetch"] = await measure_endpoint(
                client, "GET", f"/api/tasks/{task_id}", iterations=30
            )
        else:
            results["single_record_fetch"] = {"error": "No tasks found"}

        # 3. List query with pagination
        print("📍 Testing: Paginated list query...")
        results["paginated_list"] = await measure_endpoint(
            client, "GET", "/api/tasks",
            params={"per_page": "20", "page": "1"},
            iterations=30
        )

        # 4. Filtered query
        print("📍 Testing: Filtered query...")
        results["filtered_query"] = await measure_endpoint(
            client, "GET", "/api/tasks",
            params={"status": "todo", "per_page": "10"},
            iterations=30
        )

        # 5. Large result set
        print("📍 Testing: Large result set...")
        results["large_result_set"] = await measure_endpoint(
            client, "GET", "/api/tasks",
            params={"include_closed": "true", "per_page": "50"},
            iterations=20
        )

    return results


def format_results(results: dict[str, Any]) -> str:
    """Format results as markdown table."""
    lines = []

    lines.append("\n| Endpoint | P50 | P95 | P99 | Mean | Success Rate |")
    lines.append("|----------|-----|-----|-----|------|--------------|")

    for key, data in results.items():
        if "latency_ms" not in data:
            continue

        lat = data["latency_ms"]
        endpoint = data.get("endpoint", key)
        success_rate = data.get("success_rate", 100)

        lines.append(
            f"| {endpoint} | {lat['p50']:.1f}ms | {lat['p95']:.1f}ms | "
            f"{lat['p99']:.1f}ms | {lat['mean']:.1f}ms | {success_rate:.1f}% |"
        )

    return "\n".join(lines)


async def main():
    """Run all performance tests."""
    print("\n" + "=" * 70)
    print("ARCHON PERFORMANCE BASELINE TESTING")
    print("=" * 70)
    print(f"Timestamp: {datetime.now().isoformat()}")
    print(f"API Base URL: {API_BASE_URL}")
    print(f"Test Project: {PROJECT_ID}")
    print("=" * 70)

    all_results = {
        "timestamp": datetime.now().isoformat(),
        "test_configuration": {
            "api_base_url": API_BASE_URL,
            "project_id": PROJECT_ID,
            "single_request_iterations": SINGLE_REQUEST_ITERATIONS,
            "concurrent_request_count": CONCURRENT_REQUEST_COUNT,
        },
    }

    # Run tests
    all_results["api_endpoints"] = await test_api_endpoints()
    all_results["database_queries"] = await test_database_queries()
    all_results["concurrent_requests"] = await test_concurrent_requests()

    # Print summary
    print("\n" + "=" * 70)
    print("SUMMARY - API ENDPOINTS")
    print("=" * 70)
    print(format_results(all_results["api_endpoints"]))

    print("\n" + "=" * 70)
    print("SUMMARY - DATABASE QUERIES")
    print("=" * 70)
    print(format_results(all_results["database_queries"]))

    print("\n" + "=" * 70)
    print("SUMMARY - CONCURRENT REQUESTS")
    print("=" * 70)
    cr = all_results["concurrent_requests"]
    print(f"\nConcurrent Requests: {cr['concurrent_requests']}")
    print(f"Total Time: {cr['total_time_ms']:.1f}ms")
    print(f"Requests/Second: {cr['requests_per_second']:.1f}")
    print(f"Success Rate: {cr['success_rate']:.1f}%")
    print(f"\nLatency Percentiles:")
    lat = cr['latency_ms']
    print(f"  P50: {lat['p50']:.1f}ms")
    print(f"  P95: {lat['p95']:.1f}ms")
    print(f"  P99: {lat['p99']:.1f}ms")
    print(f"  Mean: {lat['mean']:.1f}ms")

    # Save to file
    output_file = "performance_baseline_results.json"
    with open(output_file, "w") as f:
        json.dump(all_results, f, indent=2)

    print("\n" + "=" * 70)
    print(f"✅ Results saved to: {output_file}")
    print("=" * 70)

    return all_results


if __name__ == "__main__":
    asyncio.run(main())
