#!/usr/bin/env python3
"""
Test setup optimization script for Archon.

This script optimizes the test environment setup, including:
- Repository preloading for faster test startup
- Cache warming for better performance
- Test data preparation and cleanup
- Performance monitoring setup
"""

import argparse
import asyncio
import logging
import os
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

# Add the src directory to the path for imports
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from src.server.repositories.lazy_imports import (
    preload_repositories,
    get_cache_stats,
    clear_repository_cache
)


def setup_logging(level: str = "INFO"):
    """Set up optimized logging for test setup."""
    logging.basicConfig(
        level=getattr(logging, level.upper()),
        format="%(asctime)s [%(levelname)8s] %(name)s: %(message)s",
        datefmt="%H:%M:%S"
    )


class TestEnvironmentOptimizer:
    """Optimizes test environment for better performance."""
    
    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.python_dir = project_root / "python"
        self.logger = logging.getLogger(self.__class__.__name__)
        
    def setup_environment_variables(self):
        """Set up optimized environment variables for testing."""
        self.logger.info("Setting up optimized test environment variables...")
        
        env_vars = {
            "TEST_MODE": "true",
            "TESTING": "true",
            "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUNBUFFERED": "1",
            "LOG_LEVEL": "WARNING",
            "SUPABASE_URL": "https://test.supabase.co",
            "SUPABASE_SERVICE_KEY": "test-key",
            "ARCHON_SERVER_PORT": "8181",
            "ARCHON_MCP_PORT": "8051",
            "ARCHON_AGENTS_PORT": "8052",
        }
        
        for key, value in env_vars.items():
            os.environ[key] = value
            self.logger.debug(f"Set {key}={value}")
            
        self.logger.info("✅ Environment variables configured")
        
    def preload_repository_classes(self) -> Dict[str, str]:
        """Preload repository classes to warm the lazy loading cache."""
        self.logger.info("Preloading repository classes for faster test startup...")
        
        start_time = time.time()
        
        try:
            # Preload all repository classes
            results = preload_repositories()
            
            end_time = time.time()
            preload_time = end_time - start_time
            
            # Analyze results
            successful = [name for name, result in results.items() if not isinstance(result, Exception)]
            failed = [name for name, result in results.items() if isinstance(result, Exception)]
            
            self.logger.info(f"✅ Preloaded {len(successful)}/{len(results)} repositories in {preload_time:.2f}s")
            
            if successful:
                self.logger.debug(f"Successfully preloaded: {', '.join(successful)}")
                
            if failed:
                self.logger.warning(f"Failed to preload: {', '.join(failed)}")
                for name in failed:
                    self.logger.debug(f"  {name}: {results[name]}")
            
            # Get cache statistics
            cache_stats = get_cache_stats()
            self.logger.info(f"Repository cache: {cache_stats['cached_count']} classes loaded")
            
            return {
                "preloaded": len(successful),
                "failed": len(failed),
                "time": preload_time,
                "cache_stats": cache_stats
            }
            
        except Exception as e:
            self.logger.error(f"Failed to preload repositories: {e}")
            return {"error": str(e)}
            
    def optimize_pytest_cache(self):
        """Optimize pytest cache for faster test discovery and execution."""
        self.logger.info("Optimizing pytest cache...")
        
        cache_dir = self.python_dir / ".pytest_cache"
        
        try:
            # Create cache directory if it doesn't exist
            cache_dir.mkdir(exist_ok=True)
            
            # Clear old cache data that might slow things down
            cache_files = [
                cache_dir / "CACHEDIR.TAG",
                cache_dir / "README.md"
            ]
            
            for cache_file in cache_files:
                if cache_file.exists():
                    cache_file.unlink()
            
            # Create optimized cache configuration
            cache_config = cache_dir / "cache_config.json"
            cache_config.write_text('{"version": "1.0", "optimized": true}')
            
            self.logger.info("✅ Pytest cache optimized")
            
        except Exception as e:
            self.logger.warning(f"Could not optimize pytest cache: {e}")
            
    def prepare_test_database(self):
        """Prepare test database configurations and mock data."""
        self.logger.info("Preparing test database configurations...")
        
        try:
            # Create test data directory
            test_data_dir = self.python_dir / "tests" / "data"
            test_data_dir.mkdir(parents=True, exist_ok=True)
            
            # Create mock database configuration
            mock_db_config = {
                "test_mode": True,
                "mock_supabase": True,
                "preload_fixtures": True,
                "lazy_loading": True
            }
            
            config_file = test_data_dir / "test_db_config.json"
            import json
            config_file.write_text(json.dumps(mock_db_config, indent=2))
            
            self.logger.info("✅ Test database configurations prepared")
            
        except Exception as e:
            self.logger.warning(f"Could not prepare test database: {e}")
            
    def warm_import_cache(self):
        """Warm Python import cache for faster test startup."""
        self.logger.info("Warming Python import cache...")
        
        start_time = time.time()
        
        try:
            # Import commonly used modules in tests
            import_modules = [
                "pytest",
                "unittest.mock",
                "fastapi.testclient",
                "pydantic",
                "asyncio",
                "json",
                "typing",
                "datetime",
                "pathlib"
            ]
            
            for module_name in import_modules:\n                try:\n                    __import__(module_name)\n                    self.logger.debug(f\"Imported {module_name}\")\n                except ImportError as e:\n                    self.logger.debug(f\"Could not import {module_name}: {e}\")\n            \n            end_time = time.time()\n            warm_time = end_time - start_time\n            \n            self.logger.info(f\"✅ Import cache warmed in {warm_time:.2f}s\")\n            \n        except Exception as e:\n            self.logger.warning(f\"Could not warm import cache: {e}\")\n    \n    def setup_performance_monitoring(self):\n        \"\"\"Set up performance monitoring for tests.\"\"\"\n        self.logger.info(\"Setting up performance monitoring...\")\n        \n        try:\n            # Create performance monitoring directory\n            perf_dir = self.python_dir / \"test_performance\"\n            perf_dir.mkdir(exist_ok=True)\n            \n            # Create performance configuration\n            perf_config = {\n                \"monitor_memory\": True,\n                \"monitor_cpu\": True,\n                \"log_slow_tests\": True,\n                \"slow_test_threshold\": 1.0,  # seconds\n                \"enable_profiling\": False  # Disabled by default for speed\n            }\n            \n            config_file = perf_dir / \"monitoring_config.json\"\n            import json\n            config_file.write_text(json.dumps(perf_config, indent=2))\n            \n            self.logger.info(\"✅ Performance monitoring configured\")\n            \n        except Exception as e:\n            self.logger.warning(f\"Could not set up performance monitoring: {e}\")\n    \n    def clean_old_test_artifacts(self):\n        \"\"\"Clean up old test artifacts that might slow down testing.\"\"\"\n        self.logger.info(\"Cleaning up old test artifacts...\")\n        \n        try:\n            artifacts_to_clean = [\n                self.python_dir / \"htmlcov\",\n                self.python_dir / \"test-results.xml\",\n                self.python_dir / \"coverage.xml\",\n                self.python_dir / \".coverage\",\n                self.python_dir / \"*.egg-info\"\n            ]\n            \n            cleaned = 0\n            for artifact in artifacts_to_clean:\n                if artifact.exists():\n                    if artifact.is_dir():\n                        import shutil\n                        shutil.rmtree(artifact)\n                    else:\n                        artifact.unlink()\n                    cleaned += 1\n                    self.logger.debug(f\"Removed {artifact}\")\n            \n            if cleaned > 0:\n                self.logger.info(f\"✅ Cleaned {cleaned} old test artifacts\")\n            else:\n                self.logger.info(\"✅ No old test artifacts to clean\")\n                \n        except Exception as e:\n            self.logger.warning(f\"Could not clean test artifacts: {e}\")\n    \n    def optimize_all(self) -> Dict[str, any]:\n        \"\"\"Run all optimization steps and return summary.\"\"\"\n        self.logger.info(\"🚀 Starting complete test environment optimization...\")\n        \n        start_time = time.time()\n        \n        results = {\n            \"start_time\": start_time,\n            \"steps_completed\": [],\n            \"errors\": []\n        }\n        \n        optimization_steps = [\n            (\"environment_setup\", self.setup_environment_variables),\n            (\"repository_preload\", self.preload_repository_classes),\n            (\"pytest_cache\", self.optimize_pytest_cache),\n            (\"test_database\", self.prepare_test_database),\n            (\"import_cache\", self.warm_import_cache),\n            (\"performance_monitoring\", self.setup_performance_monitoring),\n            (\"cleanup\", self.clean_old_test_artifacts)\n        ]\n        \n        for step_name, step_func in optimization_steps:\n            try:\n                step_result = step_func()\n                results[\"steps_completed\"].append(step_name)\n                if step_result:\n                    results[step_name] = step_result\n            except Exception as e:\n                error_msg = f\"{step_name}: {str(e)}\"\n                results[\"errors\"].append(error_msg)\n                self.logger.error(f\"Optimization step failed - {error_msg}\")\n        \n        end_time = time.time()\n        total_time = end_time - start_time\n        \n        results[\"total_time\"] = total_time\n        results[\"end_time\"] = end_time\n        \n        self.logger.info(f\"✅ Test environment optimization completed in {total_time:.2f}s\")\n        self.logger.info(f\"Completed steps: {', '.join(results['steps_completed'])}\")\n        \n        if results[\"errors\"]:\n            self.logger.warning(f\"Errors encountered: {len(results['errors'])}\")\n            for error in results[\"errors\"]:\n                self.logger.warning(f\"  - {error}\")\n        \n        return results\n\n\ndef main():\n    \"\"\"Main optimization script execution.\"\"\"\n    parser = argparse.ArgumentParser(description=\"Optimize test environment for better performance\")\n    parser.add_argument(\"--log-level\", default=\"INFO\", choices=[\"DEBUG\", \"INFO\", \"WARNING\", \"ERROR\"])\n    parser.add_argument(\"--clean-only\", action=\"store_true\", help=\"Only clean up old artifacts\")\n    parser.add_argument(\"--preload-only\", action=\"store_true\", help=\"Only preload repositories\")\n    parser.add_argument(\"--verbose\", \"-v\", action=\"store_true\", help=\"Enable verbose output\")\n    \n    args = parser.parse_args()\n    \n    # Set up logging\n    log_level = \"DEBUG\" if args.verbose else args.log_level\n    setup_logging(log_level)\n    \n    # Find project root\n    current_dir = Path.cwd()\n    if current_dir.name == \"python\":\n        project_root = current_dir.parent\n    elif (current_dir / \"python\").exists():\n        project_root = current_dir\n    else:\n        print(\"❌ Could not find Archon project root\")\n        return 1\n    \n    # Create optimizer\n    optimizer = TestEnvironmentOptimizer(project_root)\n    \n    try:\n        if args.clean_only:\n            optimizer.clean_old_test_artifacts()\n        elif args.preload_only:\n            results = optimizer.preload_repository_classes()\n            print(f\"Preloaded {results.get('preloaded', 0)} repositories\")\n        else:\n            # Run full optimization\n            results = optimizer.optimize_all()\n            print(f\"\\n🎯 Optimization Summary:\")\n            print(f\"  Time: {results['total_time']:.2f}s\")\n            print(f\"  Steps: {len(results['steps_completed'])}/{len(results['steps_completed']) + len(results['errors'])}\")\n            if results['errors']:\n                print(f\"  Errors: {len(results['errors'])}\")\n    \n    except KeyboardInterrupt:\n        print(\"\\n❌ Optimization cancelled by user\")\n        return 1\n    except Exception as e:\n        print(f\"❌ Optimization failed: {e}\")\n        return 1\n    \n    print(\"✅ Test environment optimization completed!\")\n    return 0\n\n\nif __name__ == \"__main__\":\n    exit(main())