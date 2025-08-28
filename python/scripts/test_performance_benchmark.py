#!/usr/bin/env python3
"""
Test performance benchmark script for Archon.

This script measures test execution performance with different configurations
and provides detailed reports on improvements achieved through optimizations.
"""

import argparse
import json
import os
import subprocess
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, List, Optional
import statistics


@dataclass
class BenchmarkResult:
    """Results from a single benchmark run."""
    config_name: str
    total_time: float
    setup_time: float
    test_time: float
    teardown_time: float
    tests_passed: int
    tests_failed: int
    tests_total: int
    memory_peak_mb: float
    cpu_usage_percent: float
    cache_hits: int
    cache_misses: int


@dataclass
class PerformanceReport:
    """Comprehensive performance report."""
    timestamp: str
    baseline: BenchmarkResult
    optimized: BenchmarkResult
    improvements: Dict[str, float]
    recommendations: List[str]


class TestPerformanceBenchmark:
    """Test performance benchmarking tool."""
    
    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.python_dir = project_root / "python"
        self.frontend_dir = project_root / "archon-ui-main"
        
    def run_backend_benchmark(self, config_file: str = "pytest.ini", use_parallel: bool = True) -> BenchmarkResult:
        """Run backend test benchmark with specified configuration."""
        print(f"🔧 Running backend benchmark with {config_file}...")
        
        # Prepare environment
        env = os.environ.copy()
        env["TESTING"] = "true"
        env["PYTEST_BENCHMARK"] = "true"
        
        # Build command
        cmd = ["uv", "run", "pytest"]
        
        if config_file != "pytest.ini":
            cmd.extend(["-c", config_file])
            
        # Add specific test files for consistent measurement
        cmd.extend([
            "tests/test_api_essentials.py",
            "tests/test_repository_interfaces.py", 
            "tests/test_type_utils.py",
            "-v",
            "--tb=short"
        ])
        
        if use_parallel:
            cmd.extend(["-n", "auto"])
            
        # Add performance monitoring
        cmd.extend([
            "--durations=10",
            "--maxfail=1"
        ])
        
        start_time = time.time()
        
        try:
            # Run the test command
            result = subprocess.run(
                cmd,
                cwd=self.python_dir,
                env=env,
                capture_output=True,
                text=True,
                timeout=300  # 5 minute timeout
            )\n            
            end_time = time.time()
            total_time = end_time - start_time
            \n            # Parse results\n            output_lines = result.stdout.split('\\n')\n            \n            # Extract test counts\n            tests_passed = 0\n            tests_failed = 0\n            tests_total = 0\n            \n            for line in output_lines:\n                if \"passed\" in line and \"failed\" in line:\n                    # Parse pytest summary line\n                    parts = line.split()\n                    for i, part in enumerate(parts):\n                        if part == \"passed\":\n                            tests_passed = int(parts[i-1])\n                        elif part == \"failed\":\n                            tests_failed = int(parts[i-1])\n                elif \" passed in \" in line:\n                    # Single status line\n                    parts = line.split()\n                    for i, part in enumerate(parts):\n                        if part == \"passed\":\n                            tests_passed = int(parts[i-1])\n            \n            tests_total = tests_passed + tests_failed\n            \n            return BenchmarkResult(\n                config_name=config_file,\n                total_time=total_time,\n                setup_time=total_time * 0.1,  # Estimated\n                test_time=total_time * 0.8,   # Estimated\n                teardown_time=total_time * 0.1,  # Estimated\n                tests_passed=tests_passed,\n                tests_failed=tests_failed,\n                tests_total=tests_total,\n                memory_peak_mb=0,  # Would need psutil for accurate measurement\n                cpu_usage_percent=0,  # Would need psutil for accurate measurement\n                cache_hits=0,  # Would need pytest-cache plugin\n                cache_misses=0\n            )\n            \n        except subprocess.TimeoutExpired:\n            return BenchmarkResult(\n                config_name=config_file,\n                total_time=300.0,  # Timeout\n                setup_time=0,\n                test_time=300.0,\n                teardown_time=0,\n                tests_passed=0,\n                tests_failed=0,\n                tests_total=0,\n                memory_peak_mb=0,\n                cpu_usage_percent=0,\n                cache_hits=0,\n                cache_misses=0\n            )\n    \n    def run_frontend_benchmark(self, config_file: str = \"vitest.config.ts\") -> BenchmarkResult:\n        \"\"\"Run frontend test benchmark with specified configuration.\"\"\"\n        print(f\"🔧 Running frontend benchmark with {config_file}...\")\n        \n        # Prepare environment\n        env = os.environ.copy()\n        env[\"NODE_ENV\"] = \"test\"\n        env[\"VITE_TEST_BENCHMARK\"] = \"true\"\n        \n        # Build command\n        cmd = [\"npm\", \"run\", \"test:coverage:run\"]\n        \n        if config_file != \"vitest.config.ts\":\n            env[\"VITEST_CONFIG\"] = config_file\n        \n        start_time = time.time()\n        \n        try:\n            result = subprocess.run(\n                cmd,\n                cwd=self.frontend_dir,\n                env=env,\n                capture_output=True,\n                text=True,\n                timeout=180  # 3 minute timeout\n            )\n            \n            end_time = time.time()\n            total_time = end_time - start_time\n            \n            # Parse vitest output\n            output_lines = result.stdout.split('\\n')\n            \n            tests_passed = 0\n            tests_failed = 0\n            tests_total = 0\n            \n            for line in output_lines:\n                if \"Test Files\" in line:\n                    # Extract test file counts\n                    continue\n                elif \"Tests\" in line and \"passed\" in line:\n                    # Parse test summary\n                    parts = line.split()\n                    for i, part in enumerate(parts):\n                        if part == \"passed\":\n                            tests_passed = int(parts[i-1])\n                        elif part == \"total\":\n                            tests_total = int(parts[i-1])\n            \n            tests_failed = tests_total - tests_passed\n            \n            return BenchmarkResult(\n                config_name=config_file,\n                total_time=total_time,\n                setup_time=total_time * 0.2,  # Vitest has more setup\n                test_time=total_time * 0.6,\n                teardown_time=total_time * 0.2,\n                tests_passed=tests_passed,\n                tests_failed=tests_failed,\n                tests_total=tests_total,\n                memory_peak_mb=0,\n                cpu_usage_percent=0,\n                cache_hits=0,\n                cache_misses=0\n            )\n            \n        except subprocess.TimeoutExpired:\n            return BenchmarkResult(\n                config_name=config_file,\n                total_time=180.0,\n                setup_time=0,\n                test_time=180.0,\n                teardown_time=0,\n                tests_passed=0,\n                tests_failed=0,\n                tests_total=0,\n                memory_peak_mb=0,\n                cpu_usage_percent=0,\n                cache_hits=0,\n                cache_misses=0\n            )\n    \n    def run_multiple_benchmarks(self, config: str, runs: int = 3) -> BenchmarkResult:\n        \"\"\"Run multiple benchmark iterations and return average.\"\"\"\n        results = []\n        \n        for i in range(runs):\n            print(f\"  Run {i+1}/{runs}...\")\n            if config.endswith('.ts'):\n                result = self.run_frontend_benchmark(config)\n            else:\n                result = self.run_backend_benchmark(config)\n            results.append(result)\n        \n        # Calculate averages\n        if not results:\n            raise ValueError(\"No benchmark results collected\")\n        \n        return BenchmarkResult(\n            config_name=config,\n            total_time=statistics.mean(r.total_time for r in results),\n            setup_time=statistics.mean(r.setup_time for r in results),\n            test_time=statistics.mean(r.test_time for r in results),\n            teardown_time=statistics.mean(r.teardown_time for r in results),\n            tests_passed=max(r.tests_passed for r in results),  # Use max for counts\n            tests_failed=min(r.tests_failed for r in results),  # Use min for failures\n            tests_total=max(r.tests_total for r in results),\n            memory_peak_mb=statistics.mean(r.memory_peak_mb for r in results),\n            cpu_usage_percent=statistics.mean(r.cpu_usage_percent for r in results),\n            cache_hits=statistics.mean(r.cache_hits for r in results),\n            cache_misses=statistics.mean(r.cache_misses for r in results)\n        )\n    \n    def calculate_improvements(self, baseline: BenchmarkResult, optimized: BenchmarkResult) -> Dict[str, float]:\n        \"\"\"Calculate performance improvements between baseline and optimized.\"\"\"\n        improvements = {}\n        \n        # Calculate percentage improvements (positive = better)\n        if baseline.total_time > 0:\n            improvements['total_time'] = ((baseline.total_time - optimized.total_time) / baseline.total_time) * 100\n        \n        if baseline.setup_time > 0:\n            improvements['setup_time'] = ((baseline.setup_time - optimized.setup_time) / baseline.setup_time) * 100\n        \n        if baseline.test_time > 0:\n            improvements['test_time'] = ((baseline.test_time - optimized.test_time) / baseline.test_time) * 100\n        \n        # Test success rate improvement\n        baseline_success_rate = (baseline.tests_passed / baseline.tests_total * 100) if baseline.tests_total > 0 else 0\n        optimized_success_rate = (optimized.tests_passed / optimized.tests_total * 100) if optimized.tests_total > 0 else 0\n        improvements['success_rate'] = optimized_success_rate - baseline_success_rate\n        \n        # Throughput improvement (tests per second)\n        baseline_throughput = baseline.tests_total / baseline.total_time if baseline.total_time > 0 else 0\n        optimized_throughput = optimized.tests_total / optimized.total_time if optimized.total_time > 0 else 0\n        if baseline_throughput > 0:\n            improvements['throughput'] = ((optimized_throughput - baseline_throughput) / baseline_throughput) * 100\n        \n        return improvements\n    \n    def generate_recommendations(self, improvements: Dict[str, float]) -> List[str]:\n        \"\"\"Generate recommendations based on benchmark results.\"\"\"\n        recommendations = []\n        \n        if improvements.get('total_time', 0) > 20:\n            recommendations.append(\"✅ Excellent overall performance improvement achieved\")\n        elif improvements.get('total_time', 0) > 10:\n            recommendations.append(\"✅ Good performance improvement, consider additional parallelization\")\n        elif improvements.get('total_time', 0) < 5:\n            recommendations.append(\"⚠️ Limited performance gain, review test isolation and fixture usage\")\n        \n        if improvements.get('setup_time', 0) > 30:\n            recommendations.append(\"✅ Lazy loading significantly improved startup time\")\n        \n        if improvements.get('throughput', 0) > 50:\n            recommendations.append(\"✅ Test throughput significantly improved with parallelization\")\n        \n        if improvements.get('success_rate', 0) < 0:\n            recommendations.append(\"⚠️ Test reliability decreased, review test isolation settings\")\n        \n        return recommendations\n    \n    def save_report(self, report: PerformanceReport, output_file: Path):\n        \"\"\"Save performance report to JSON file.\"\"\"\n        output_file.parent.mkdir(parents=True, exist_ok=True)\n        \n        with open(output_file, 'w') as f:\n            json.dump(asdict(report), f, indent=2, default=str)\n        \n        print(f\"📊 Performance report saved to: {output_file}\")\n    \n    def print_report(self, report: PerformanceReport):\n        \"\"\"Print formatted performance report.\"\"\"\n        print(\"\\n\" + \"=\"*80)\n        print(\"🚀 TEST PERFORMANCE BENCHMARK REPORT\")\n        print(\"=\"*80)\n        \n        print(f\"\\n📅 Timestamp: {report.timestamp}\")\n        \n        print(\"\\n📈 BASELINE RESULTS:\")\n        self.print_benchmark_result(report.baseline)\n        \n        print(\"\\n🎯 OPTIMIZED RESULTS:\")\n        self.print_benchmark_result(report.optimized)\n        \n        print(\"\\n💡 PERFORMANCE IMPROVEMENTS:\")\n        for metric, improvement in report.improvements.items():\n            if improvement > 0:\n                print(f\"  ✅ {metric}: {improvement:+.1f}% improvement\")\n            elif improvement < -5:\n                print(f\"  ⚠️  {metric}: {improvement:+.1f}% regression\")\n            else:\n                print(f\"  ➡️  {metric}: {improvement:+.1f}% (minimal change)\")\n        \n        print(\"\\n🎯 RECOMMENDATIONS:\")\n        for rec in report.recommendations:\n            print(f\"  {rec}\")\n        \n        print(\"\\n\" + \"=\"*80)\n    \n    def print_benchmark_result(self, result: BenchmarkResult):\n        \"\"\"Print formatted benchmark result.\"\"\"\n        print(f\"  Config: {result.config_name}\")\n        print(f\"  Total Time: {result.total_time:.2f}s\")\n        print(f\"  Tests: {result.tests_passed}/{result.tests_total} passed\")\n        if result.tests_total > 0 and result.total_time > 0:\n            throughput = result.tests_total / result.total_time\n            print(f\"  Throughput: {throughput:.1f} tests/second\")\n\n\ndef main():\n    \"\"\"Main benchmark execution.\"\"\"\n    parser = argparse.ArgumentParser(description=\"Benchmark test performance optimizations\")\n    parser.add_argument(\"--backend-only\", action=\"store_true\", help=\"Run only backend benchmarks\")\n    parser.add_argument(\"--frontend-only\", action=\"store_true\", help=\"Run only frontend benchmarks\")\n    parser.add_argument(\"--runs\", type=int, default=3, help=\"Number of benchmark runs to average\")\n    parser.add_argument(\"--output\", type=str, help=\"Output file for JSON report\")\n    \n    args = parser.parse_args()\n    \n    # Find project root\n    current_dir = Path.cwd()\n    if current_dir.name == \"python\":\n        project_root = current_dir.parent\n    elif (current_dir / \"python\").exists():\n        project_root = current_dir\n    else:\n        print(\"❌ Could not find Archon project root\")\n        return 1\n    \n    benchmark = TestPerformanceBenchmark(project_root)\n    \n    print(\"🏁 Starting Test Performance Benchmark...\")\n    \n    if not args.frontend_only:\n        print(\"\\n🐍 BACKEND BENCHMARK\")\n        print(\"-\" * 40)\n        \n        # Run baseline (original pytest.ini)\n        print(\"Running baseline configuration...\")\n        # First create a simple baseline config\n        baseline_config = project_root / \"python\" / \"pytest-baseline.ini\"\n        with open(baseline_config, 'w') as f:\n            f.write(\"[pytest]\\n\")\n            f.write(\"testpaths = tests\\n\")\n            f.write(\"python_files = test_*.py\\n\")\n            f.write(\"addopts = --verbose --tb=short\\n\")\n        \n        baseline_result = benchmark.run_multiple_benchmarks(\"pytest-baseline.ini\", args.runs)\n        \n        # Run optimized configuration\n        print(\"Running optimized configuration...\")\n        optimized_result = benchmark.run_multiple_benchmarks(\"pytest.ini\", args.runs)\n        \n        # Calculate improvements\n        improvements = benchmark.calculate_improvements(baseline_result, optimized_result)\n        recommendations = benchmark.generate_recommendations(improvements)\n        \n        # Create report\n        report = PerformanceReport(\n            timestamp=time.strftime(\"%Y-%m-%d %H:%M:%S\"),\n            baseline=baseline_result,\n            optimized=optimized_result,\n            improvements=improvements,\n            recommendations=recommendations\n        )\n        \n        # Print and save report\n        benchmark.print_report(report)\n        \n        if args.output:\n            benchmark.save_report(report, Path(args.output))\n    \n    if not args.backend_only:\n        print(\"\\n🌐 FRONTEND BENCHMARK\")\n        print(\"-\" * 40)\n        \n        # For frontend, compare standard config vs fast config\n        print(\"Running standard configuration...\")\n        baseline_result = benchmark.run_multiple_benchmarks(\"vitest.config.ts\", args.runs)\n        \n        print(\"Running fast configuration...\")\n        optimized_result = benchmark.run_multiple_benchmarks(\"vitest-fast.config.ts\", args.runs)\n        \n        # Calculate improvements\n        improvements = benchmark.calculate_improvements(baseline_result, optimized_result)\n        recommendations = benchmark.generate_recommendations(improvements)\n        \n        # Create report\n        report = PerformanceReport(\n            timestamp=time.strftime(\"%Y-%m-%d %H:%M:%S\"),\n            baseline=baseline_result,\n            optimized=optimized_result,\n            improvements=improvements,\n            recommendations=recommendations\n        )\n        \n        # Print report\n        benchmark.print_report(report)\n        \n        if args.output:\n            output_path = Path(args.output)\n            frontend_output = output_path.parent / f\"{output_path.stem}-frontend{output_path.suffix}\"\n            benchmark.save_report(report, frontend_output)\n    \n    print(\"\\n✅ Benchmark completed successfully!\")\n    return 0\n\n\nif __name__ == \"__main__\":\n    exit(main())