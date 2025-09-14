#!/usr/bin/env python3
"""
E-commerce Crawling Test Runner

Automated test runner for the comprehensive e-commerce crawling system.
Runs all tests, generates reports, and validates system performance.

Usage:
    python run_tests.py [--coverage] [--performance] [--report-format html|json|text]
"""

import asyncio
import argparse
import json
import time
import sys
from pathlib import Path
from typing import Dict, List, Any, Optional
from datetime import datetime

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

try:
    import pytest
    from conftest import ValidationHelper, PerformanceMonitor, create_test_scenarios, TEST_CONFIG
except ImportError as e:
    print(f"Import error: {e}")
    print("Please ensure all dependencies are installed: pip install pytest pytest-asyncio")
    sys.exit(1)


class TestRunner:
    """Main test runner for e-commerce crawling tests."""
    
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or TEST_CONFIG
        self.results = {}
        self.performance_monitor = PerformanceMonitor()
        self.validation_helper = ValidationHelper()
        
    def run_all_tests(self, 
                     coverage: bool = False, 
                     performance: bool = False,
                     verbose: bool = True) -> Dict[str, Any]:
        """
        Run all e-commerce crawling tests.
        
        Args:
            coverage: Enable coverage reporting
            performance: Enable performance testing
            verbose: Enable verbose output
            
        Returns:
            Test results dictionary
        """
        
        print("🚀 Starting E-commerce Crawling Test Suite")
        print("=" * 60)
        
        start_time = time.time()
        
        # Prepare pytest arguments
        pytest_args = [
            str(Path(__file__).parent / "test_ecommerce_crawling.py"),
            "-v" if verbose else "-q",
            "--tb=short",
            "--asyncio-mode=auto"
        ]
        
        if coverage:
            pytest_args.extend([
                "--cov=server.services.crawling",
                "--cov-report=html:htmlcov",
                "--cov-report=term-missing"
            ])
        
        # Run the tests
        print(f"📋 Running tests with args: {' '.join(pytest_args)}")
        exit_code = pytest.main(pytest_args)
        
        end_time = time.time()
        total_duration = end_time - start_time
        
        # Collect results
        self.results = {
            "timestamp": datetime.now().isoformat(),
            "total_duration": total_duration,
            "exit_code": exit_code,
            "success": exit_code == 0,
            "test_config": self.config,
            "performance_enabled": performance,
            "coverage_enabled": coverage
        }
        
        # Run performance tests if requested
        if performance:
            print("\n🏃 Running Performance Tests...")
            performance_results = self._run_performance_tests()
            self.results["performance"] = performance_results
        
        # Generate summary
        self._print_summary()
        
        return self.results
    
    def _run_performance_tests(self) -> Dict[str, Any]:
        """Run performance-specific tests."""
        
        performance_results = {
            "extraction_speed": {},
            "memory_usage": {},
            "concurrent_handling": {},
            "pagination_performance": {}
        }
        
        try:
            # Test extraction speed
            self.performance_monitor.start_timer("product_extraction")
            
            # Simulate product data extraction performance
            from test_ecommerce_crawling import TestPerformance
            test_performance = TestPerformance()
            
            # Run concurrent extraction test
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
            try:
                loop.run_until_complete(test_performance.test_concurrent_extraction())
                performance_results["concurrent_handling"]["status"] = "passed"
            except Exception as e:
                performance_results["concurrent_handling"]["status"] = "failed"
                performance_results["concurrent_handling"]["error"] = str(e)
            finally:
                loop.close()
            
            self.performance_monitor.end_timer("product_extraction")
            
            # Test memory usage
            test_performance.test_memory_usage()
            performance_results["memory_usage"]["status"] = "passed"
            
            # Get performance metrics
            metrics = self.performance_monitor.get_metrics()
            threshold_checks = self.performance_monitor.check_thresholds()
            
            performance_results["metrics"] = metrics
            performance_results["threshold_checks"] = threshold_checks
            performance_results["overall_performance"] = all(threshold_checks.values())
            
        except Exception as e:
            performance_results["error"] = str(e)
            performance_results["overall_performance"] = False
        
        return performance_results
    
    def _print_summary(self):
        """Print test summary."""
        print("\n" + "=" * 60)
        print("📊 TEST SUMMARY")
        print("=" * 60)
        
        status = "✅ PASSED" if self.results["success"] else "❌ FAILED"
        print(f"Status: {status}")
        print(f"Duration: {self.results['total_duration']:.2f} seconds")
        print(f"Exit Code: {self.results['exit_code']}")
        
        if "performance" in self.results:
            perf_status = "✅ PASSED" if self.results["performance"].get("overall_performance") else "⚠️  ISSUES"
            print(f"Performance: {perf_status}")
        
        print("\n📁 Generated Files:")
        
        # Check for coverage report
        if self.results["coverage_enabled"]:
            coverage_dir = Path("htmlcov")
            if coverage_dir.exists():
                print(f"  • Coverage Report: {coverage_dir}/index.html")
        
        # Check for test artifacts
        test_output_dir = Path("test_output")
        if test_output_dir.exists():
            print(f"  • Test Artifacts: {test_output_dir}/")
    
    def generate_report(self, format_type: str = "text", output_file: Optional[str] = None) -> str:
        """
        Generate detailed test report.
        
        Args:
            format_type: Report format (text, json, html)
            output_file: Optional output file path
            
        Returns:
            Report content as string
        """
        
        if format_type == "json":
            report_content = json.dumps(self.results, indent=2)
        elif format_type == "html":
            report_content = self._generate_html_report()
        else:  # text
            report_content = self._generate_text_report()
        
        # Write to file if specified
        if output_file:
            output_path = Path(output_file)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(report_content)
            print(f"📄 Report saved to: {output_path}")
        
        return report_content
    
    def _generate_text_report(self) -> str:
        """Generate text format report."""
        lines = [
            "E-COMMERCE CRAWLING TEST REPORT",
            "=" * 50,
            "",
            f"Timestamp: {self.results['timestamp']}",
            f"Total Duration: {self.results['total_duration']:.2f} seconds",
            f"Success: {self.results['success']}",
            f"Exit Code: {self.results['exit_code']}",
            ""
        ]
        
        # Add performance section if available
        if "performance" in self.results:
            perf = self.results["performance"]
            lines.extend([
                "PERFORMANCE RESULTS",
                "-" * 20,
                f"Overall Performance: {perf.get('overall_performance', 'Unknown')}",
                ""
            ])
            
            if "metrics" in perf:
                lines.append("Performance Metrics:")
                for operation, duration in perf["metrics"].items():
                    lines.append(f"  • {operation}: {duration:.3f}s")
                lines.append("")
            
            if "threshold_checks" in perf:
                lines.append("Threshold Checks:")
                for check, passed in perf["threshold_checks"].items():
                    status = "✅" if passed else "❌"
                    lines.append(f"  • {check}: {status}")
                lines.append("")
        
        # Add configuration
        lines.extend([
            "TEST CONFIGURATION",
            "-" * 20,
            f"Timeout: {self.config['timeout']}s",
            f"Max Concurrent Tests: {self.config['max_concurrent_tests']}",
            f"Performance Thresholds:",
            f"  • Extraction: {self.config['performance_thresholds']['extraction_time_ms']}ms",
            f"  • Detection: {self.config['performance_thresholds']['detection_time_ms']}ms", 
            f"  • Validation: {self.config['performance_thresholds']['validation_time_ms']}ms",
            ""
        ])
        
        return "\n".join(lines)
    
    def _generate_html_report(self) -> str:
        """Generate HTML format report."""
        
        status_color = "#28a745" if self.results["success"] else "#dc3545"
        status_text = "PASSED" if self.results["success"] else "FAILED"
        
        html = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>E-commerce Crawling Test Report</title>
            <style>
                body {{ font-family: Arial, sans-serif; margin: 40px; }}
                .header {{ background: #f8f9fa; padding: 20px; border-radius: 5px; }}
                .status {{ color: {status_color}; font-weight: bold; }}
                .section {{ margin: 20px 0; }}
                .metric {{ margin: 5px 0; }}
                .passed {{ color: #28a745; }}
                .failed {{ color: #dc3545; }}
                table {{ border-collapse: collapse; width: 100%; }}
                th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; }}
                th {{ background-color: #f2f2f2; }}
            </style>
        </head>
        <body>
            <div class="header">
                <h1>E-commerce Crawling Test Report</h1>
                <p><strong>Status:</strong> <span class="status">{status_text}</span></p>
                <p><strong>Duration:</strong> {self.results['total_duration']:.2f} seconds</p>
                <p><strong>Timestamp:</strong> {self.results['timestamp']}</p>
            </div>
        """
        
        # Add performance section if available
        if "performance" in self.results:
            perf = self.results["performance"]
            html += """
            <div class="section">
                <h2>Performance Results</h2>
            """
            
            if "metrics" in perf:
                html += "<h3>Performance Metrics</h3><table>"
                html += "<tr><th>Operation</th><th>Duration (s)</th></tr>"
                for operation, duration in perf["metrics"].items():
                    html += f"<tr><td>{operation}</td><td>{duration:.3f}</td></tr>"
                html += "</table>"
            
            html += "</div>"
        
        html += """
            <div class="section">
                <h2>Test Configuration</h2>
                <table>
                    <tr><th>Setting</th><th>Value</th></tr>
        """
        
        for key, value in self.config.items():
            if isinstance(value, dict):
                for sub_key, sub_value in value.items():
                    html += f"<tr><td>{key}.{sub_key}</td><td>{sub_value}</td></tr>"
            else:
                html += f"<tr><td>{key}</td><td>{value}</td></tr>"
        
        html += """
                </table>
            </div>
        </body>
        </html>
        """
        
        return html
    
    def validate_system_health(self) -> Dict[str, Any]:
        """Validate overall system health based on test results."""
        
        health_check = {
            "overall_health": "healthy",
            "issues": [],
            "recommendations": []
        }
        
        # Check test success
        if not self.results["success"]:
            health_check["overall_health"] = "unhealthy"
            health_check["issues"].append("Tests are failing")
            health_check["recommendations"].append("Review test failures and fix underlying issues")
        
        # Check performance if available
        if "performance" in self.results:
            perf = self.results["performance"]
            if not perf.get("overall_performance", True):
                health_check["overall_health"] = "degraded" if health_check["overall_health"] == "healthy" else "unhealthy"
                health_check["issues"].append("Performance thresholds not met")
                health_check["recommendations"].append("Optimize slow operations")
        
        # Check duration
        if self.results["total_duration"] > 300:  # 5 minutes
            health_check["issues"].append("Tests taking too long to complete")
            health_check["recommendations"].append("Consider optimizing test execution or adding parallelization")
        
        return health_check


def main():
    """Main entry point for test runner."""
    
    parser = argparse.ArgumentParser(description="E-commerce Crawling Test Runner")
    parser.add_argument("--coverage", action="store_true", help="Enable coverage reporting")
    parser.add_argument("--performance", action="store_true", help="Enable performance testing")
    parser.add_argument("--report-format", choices=["text", "json", "html"], default="text", help="Report format")
    parser.add_argument("--report-file", help="Output file for report")
    parser.add_argument("--verbose", action="store_true", default=True, help="Verbose output")
    parser.add_argument("--validate-health", action="store_true", help="Run system health validation")
    
    args = parser.parse_args()
    
    # Create test runner
    runner = TestRunner()
    
    # Run tests
    results = runner.run_all_tests(
        coverage=args.coverage,
        performance=args.performance, 
        verbose=args.verbose
    )
    
    # Generate report
    if args.report_file or args.report_format != "text":
        report = runner.generate_report(args.report_format, args.report_file)
        if not args.report_file:
            print(f"\n📄 {args.report_format.upper()} REPORT:")
            print("-" * 40)
            print(report)
    
    # Validate system health if requested
    if args.validate_health:
        print("\n🏥 SYSTEM HEALTH CHECK")
        print("-" * 30)
        health = runner.validate_system_health()
        print(f"Overall Health: {health['overall_health'].upper()}")
        
        if health["issues"]:
            print("Issues Found:")
            for issue in health["issues"]:
                print(f"  • {issue}")
        
        if health["recommendations"]:
            print("Recommendations:")
            for rec in health["recommendations"]:
                print(f"  • {rec}")
    
    # Exit with appropriate code
    sys.exit(results["exit_code"])


if __name__ == "__main__":
    main()