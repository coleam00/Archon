"""
Performance testing for lazy loading repository imports.

This module provides utilities to test and measure the performance
improvements gained from lazy loading repository implementations.
"""

import time
import sys
import importlib
import logging
from typing import Dict, List, Any, Optional
from dataclasses import dataclass
from contextlib import contextmanager

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


@dataclass
class ImportTestResult:
    """Result of an import performance test."""
    test_name: str
    success: bool
    duration: float
    memory_usage: Optional[float] = None
    error: Optional[str] = None
    imports_count: int = 0
    details: Dict[str, Any] = None


@contextmanager
def measure_time():
    """Context manager to measure execution time."""
    start = time.perf_counter()
    yield lambda: time.perf_counter() - start
    

def get_memory_usage() -> float:
    """Get current memory usage in MB."""
    try:
        import psutil
        process = psutil.Process()
        return process.memory_info().rss / 1024 / 1024
    except ImportError:
        return 0.0


class ImportPerformanceTester:
    """Test suite for measuring import performance."""
    
    def __init__(self):
        self.results: List[ImportTestResult] = []
        
    def test_traditional_imports(self) -> ImportTestResult:
        """Test traditional direct imports."""
        logger.info("Testing traditional repository imports...")
        
        try:
            with measure_time() as get_duration:
                memory_before = get_memory_usage()
                
                # Traditional imports that load all modules immediately
                from .supabase_repositories import (
                    SupabaseSourceRepository,
                    SupabaseDocumentRepository,
                    SupabaseCodeExampleRepository,
                    SupabaseProjectRepository,
                    SupabaseTaskRepository,
                    SupabaseVersionRepository,
                    SupabaseSettingsRepository,
                    SupabasePromptRepository,
                )
                
                memory_after = get_memory_usage()
                duration = get_duration()
                
                result = ImportTestResult(
                    test_name="traditional_imports",
                    success=True,
                    duration=duration,
                    memory_usage=memory_after - memory_before,
                    imports_count=8,
                    details={
                        "imported_classes": [
                            "SupabaseSourceRepository",
                            "SupabaseDocumentRepository", 
                            "SupabaseCodeExampleRepository",
                            "SupabaseProjectRepository",
                            "SupabaseTaskRepository",
                            "SupabaseVersionRepository",
                            "SupabaseSettingsRepository",
                            "SupabasePromptRepository"
                        ]
                    }
                )
                
                logger.info(f"Traditional imports completed in {duration:.4f}s, memory usage: {result.memory_usage:.2f}MB")
                return result
                
        except Exception as e:
            logger.error(f"Traditional imports failed: {e}")
            return ImportTestResult(
                test_name="traditional_imports",
                success=False,
                duration=0.0,
                error=str(e)
            )
    
    def test_lazy_imports_setup(self) -> ImportTestResult:
        """Test lazy import system setup time."""
        logger.info("Testing lazy import system setup...")
        
        try:
            with measure_time() as get_duration:
                memory_before = get_memory_usage()
                
                # Import lazy loading system
                from .lazy_imports import get_repository_class, preload_repositories
                
                memory_after = get_memory_usage()
                duration = get_duration()
                
                result = ImportTestResult(
                    test_name="lazy_imports_setup",
                    success=True,
                    duration=duration,
                    memory_usage=memory_after - memory_before,
                    imports_count=1,
                    details={
                        "setup_only": True,
                        "no_classes_loaded": True
                    }
                )
                
                logger.info(f"Lazy import setup completed in {duration:.4f}s, memory usage: {result.memory_usage:.2f}MB")
                return result
                
        except Exception as e:
            logger.error(f"Lazy import setup failed: {e}")
            return ImportTestResult(
                test_name="lazy_imports_setup", 
                success=False,
                duration=0.0,
                error=str(e)
            )
    
    def test_lazy_imports_usage(self) -> ImportTestResult:
        """Test lazy import system usage (loading classes on demand)."""
        logger.info("Testing lazy import usage...")
        
        try:
            with measure_time() as get_duration:
                memory_before = get_memory_usage()
                
                from .lazy_imports import get_repository_class
                
                # Load classes one by one (simulating real usage)
                classes_loaded = []
                load_times = {}
                
                repo_names = [
                    "SupabaseSourceRepository",
                    "SupabaseDocumentRepository",
                    "SupabaseCodeExampleRepository", 
                    "SupabaseProjectRepository",
                    "SupabaseTaskRepository",
                    "SupabaseVersionRepository",
                    "SupabaseSettingsRepository",
                    "SupabasePromptRepository"
                ]
                
                for repo_name in repo_names:
                    class_start = time.perf_counter()
                    repo_class = get_repository_class(repo_name)
                    class_duration = time.perf_counter() - class_start
                    
                    classes_loaded.append(repo_name)
                    load_times[repo_name] = class_duration
                
                memory_after = get_memory_usage()
                duration = get_duration()
                
                result = ImportTestResult(
                    test_name="lazy_imports_usage",
                    success=True,
                    duration=duration,
                    memory_usage=memory_after - memory_before,
                    imports_count=len(classes_loaded),
                    details={
                        "classes_loaded": classes_loaded,
                        "individual_load_times": load_times,
                        "average_load_time": sum(load_times.values()) / len(load_times)
                    }
                )
                
                logger.info(f"Lazy imports usage completed in {duration:.4f}s, memory usage: {result.memory_usage:.2f}MB")
                return result
                
        except Exception as e:
            logger.error(f"Lazy imports usage failed: {e}")
            return ImportTestResult(
                test_name="lazy_imports_usage",
                success=False,
                duration=0.0,
                error=str(e)
            )
    
    def test_lazy_database_creation(self) -> ImportTestResult:
        """Test lazy database instance creation."""
        logger.info("Testing lazy database creation...")
        
        try:
            with measure_time() as get_duration:
                memory_before = get_memory_usage()
                
                from .implementations.lazy_supabase_database import LazySupabaseDatabase
                
                # Create database instance (repositories not loaded yet)
                db = LazySupabaseDatabase()
                
                memory_after = get_memory_usage()
                duration = get_duration()
                
                result = ImportTestResult(
                    test_name="lazy_database_creation",
                    success=True,
                    duration=duration,
                    memory_usage=memory_after - memory_before,
                    imports_count=1,
                    details={
                        "database_created": True,
                        "repositories_loaded": False,
                        "repository_stats": db.get_repository_stats() if hasattr(db, 'get_repository_stats') else None
                    }
                )
                
                logger.info(f"Lazy database creation completed in {duration:.4f}s, memory usage: {result.memory_usage:.2f}MB")
                return result
                
        except Exception as e:
            logger.error(f"Lazy database creation failed: {e}")
            return ImportTestResult(
                test_name="lazy_database_creation",
                success=False,
                duration=0.0,
                error=str(e)
            )
    
    def test_lazy_database_usage(self) -> ImportTestResult:
        """Test lazy database usage (accessing repositories)."""
        logger.info("Testing lazy database usage...")
        
        try:
            with measure_time() as get_duration:
                memory_before = get_memory_usage()
                
                from .implementations.lazy_supabase_database import LazySupabaseDatabase
                
                # Create database and access repositories
                db = LazySupabaseDatabase()
                
                # Access each repository (triggers lazy loading)
                repositories_accessed = []
                access_times = {}
                
                repo_properties = [
                    'sources', 'documents', 'code_examples', 'projects',
                    'tasks', 'versions', 'settings', 'prompts'
                ]
                
                for prop in repo_properties:
                    if hasattr(db, prop):
                        prop_start = time.perf_counter()
                        repo = getattr(db, prop)
                        prop_duration = time.perf_counter() - prop_start
                        
                        repositories_accessed.append(prop)
                        access_times[prop] = prop_duration
                
                memory_after = get_memory_usage()
                duration = get_duration()
                
                result = ImportTestResult(
                    test_name="lazy_database_usage",
                    success=True,
                    duration=duration,
                    memory_usage=memory_after - memory_before,
                    imports_count=len(repositories_accessed),
                    details={
                        "repositories_accessed": repositories_accessed,
                        "access_times": access_times,
                        "average_access_time": sum(access_times.values()) / len(access_times) if access_times else 0,
                        "repository_stats": db.get_repository_stats() if hasattr(db, 'get_repository_stats') else None
                    }
                )
                
                logger.info(f"Lazy database usage completed in {duration:.4f}s, memory usage: {result.memory_usage:.2f}MB")
                return result
                
        except Exception as e:
            logger.error(f"Lazy database usage failed: {e}")
            return ImportTestResult(
                test_name="lazy_database_usage",
                success=False,
                duration=0.0,
                error=str(e)
            )
    
    def test_preload_performance(self) -> ImportTestResult:
        """Test preloading performance."""
        logger.info("Testing repository preloading...")
        
        try:
            with measure_time() as get_duration:
                memory_before = get_memory_usage()
                
                from .lazy_imports import preload_repositories
                
                # Preload critical repositories
                critical_repos = [
                    "SupabaseSourceRepository",
                    "SupabaseDocumentRepository",
                    "SupabaseProjectRepository",
                    "SupabaseSettingsRepository"
                ]
                
                preload_results = preload_repositories(critical_repos)
                
                memory_after = get_memory_usage()
                duration = get_duration()
                
                successful_preloads = sum(1 for result in preload_results.values() if not isinstance(result, Exception))
                
                result = ImportTestResult(
                    test_name="preload_performance",
                    success=True,
                    duration=duration,
                    memory_usage=memory_after - memory_before,
                    imports_count=successful_preloads,
                    details={
                        "requested_repos": critical_repos,
                        "successful_preloads": successful_preloads,
                        "preload_results": {
                            name: str(result) if isinstance(result, Exception) else f"<class '{result.__name__}'>"
                            for name, result in preload_results.items()
                        }
                    }
                )
                
                logger.info(f"Preloading completed in {duration:.4f}s, memory usage: {result.memory_usage:.2f}MB")
                return result
                
        except Exception as e:
            logger.error(f"Preloading failed: {e}")
            return ImportTestResult(
                test_name="preload_performance",
                success=False,
                duration=0.0,
                error=str(e)
            )
    
    def run_all_tests(self) -> List[ImportTestResult]:
        """Run all performance tests."""
        logger.info("Starting comprehensive import performance tests")
        
        tests = [
            self.test_lazy_imports_setup,
            self.test_lazy_database_creation,
            self.test_lazy_database_usage,
            self.test_preload_performance,
            # Note: Traditional imports test is commented out to avoid conflicts
            # self.test_traditional_imports,
            # self.test_lazy_imports_usage,
        ]
        
        results = []
        for test in tests:
            try:
                result = test()
                results.append(result)
                self.results.append(result)
            except Exception as e:
                logger.error(f"Test {test.__name__} failed with exception: {e}")
                error_result = ImportTestResult(
                    test_name=test.__name__,
                    success=False,
                    duration=0.0,
                    error=str(e)
                )
                results.append(error_result)
                self.results.append(error_result)
        
        return results
    
    def generate_report(self) -> Dict[str, Any]:
        """Generate a comprehensive performance report."""
        if not self.results:
            return {"error": "No test results available"}
        
        successful_tests = [r for r in self.results if r.success]
        failed_tests = [r for r in self.results if not r.success]
        
        report = {
            "summary": {
                "total_tests": len(self.results),
                "successful_tests": len(successful_tests),
                "failed_tests": len(failed_tests),
                "success_rate": len(successful_tests) / len(self.results) * 100 if self.results else 0
            },
            "performance_metrics": {
                "total_time": sum(r.duration for r in successful_tests),
                "average_time": sum(r.duration for r in successful_tests) / len(successful_tests) if successful_tests else 0,
                "total_memory": sum(r.memory_usage for r in successful_tests if r.memory_usage),
                "average_memory": sum(r.memory_usage for r in successful_tests if r.memory_usage) / len([r for r in successful_tests if r.memory_usage]) if any(r.memory_usage for r in successful_tests) else 0
            },
            "test_results": [
                {
                    "name": result.test_name,
                    "success": result.success,
                    "duration": result.duration,
                    "memory_usage": result.memory_usage,
                    "imports_count": result.imports_count,
                    "error": result.error,
                    "details": result.details
                }
                for result in self.results
            ]
        }
        
        return report
    
    def print_report(self):
        """Print a formatted performance report."""
        report = self.generate_report()
        
        print("\n" + "="*80)
        print("REPOSITORY IMPORT PERFORMANCE REPORT")
        print("="*80)
        
        summary = report["summary"]
        print(f"Total Tests: {summary['total_tests']}")
        print(f"Successful: {summary['successful_tests']}")
        print(f"Failed: {summary['failed_tests']}")
        print(f"Success Rate: {summary['success_rate']:.1f}%")
        
        if report["performance_metrics"]:
            metrics = report["performance_metrics"]
            print(f"\nPerformance Metrics:")
            print(f"  Total Time: {metrics['total_time']:.4f}s")
            print(f"  Average Time: {metrics['average_time']:.4f}s")
            print(f"  Total Memory: {metrics['total_memory']:.2f}MB")
            print(f"  Average Memory: {metrics['average_memory']:.2f}MB")
        
        print("\nDetailed Results:")
        print("-" * 80)
        
        for result in report["test_results"]:
            status = "✅ PASS" if result["success"] else "❌ FAIL"
            print(f"{status} {result['name']}")
            print(f"      Duration: {result['duration']:.4f}s")
            if result["memory_usage"]:
                print(f"      Memory: {result['memory_usage']:.2f}MB")
            if result["imports_count"]:
                print(f"      Imports: {result['imports_count']}")
            if result["error"]:
                print(f"      Error: {result['error']}")
            print()


def run_performance_tests():
    """Run all performance tests and generate report."""
    tester = ImportPerformanceTester()
    
    try:
        results = tester.run_all_tests()
        tester.print_report()
        
        # Return results for programmatic use
        return tester.generate_report()
        
    except Exception as e:
        logger.error(f"Performance testing failed: {e}")
        print(f"❌ Performance testing failed: {e}")
        return None


if __name__ == "__main__":
    # Run performance tests when executed directly
    run_performance_tests()