#!/usr/bin/env python3
"""
Baseline Performance Metrics for Archon MCP Tools.

Measures:
- Tool execution time (avg, p50, p95, p99)
- Database query performance
- Memory usage per tool call
- Concurrent tool execution limits
- Error rates by tool type

Usage:
    uv run python scripts/benchmark_mcp_tools.py
    uv run python scripts/benchmark_mcp_tools.py --iterations 100 --concurrent 10
"""

import asyncio
import argparse
import json
import os
import statistics
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import psutil

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.server.config.logfire_config import get_logger

logger = get_logger(__name__)

MCP_BASE_URL = os.getenv("ARCHON_MCP_URL",    "http://localhost:8051")
API_BASE_URL = os.getenv("ARCHON_SERVER_URL", "http://localhost:8181")


class PerformanceBenchmark:
    """Performance benchmarking for MCP tools and API."""

    def __init__(self, iterations: int = 50, concurrent: int = 5):
        self.iterations = iterations
        self.concurrent = concurrent
        self.results = {
            "mcp_tools": {},
            "api_endpoints": {},
            "database": {},
            "system": {},
            "errors": [],
        }

    async def benchmark_mcp_tool(
        self, tool_name: str, params: dict[str, Any]
    ) -> dict[str, Any]:
        """Benchmark a single MCP tool execution."""
        process = psutil.Process()
        mem_before = process.memory_info().rss / 1024 / 1024  # MB

        start_time = time.perf_counter()
        error = None

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{MCP_BASE_URL}/call_tool",
                    json={"name": tool_name, "arguments": params},
                )
                response.raise_for_status()
                result = response.json()

        except Exception as e:
            error = str(e)
            result = None

        end_time = time.perf_counter()
        mem_after = process.memory_info().rss / 1024 / 1024  # MB

        return {
            "duration_ms": (end_time - start_time) * 1000,
            "memory_delta_mb": mem_after - mem_before,
            "error": error,
            "success": error is None,
        }

    async def benchmark_api_endpoint(
        self, method: str, path: str, **kwargs
    ) -> dict[str, Any]:
        """Benchmark a single API endpoint."""
        process = psutil.Process()
        mem_before = process.memory_info().rss / 1024 / 1024  # MB

        start_time = time.perf_counter()
        error = None

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                if method == "GET":
                    response = await client.get(f"{API_BASE_URL}{path}", **kwargs)
                elif method == "POST":
                    response = await client.post(f"{API_BASE_URL}{path}", **kwargs)
                elif method == "PUT":
                    response = await client.put(f"{API_BASE_URL}{path}", **kwargs)

                response.raise_for_status()

        except Exception as e:
            error = str(e)

        end_time = time.perf_counter()
        mem_after = process.memory_info().rss / 1024 / 1024  # MB

        return {
            "duration_ms": (end_time - start_time) * 1000,
            "memory_delta_mb": mem_after - mem_before,
            "error": error,
            "success": error is None,
        }

    async def run_benchmark_suite(
        self, name: str, benchmark_func, iterations: int = None
    ) -> dict[str, Any]:
        """Run a benchmark suite and collect statistics."""
        iterations = iterations or self.iterations
        results = []

        for i in range(iterations):
            result = await benchmark_func()
            results.append(result)

            if (i + 1) % 10 == 0:
                logger.info(f"{name}: {i + 1}/{iterations} iterations complete")

        # Calculate statistics
        durations = [r["duration_ms"] for r in results if r["success"]]
        memory_deltas = [r["memory_delta_mb"] for r in results if r["success"]]
        errors = [r for r in results if not r["success"]]

        if durations:
            return {
                "iterations": iterations,
                "success_count": len(durations),
                "error_count": len(errors),
                "error_rate": len(errors) / iterations,
                "duration_ms": {
                    "min": min(durations),
                    "max": max(durations),
                    "mean": statistics.mean(durations),
                    "median": statistics.median(durations),
                    "p95": statistics.quantiles(durations, n=20)[18]
                    if len(durations) >= 20
                    else max(durations),
                    "p99": statistics.quantiles(durations, n=100)[98]
                    if len(durations) >= 100
                    else max(durations),
                },
                "memory_mb": {
                    "mean": statistics.mean(memory_deltas),
                    "max": max(memory_deltas),
                },
                "errors": [r["error"] for r in errors[:5]],  # First 5 errors
            }
        else:
            return {
                "iterations": iterations,
                "success_count": 0,
                "error_count": len(errors),
                "error_rate": 1.0,
                "errors": [r["error"] for r in errors[:10]],
            }

    async def benchmark_mcp_tools(self):
        """Benchmark common MCP tool operations."""
        logger.info("\n" + "=" * 60)
        logger.info("BENCHMARKING MCP TOOLS")
        logger.info("=" * 60)

        # Test find_tasks (list operation)
        logger.info("\n1. Testing find_tasks (list)...")
        self.results["mcp_tools"]["find_tasks_list"] = await self.run_benchmark_suite(
            "find_tasks",
            lambda: self.benchmark_mcp_tool(
                "find_tasks", {"filter_by": "status", "filter_value": "todo"}
            ),
        )

        # Test find_tasks (get single)
        logger.info("\n2. Testing find_tasks (get single)...")
        # Get a task ID first
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{API_BASE_URL}/api/tasks")
            tasks = response.json()
            if isinstance(tasks, dict):
                tasks = tasks.get("tasks", [])
            task_id = tasks[0]["id"] if tasks else None

        if task_id:
            self.results["mcp_tools"]["find_tasks_get"] = (
                await self.run_benchmark_suite(
                    "find_tasks(get)",
                    lambda: self.benchmark_mcp_tool("find_tasks", {"task_id": task_id}),
                )
            )

        # Test find_sessions
        logger.info("\n3. Testing find_sessions...")
        self.results["mcp_tools"]["find_sessions"] = await self.run_benchmark_suite(
            "find_sessions", lambda: self.benchmark_mcp_tool("find_sessions", {})
        )

        # Test manage_task (read-only via find)
        logger.info("\n4. Testing rag_search_knowledge_base...")
        self.results["mcp_tools"]["rag_search"] = await self.run_benchmark_suite(
            "rag_search",
            lambda: self.benchmark_mcp_tool(
                "rag_search_knowledge_base",
                {"query": "vector search", "match_count": 5},
            ),
            iterations=20,  # Fewer iterations for expensive operation
        )

    async def benchmark_api_endpoints(self):
        """Benchmark REST API endpoints."""
        logger.info("\n" + "=" * 60)
        logger.info("BENCHMARKING API ENDPOINTS")
        logger.info("=" * 60)

        # GET /api/tasks
        logger.info("\n1. Testing GET /api/tasks...")
        self.results["api_endpoints"]["get_tasks"] = await self.run_benchmark_suite(
            "GET /api/tasks",
            lambda: self.benchmark_api_endpoint("GET", "/api/tasks", params={"limit": 10}),
        )

        # GET /api/sessions
        logger.info("\n2. Testing GET /api/sessions...")
        self.results["api_endpoints"]["get_sessions"] = await self.run_benchmark_suite(
            "GET /api/sessions",
            lambda: self.benchmark_api_endpoint("GET", "/api/sessions", params={"limit": 10}),
        )

        # GET /api/projects
        logger.info("\n3. Testing GET /api/projects...")
        self.results["api_endpoints"]["get_projects"] = await self.run_benchmark_suite(
            "GET /api/projects",
            lambda: self.benchmark_api_endpoint("GET", "/api/projects"),
        )

    async def benchmark_concurrent_requests(self):
        """Test concurrent request handling."""
        logger.info("\n" + "=" * 60)
        logger.info(f"TESTING CONCURRENT REQUESTS ({self.concurrent} parallel)")
        logger.info("=" * 60)

        async def concurrent_task_requests():
            tasks = []
            for _ in range(self.concurrent):
                tasks.append(self.benchmark_api_endpoint("GET", "/api/tasks", params={"limit": 10}))

            results = await asyncio.gather(*tasks, return_exceptions=True)
            return {
                "duration_ms": max(r["duration_ms"] for r in results if isinstance(r, dict)),
                "success": all(r.get("success") for r in results if isinstance(r, dict)),
            }

        self.results["concurrent"] = await self.run_benchmark_suite(
            "Concurrent requests", concurrent_task_requests, iterations=20
        )

    def collect_system_metrics(self):
        """Collect system-level metrics."""
        logger.info("\n" + "=" * 60)
        logger.info("COLLECTING SYSTEM METRICS")
        logger.info("=" * 60)

        process = psutil.Process()
        self.results["system"] = {
            "cpu_percent": process.cpu_percent(interval=1.0),
            "memory_mb": process.memory_info().rss / 1024 / 1024,
            "threads": process.num_threads(),
            "connections": len(process.connections()),
        }

        logger.info(f"CPU: {self.results['system']['cpu_percent']:.1f}%")
        logger.info(f"Memory: {self.results['system']['memory_mb']:.1f} MB")
        logger.info(f"Threads: {self.results['system']['threads']}")
        logger.info(f"Connections: {self.results['system']['connections']}")

    def print_summary(self):
        """Print benchmark summary."""
        print("\n" + "=" * 80)
        print("PERFORMANCE BENCHMARK RESULTS")
        print("=" * 80)
        print(f"\nTimestamp: {datetime.now().isoformat()}")
        print(f"Iterations: {self.iterations}")
        print(f"Concurrent requests: {self.concurrent}")

        print("\n" + "-" * 80)
        print("MCP TOOLS")
        print("-" * 80)
        for tool_name, stats in self.results["mcp_tools"].items():
            if stats.get("duration_ms"):
                print(f"\n{tool_name}:")
                print(
                    f"  Success rate: {(1 - stats['error_rate']) * 100:.1f}% "
                    f"({stats['success_count']}/{stats['iterations']})"
                )
                print(f"  Duration (ms):")
                print(f"    Mean: {stats['duration_ms']['mean']:.2f}")
                print(f"    Median: {stats['duration_ms']['median']:.2f}")
                print(f"    P95: {stats['duration_ms']['p95']:.2f}")
                print(f"    P99: {stats['duration_ms']['p99']:.2f}")
                print(f"    Min: {stats['duration_ms']['min']:.2f}")
                print(f"    Max: {stats['duration_ms']['max']:.2f}")
                print(f"  Memory (MB): {stats['memory_mb']['mean']:.2f} avg")

        print("\n" + "-" * 80)
        print("API ENDPOINTS")
        print("-" * 80)
        for endpoint_name, stats in self.results["api_endpoints"].items():
            if stats.get("duration_ms"):
                print(f"\n{endpoint_name}:")
                print(
                    f"  Success rate: {(1 - stats['error_rate']) * 100:.1f}% "
                    f"({stats['success_count']}/{stats['iterations']})"
                )
                print(f"  Duration (ms):")
                print(f"    Mean: {stats['duration_ms']['mean']:.2f}")
                print(f"    Median: {stats['duration_ms']['median']:.2f}")
                print(f"    P95: {stats['duration_ms']['p95']:.2f}")

        print("\n" + "-" * 80)
        print("SYSTEM METRICS")
        print("-" * 80)
        print(f"CPU Usage: {self.results['system']['cpu_percent']:.1f}%")
        print(f"Memory: {self.results['system']['memory_mb']:.1f} MB")
        print(f"Threads: {self.results['system']['threads']}")
        print(f"Connections: {self.results['system']['connections']}")

        print("\n" + "=" * 80)

    def save_results(self, output_file: str = "benchmark_results.json"):
        """Save results to JSON file."""
        output_path = Path(__file__).parent.parent / "docs" / output_file
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with open(output_path, "w") as f:
            json.dump(
                {
                    "timestamp": datetime.now().isoformat(),
                    "config": {
                        "iterations": self.iterations,
                        "concurrent": self.concurrent,
                    },
                    "results": self.results,
                },
                f,
                indent=2,
            )

        logger.info(f"\n✓ Results saved to {output_path}")
        return output_path


async def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Benchmark Archon MCP tools and API performance"
    )
    parser.add_argument(
        "--iterations", type=int, default=50, help="Number of iterations per test"
    )
    parser.add_argument(
        "--concurrent", type=int, default=5, help="Number of concurrent requests to test"
    )
    parser.add_argument(
        "--output",
        type=str,
        default="benchmark_results.json",
        help="Output filename for results",
    )

    args = parser.parse_args()

    print("\n" + "=" * 80)
    print("ARCHON PERFORMANCE BENCHMARK")
    print("=" * 80)
    print(f"Iterations: {args.iterations}")
    print(f"Concurrent requests: {args.concurrent}")
    print("=" * 80)

    benchmark = PerformanceBenchmark(
        iterations=args.iterations, concurrent=args.concurrent
    )

    try:
        # Run benchmarks
        await benchmark.benchmark_api_endpoints()
        await benchmark.benchmark_mcp_tools()
        await benchmark.benchmark_concurrent_requests()
        benchmark.collect_system_metrics()

        # Print and save results
        benchmark.print_summary()
        output_file = benchmark.save_results(args.output)

        print(f"\n✓ Benchmark complete! Results saved to {output_file}")

    except KeyboardInterrupt:
        print("\n\nBenchmark interrupted by user")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Benchmark failed: {e}", exc_info=True)
        print(f"\n\nERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
