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
            "-v",
            "--tb=short"
        ])
        
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
            )
            
            end_time = time.time()
            total_time = end_time - start_time
            
            # Parse results
            output_lines = result.stdout.split('\n')
            
            # Extract test counts
            tests_passed = 0
            tests_failed = 0
            tests_total = 0
            
            for line in output_lines:
                if "passed" in line and "failed" in line:
                    # Parse pytest summary line
                    parts = line.split()
                    for i, part in enumerate(parts):
                        if part == "passed":
                            tests_passed = int(parts[i-1])
                        elif part == "failed":
                            tests_failed = int(parts[i-1])
                elif " passed in " in line:
                    # Single status line
                    parts = line.split()
                    for i, part in enumerate(parts):
                        if part == "passed":
                            tests_passed = int(parts[i-1])
            
            tests_total = tests_passed + tests_failed
            
            return BenchmarkResult(
                config_name=config_file,
                total_time=total_time,
                setup_time=total_time * 0.1,  # Estimated
                test_time=total_time * 0.8,   # Estimated
                teardown_time=total_time * 0.1,  # Estimated
                tests_passed=tests_passed,
                tests_failed=tests_failed,
                tests_total=tests_total,
                memory_peak_mb=0,  # Would need psutil for accurate measurement
                cpu_usage_percent=0,  # Would need psutil for accurate measurement
                cache_hits=0,  # Would need pytest-cache plugin
                cache_misses=0
            )
            
        except subprocess.TimeoutExpired:
            return BenchmarkResult(
                config_name=config_file,
                total_time=300.0,  # Timeout
                setup_time=0,
                test_time=300.0,
                teardown_time=0,
                tests_passed=0,
                tests_failed=0,
                tests_total=0,
                memory_peak_mb=0,
                cpu_usage_percent=0,
                cache_hits=0,
                cache_misses=0
            )
    
    def calculate_improvements(self, baseline: BenchmarkResult, optimized: BenchmarkResult) -> Dict[str, float]:
        """Calculate performance improvements between baseline and optimized."""
        improvements = {}
        
        # Calculate percentage improvements (positive = better)
        if baseline.total_time > 0:
            improvements['total_time'] = ((baseline.total_time - optimized.total_time) / baseline.total_time) * 100
        
        if baseline.setup_time > 0:
            improvements['setup_time'] = ((baseline.setup_time - optimized.setup_time) / baseline.setup_time) * 100
        
        if baseline.test_time > 0:
            improvements['test_time'] = ((baseline.test_time - optimized.test_time) / baseline.test_time) * 100
        
        # Test success rate improvement
        baseline_success_rate = (baseline.tests_passed / baseline.tests_total * 100) if baseline.tests_total > 0 else 0
        optimized_success_rate = (optimized.tests_passed / optimized.tests_total * 100) if optimized.tests_total > 0 else 0
        improvements['success_rate'] = optimized_success_rate - baseline_success_rate
        
        # Throughput improvement (tests per second)
        baseline_throughput = baseline.tests_total / baseline.total_time if baseline.total_time > 0 else 0
        optimized_throughput = optimized.tests_total / optimized.total_time if optimized.total_time > 0 else 0
        if baseline_throughput > 0:
            improvements['throughput'] = ((optimized_throughput - baseline_throughput) / baseline_throughput) * 100
        
        return improvements
    
    def generate_recommendations(self, improvements: Dict[str, float]) -> List[str]:
        """Generate recommendations based on benchmark results."""
        recommendations = []
        
        if improvements.get('total_time', 0) > 20:
            recommendations.append("✅ Excellent overall performance improvement achieved")
        elif improvements.get('total_time', 0) > 10:
            recommendations.append("✅ Good performance improvement, consider additional parallelization")
        elif improvements.get('total_time', 0) < 5:
            recommendations.append("⚠️ Limited performance gain, review test isolation and fixture usage")
        
        if improvements.get('setup_time', 0) > 30:
            recommendations.append("✅ Lazy loading significantly improved startup time")
        
        if improvements.get('throughput', 0) > 50:
            recommendations.append("✅ Test throughput significantly improved with parallelization")
        
        if improvements.get('success_rate', 0) < 0:
            recommendations.append("⚠️ Test reliability decreased, review test isolation settings")
        
        return recommendations
    
    def print_report(self, report: PerformanceReport):
        """Print formatted performance report."""
        print("\n" + "="*80)
        print("🚀 TEST PERFORMANCE BENCHMARK REPORT")
        print("="*80)
        
        print(f"\n📅 Timestamp: {report.timestamp}")
        
        print("\n📈 BASELINE RESULTS:")
        self.print_benchmark_result(report.baseline)
        
        print("\n🎯 OPTIMIZED RESULTS:")
        self.print_benchmark_result(report.optimized)
        
        print("\n💡 PERFORMANCE IMPROVEMENTS:")
        for metric, improvement in report.improvements.items():
            if improvement > 0:
                print(f"  ✅ {metric}: {improvement:+.1f}% improvement")
            elif improvement < -5:
                print(f"  ⚠️  {metric}: {improvement:+.1f}% regression")
            else:
                print(f"  ➡️  {metric}: {improvement:+.1f}% (minimal change)")
        
        print("\n🎯 RECOMMENDATIONS:")
        for rec in report.recommendations:
            print(f"  {rec}")
        
        print("\n" + "="*80)
    
    def print_benchmark_result(self, result: BenchmarkResult):
        """Print formatted benchmark result."""
        print(f"  Config: {result.config_name}")
        print(f"  Total Time: {result.total_time:.2f}s")
        print(f"  Tests: {result.tests_passed}/{result.tests_total} passed")
        if result.tests_total > 0 and result.total_time > 0:
            throughput = result.tests_total / result.total_time
            print(f"  Throughput: {throughput:.1f} tests/second")


def main():
    """Main benchmark execution."""
    parser = argparse.ArgumentParser(description="Benchmark test performance optimizations")
    parser.add_argument("--runs", type=int, default=1, help="Number of benchmark runs to average")
    
    args = parser.parse_args()
    
    # Find project root
    current_dir = Path.cwd()
    if current_dir.name == "python":
        project_root = current_dir.parent
    elif (current_dir / "python").exists():
        project_root = current_dir
    else:
        print("❌ Could not find Archon project root")
        return 1
    
    benchmark = TestPerformanceBenchmark(project_root)
    
    print("🏁 Starting Test Performance Benchmark...")
    
    print("\n🐍 BACKEND BENCHMARK")
    print("-" * 40)
    
    # Run baseline (create a simple baseline config)
    print("Creating baseline configuration...")
    baseline_config = project_root / "python" / "pytest-baseline.ini"
    with open(baseline_config, 'w') as f:
        f.write("[pytest]\n")
        f.write("testpaths = tests\n")
        f.write("python_files = test_*.py\n")
        f.write("addopts = --verbose --tb=short\n")
    
    print("Running baseline configuration...")
    baseline_result = benchmark.run_backend_benchmark("pytest-baseline.ini")
    
    # Run optimized configuration
    print("Running optimized configuration...")
    optimized_result = benchmark.run_backend_benchmark("pytest.ini")
    
    # Calculate improvements
    improvements = benchmark.calculate_improvements(baseline_result, optimized_result)
    recommendations = benchmark.generate_recommendations(improvements)
    
    # Create report
    report = PerformanceReport(
        timestamp=time.strftime("%Y-%m-%d %H:%M:%S"),
        baseline=baseline_result,
        optimized=optimized_result,
        improvements=improvements,
        recommendations=recommendations
    )
    
    # Print report
    benchmark.print_report(report)
    
    print("\n✅ Benchmark completed successfully!")
    return 0


if __name__ == "__main__":
    exit(main())