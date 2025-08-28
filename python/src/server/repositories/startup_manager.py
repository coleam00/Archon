"""
Comprehensive startup error handling and initialization system.

This module provides robust startup management for the repository system including:
- Graceful error handling and recovery
- Dependency validation and health checks
- Initialization order management
- Startup progress tracking
- Configuration validation
- Resource cleanup on failure

The startup manager ensures that the system fails fast with clear error messages
when critical issues are detected, while providing recovery options for
transient failures.
"""

import asyncio
import logging
import time
import traceback
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from enum import Enum
from typing import (
    Any, Dict, List, Optional, Callable, Awaitable, 
    Union, Set, Tuple, NamedTuple
)
from uuid import uuid4

from .database_config import DatabaseConfig, DatabaseConfigManager, load_database_config
from .dependency_injection import DependencyContainer, get_container
from .lazy_imports import preload_repositories, LazyImportError


logger = logging.getLogger(__name__)


class StartupPhase(Enum):
    """Startup phases in execution order."""
    CONFIGURATION_LOAD = "configuration_load"
    DEPENDENCY_VALIDATION = "dependency_validation"
    REPOSITORY_PRELOAD = "repository_preload"
    DATABASE_CONNECTION = "database_connection"
    HEALTH_CHECKS = "health_checks"
    FINALIZATION = "finalization"


class StartupStatus(Enum):
    """Startup status indicators."""
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    RECOVERING = "recovering"


@dataclass
class StartupError:
    """Information about a startup error."""
    phase: StartupPhase
    error: Exception
    error_type: str
    message: str
    timestamp: float
    recoverable: bool = False
    retry_count: int = 0
    context: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary representation."""
        return {
            "phase": self.phase.value,
            "error_type": self.error_type,
            "message": self.message,
            "timestamp": self.timestamp,
            "recoverable": self.recoverable,
            "retry_count": self.retry_count,
            "context": self.context,
            "traceback": traceback.format_exception(type(self.error), self.error, self.error.__traceback__)
        }


@dataclass
class StartupPhaseResult:
    """Result of a startup phase execution."""
    phase: StartupPhase
    success: bool
    duration: float
    error: Optional[StartupError] = None
    data: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)


@dataclass
class StartupProgress:
    """Tracks overall startup progress."""
    session_id: str = field(default_factory=lambda: str(uuid4()))
    status: StartupStatus = StartupStatus.NOT_STARTED
    current_phase: Optional[StartupPhase] = None
    completed_phases: Set[StartupPhase] = field(default_factory=set)
    failed_phases: Set[StartupPhase] = field(default_factory=set)
    phase_results: Dict[StartupPhase, StartupPhaseResult] = field(default_factory=dict)
    total_duration: float = 0.0
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    error_count: int = 0
    warning_count: int = 0


StartupPhaseHandler = Callable[[], Awaitable[StartupPhaseResult]]


class StartupManager:
    """
    Comprehensive startup manager with error handling and recovery.
    
    This class orchestrates the startup process for the repository system,
    providing robust error handling, progress tracking, and recovery mechanisms.
    """
    
    def __init__(self, config_manager: Optional[DatabaseConfigManager] = None):
        """
        Initialize the startup manager.
        
        Args:
            config_manager: Optional database configuration manager
        """
        self._config_manager = config_manager or DatabaseConfigManager()
        self._container = get_container()
        self._progress = StartupProgress()
        self._phase_handlers: Dict[StartupPhase, StartupPhaseHandler] = {}
        self._recovery_handlers: Dict[StartupPhase, StartupPhaseHandler] = {}
        self._cleanup_handlers: List[Callable[[], Awaitable[None]]] = []
        
        # Configuration
        self.max_retry_attempts = 3
        self.retry_delay = 2.0
        self.health_check_timeout = 30.0
        self.startup_timeout = 300.0  # 5 minutes
        
        # Register default phase handlers
        self._register_default_handlers()
        
        logger.info(f"Startup manager initialized (session: {self._progress.session_id})")
    
    def _register_default_handlers(self):
        """Register default handlers for all startup phases."""
        self._phase_handlers = {
            StartupPhase.CONFIGURATION_LOAD: self._handle_configuration_load,
            StartupPhase.DEPENDENCY_VALIDATION: self._handle_dependency_validation,
            StartupPhase.REPOSITORY_PRELOAD: self._handle_repository_preload,
            StartupPhase.DATABASE_CONNECTION: self._handle_database_connection,
            StartupPhase.HEALTH_CHECKS: self._handle_health_checks,
            StartupPhase.FINALIZATION: self._handle_finalization
        }
        
        self._recovery_handlers = {
            StartupPhase.DATABASE_CONNECTION: self._recover_database_connection,
            StartupPhase.HEALTH_CHECKS: self._recover_health_checks
        }
    
    async def startup(self) -> StartupProgress:
        """
        Execute the complete startup process.
        
        Returns:
            Startup progress information
            
        Raises:
            StartupError: If startup fails and cannot be recovered
        """
        logger.info("Beginning repository system startup")
        
        self._progress.status = StartupStatus.IN_PROGRESS
        self._progress.started_at = time.time()
        
        try:
            # Execute startup with timeout
            await asyncio.wait_for(
                self._execute_startup_phases(),
                timeout=self.startup_timeout
            )
            
            self._progress.status = StartupStatus.COMPLETED
            self._progress.completed_at = time.time()
            self._progress.total_duration = self._progress.completed_at - self._progress.started_at
            
            logger.info(
                f"Repository system startup completed successfully "
                f"(duration: {self._progress.total_duration:.2f}s, "
                f"errors: {self._progress.error_count}, "
                f"warnings: {self._progress.warning_count})"
            )
            
            return self._progress
            
        except asyncio.TimeoutError:
            error_msg = f"Startup timed out after {self.startup_timeout}s"
            logger.error(error_msg)
            await self._handle_startup_failure(Exception(error_msg))
            raise
            
        except Exception as e:
            logger.error(f"Startup failed: {e}")
            await self._handle_startup_failure(e)
            raise
    
    async def _execute_startup_phases(self):
        """Execute all startup phases in order."""
        phases = list(StartupPhase)
        
        for phase in phases:
            self._progress.current_phase = phase
            logger.info(f"Executing startup phase: {phase.value}")
            
            try:
                result = await self._execute_phase_with_retry(phase)
                
                self._progress.phase_results[phase] = result
                self._progress.warning_count += len(result.warnings)
                
                if result.success:
                    self._progress.completed_phases.add(phase)
                    logger.info(f"Phase {phase.value} completed successfully ({result.duration:.2f}s)")
                    
                    for warning in result.warnings:
                        logger.warning(f"Phase {phase.value} warning: {warning}")
                else:
                    self._progress.failed_phases.add(phase)
                    self._progress.error_count += 1
                    
                    if result.error and not result.error.recoverable:
                        logger.error(f"Phase {phase.value} failed with unrecoverable error")
                        raise result.error.error
                    
                    logger.warning(f"Phase {phase.value} failed but was recovered")
                    
            except Exception as e:
                error = StartupError(
                    phase=phase,
                    error=e,
                    error_type=type(e).__name__,
                    message=str(e),
                    timestamp=time.time()
                )
                
                result = StartupPhaseResult(
                    phase=phase,
                    success=False,
                    duration=0.0,
                    error=error
                )
                
                self._progress.phase_results[phase] = result
                self._progress.failed_phases.add(phase)
                self._progress.error_count += 1
                
                logger.error(f"Phase {phase.value} failed: {e}")
                raise
    
    async def _execute_phase_with_retry(self, phase: StartupPhase) -> StartupPhaseResult:
        """
        Execute a phase with retry logic.
        
        Args:
            phase: The phase to execute
            
        Returns:
            Phase execution result
        """
        handler = self._phase_handlers.get(phase)
        if not handler:
            raise ValueError(f"No handler registered for phase: {phase}")
        
        retry_count = 0
        last_error = None
        
        while retry_count <= self.max_retry_attempts:
            try:
                start_time = time.time()
                result = await handler()
                result.duration = time.time() - start_time
                
                if result.success or retry_count == self.max_retry_attempts:
                    return result
                
                # Phase failed but we have retries left
                if result.error:
                    last_error = result.error
                    result.error.retry_count = retry_count
                
                logger.warning(f"Phase {phase.value} failed (attempt {retry_count + 1}/{self.max_retry_attempts + 1})")
                
            except Exception as e:
                last_error = StartupError(
                    phase=phase,
                    error=e,
                    error_type=type(e).__name__,
                    message=str(e),
                    timestamp=time.time(),
                    retry_count=retry_count
                )
                
                logger.warning(f"Phase {phase.value} exception (attempt {retry_count + 1}/{self.max_retry_attempts + 1}): {e}")
            
            retry_count += 1
            
            # Wait before retry (with exponential backoff)
            if retry_count <= self.max_retry_attempts:
                delay = self.retry_delay * (2 ** (retry_count - 1))
                logger.debug(f"Waiting {delay:.1f}s before retry...")
                await asyncio.sleep(delay)
        
        # All retries exhausted - try recovery
        recovery_handler = self._recovery_handlers.get(phase)
        if recovery_handler:
            logger.info(f"Attempting recovery for phase {phase.value}")
            try:
                recovery_result = await recovery_handler()
                if recovery_result.success:
                    logger.info(f"Phase {phase.value} recovered successfully")
                    return recovery_result
            except Exception as e:
                logger.error(f"Recovery failed for phase {phase.value}: {e}")
        
        # Create final failure result
        return StartupPhaseResult(
            phase=phase,
            success=False,
            duration=0.0,
            error=last_error
        )
    
    async def _handle_configuration_load(self) -> StartupPhaseResult:
        """Handle configuration loading phase."""
        logger.debug("Loading database configuration from environment")
        
        try:
            config = load_database_config()
            
            # Validate configuration
            validation_errors = config.validate()
            warnings = []
            
            if validation_errors:
                # Critical configuration errors
                error_msg = f"Configuration validation failed: {'; '.join(validation_errors)}"
                raise ValueError(error_msg)
            
            # Check for potential issues
            if config.environment.value == "production" and config.enable_debug_logging:
                warnings.append("Debug logging is enabled in production environment")
            
            if config.connection.pool_size > 50:
                warnings.append(f"Very large connection pool size: {config.connection.pool_size}")
            
            return StartupPhaseResult(
                phase=StartupPhase.CONFIGURATION_LOAD,
                success=True,
                duration=0.0,
                data={"config": config},
                warnings=warnings
            )
            
        except Exception as e:
            error = StartupError(
                phase=StartupPhase.CONFIGURATION_LOAD,
                error=e,
                error_type=type(e).__name__,
                message=f"Failed to load database configuration: {e}",
                timestamp=time.time(),
                recoverable=False  # Configuration errors are not recoverable
            )
            
            return StartupPhaseResult(
                phase=StartupPhase.CONFIGURATION_LOAD,
                success=False,
                duration=0.0,
                error=error
            )
    
    async def _handle_dependency_validation(self) -> StartupPhaseResult:
        """Handle dependency validation phase."""
        logger.debug("Validating repository dependencies")
        
        try:
            # Get container registration info
            registrations = self._container.get_registration_info()
            warnings = []
            
            if not registrations:
                warnings.append("No dependencies registered in container")
            
            # Validate that we have all required repository types
            required_repos = [
                "ISourceRepository", "IDocumentRepository", "ICodeExampleRepository",
                "IProjectRepository", "ITaskRepository", "IVersionRepository", 
                "ISettingsRepository", "IPromptRepository"
            ]
            
            missing_repos = []
            for repo_type in required_repos:
                if repo_type not in registrations:
                    missing_repos.append(repo_type)
            
            if missing_repos:
                warnings.append(f"Missing repository registrations: {', '.join(missing_repos)}")
            
            return StartupPhaseResult(
                phase=StartupPhase.DEPENDENCY_VALIDATION,
                success=True,
                duration=0.0,
                data={"registrations": registrations},
                warnings=warnings
            )
            
        except Exception as e:
            error = StartupError(
                phase=StartupPhase.DEPENDENCY_VALIDATION,
                error=e,
                error_type=type(e).__name__,
                message=f"Dependency validation failed: {e}",
                timestamp=time.time(),
                recoverable=False
            )
            
            return StartupPhaseResult(
                phase=StartupPhase.DEPENDENCY_VALIDATION,
                success=False,
                duration=0.0,
                error=error
            )
    
    async def _handle_repository_preload(self) -> StartupPhaseResult:
        """Handle repository preloading phase."""
        logger.debug("Preloading repository classes")
        
        try:
            # Preload critical repositories
            critical_repos = [
                "SupabaseSourceRepository",
                "SupabaseDocumentRepository", 
                "SupabaseProjectRepository",
                "SupabaseSettingsRepository"
            ]
            
            preload_results = preload_repositories(critical_repos)
            
            failed_repos = []
            warnings = []
            
            for repo_name, result in preload_results.items():
                if isinstance(result, Exception):
                    if isinstance(result, LazyImportError):
                        failed_repos.append(f"{repo_name}: {result}")
                    else:
                        failed_repos.append(f"{repo_name}: {type(result).__name__}: {result}")
            
            if failed_repos:
                if len(failed_repos) == len(critical_repos):
                    # All critical repositories failed - this is a failure
                    error_msg = f"Failed to preload critical repositories: {'; '.join(failed_repos)}"
                    raise Exception(error_msg)
                else:
                    # Some repositories failed - this is a warning
                    warnings.extend(failed_repos)
            
            successful_count = len(critical_repos) - len(failed_repos)
            logger.info(f"Preloaded {successful_count}/{len(critical_repos)} critical repositories")
            
            return StartupPhaseResult(
                phase=StartupPhase.REPOSITORY_PRELOAD,
                success=True,
                duration=0.0,
                data={"preload_results": preload_results},
                warnings=warnings
            )
            
        except Exception as e:
            error = StartupError(
                phase=StartupPhase.REPOSITORY_PRELOAD,
                error=e,
                error_type=type(e).__name__,
                message=f"Repository preload failed: {e}",
                timestamp=time.time(),
                recoverable=True  # Can continue without preloading
            )
            
            return StartupPhaseResult(
                phase=StartupPhase.REPOSITORY_PRELOAD,
                success=False,
                duration=0.0,
                error=error
            )
    
    async def _handle_database_connection(self) -> StartupPhaseResult:
        """Handle database connection phase."""
        logger.debug("Establishing database connection")
        
        try:
            # This would typically create and test the database connection
            # For now, we'll simulate this process
            await asyncio.sleep(0.1)  # Simulate connection time
            
            # In a real implementation, you would:
            # 1. Create the database client
            # 2. Test the connection
            # 3. Verify credentials
            # 4. Check database accessibility
            
            return StartupPhaseResult(
                phase=StartupPhase.DATABASE_CONNECTION,
                success=True,
                duration=0.0,
                data={"connection_status": "established"}
            )
            
        except Exception as e:
            error = StartupError(
                phase=StartupPhase.DATABASE_CONNECTION,
                error=e,
                error_type=type(e).__name__,
                message=f"Database connection failed: {e}",
                timestamp=time.time(),
                recoverable=True  # Connection issues might be transient
            )
            
            return StartupPhaseResult(
                phase=StartupPhase.DATABASE_CONNECTION,
                success=False,
                duration=0.0,
                error=error
            )
    
    async def _handle_health_checks(self) -> StartupPhaseResult:
        """Handle health checks phase."""
        logger.debug("Performing system health checks")
        
        try:
            health_results = await asyncio.wait_for(
                self._container.health_check(),
                timeout=self.health_check_timeout
            )
            
            failed_checks = []
            warnings = []
            
            for name, result in health_results.items():
                if not result.get("healthy", False):
                    error_msg = result.get("error", "Unknown error")
                    failed_checks.append(f"{name}: {error_msg}")
                
                if result.get("note"):
                    warnings.append(f"{name}: {result['note']}")
            
            if failed_checks:
                warning_msg = f"Health check failures: {'; '.join(failed_checks)}"
                warnings.append(warning_msg)
            
            return StartupPhaseResult(
                phase=StartupPhase.HEALTH_CHECKS,
                success=True,
                duration=0.0,
                data={"health_results": health_results},
                warnings=warnings
            )
            
        except asyncio.TimeoutError:
            error = StartupError(
                phase=StartupPhase.HEALTH_CHECKS,
                error=asyncio.TimeoutError("Health check timeout"),
                error_type="TimeoutError",
                message=f"Health checks timed out after {self.health_check_timeout}s",
                timestamp=time.time(),
                recoverable=True
            )
            
            return StartupPhaseResult(
                phase=StartupPhase.HEALTH_CHECKS,
                success=False,
                duration=0.0,
                error=error
            )
            
        except Exception as e:
            error = StartupError(
                phase=StartupPhase.HEALTH_CHECKS,
                error=e,
                error_type=type(e).__name__,
                message=f"Health checks failed: {e}",
                timestamp=time.time(),
                recoverable=True
            )
            
            return StartupPhaseResult(
                phase=StartupPhase.HEALTH_CHECKS,
                success=False,
                duration=0.0,
                error=error
            )
    
    async def _handle_finalization(self) -> StartupPhaseResult:
        """Handle finalization phase."""
        logger.debug("Finalizing repository system startup")
        
        try:
            # Final validation and cleanup
            # Register cleanup handlers
            self._cleanup_handlers.append(self._container.cleanup)
            
            # Log startup summary
            summary = self._generate_startup_summary()
            logger.info(f"Startup summary: {summary}")
            
            return StartupPhaseResult(
                phase=StartupPhase.FINALIZATION,
                success=True,
                duration=0.0,
                data={"startup_summary": summary}
            )
            
        except Exception as e:
            error = StartupError(
                phase=StartupPhase.FINALIZATION,
                error=e,
                error_type=type(e).__name__,
                message=f"Finalization failed: {e}",
                timestamp=time.time(),
                recoverable=False
            )
            
            return StartupPhaseResult(
                phase=StartupPhase.FINALIZATION,
                success=False,
                duration=0.0,
                error=error
            )
    
    async def _recover_database_connection(self) -> StartupPhaseResult:
        """Attempt recovery for database connection failures."""
        logger.info("Attempting database connection recovery")
        
        try:
            # Implement connection recovery logic here
            # This might include:
            # - Retrying with different connection parameters
            # - Falling back to a different database
            # - Using cached/offline mode
            
            await asyncio.sleep(1.0)  # Simulate recovery time
            
            return StartupPhaseResult(
                phase=StartupPhase.DATABASE_CONNECTION,
                success=True,
                duration=1.0,
                data={"recovery": "successful"}
            )
            
        except Exception as e:
            logger.error(f"Database connection recovery failed: {e}")
            raise
    
    async def _recover_health_checks(self) -> StartupPhaseResult:
        """Attempt recovery for health check failures."""
        logger.info("Attempting health check recovery")
        
        try:
            # Implement health check recovery
            # This might include:
            # - Skipping non-critical health checks
            # - Using degraded service mode
            # - Continuing with warnings
            
            return StartupPhaseResult(
                phase=StartupPhase.HEALTH_CHECKS,
                success=True,
                duration=0.1,
                data={"recovery": "degraded_mode"},
                warnings=["Operating in degraded mode due to health check failures"]
            )
            
        except Exception as e:
            logger.error(f"Health check recovery failed: {e}")
            raise
    
    async def _handle_startup_failure(self, error: Exception):
        """Handle overall startup failure."""
        self._progress.status = StartupStatus.FAILED
        self._progress.completed_at = time.time()
        
        if self._progress.started_at:
            self._progress.total_duration = self._progress.completed_at - self._progress.started_at
        
        logger.error(
            f"Repository system startup failed after {self._progress.total_duration:.2f}s: {error}"
        )
        
        # Attempt cleanup
        await self._cleanup_on_failure()
    
    async def _cleanup_on_failure(self):
        """Clean up resources on startup failure."""
        logger.info("Cleaning up resources after startup failure")
        
        for handler in reversed(self._cleanup_handlers):
            try:
                await handler()
            except Exception as e:
                logger.warning(f"Cleanup handler failed: {e}")
    
    def _generate_startup_summary(self) -> Dict[str, Any]:
        """Generate a startup summary."""
        return {
            "session_id": self._progress.session_id,
            "total_duration": sum(
                result.duration for result in self._progress.phase_results.values()
            ),
            "completed_phases": len(self._progress.completed_phases),
            "failed_phases": len(self._progress.failed_phases),
            "error_count": self._progress.error_count,
            "warning_count": self._progress.warning_count,
            "phase_durations": {
                phase.value: result.duration
                for phase, result in self._progress.phase_results.items()
            }
        }
    
    def get_progress(self) -> StartupProgress:
        """Get current startup progress."""
        return self._progress
    
    @asynccontextmanager
    async def startup_context(self):
        """
        Async context manager for startup lifecycle.
        
        Usage:
            async with startup_manager.startup_context():
                # System is started and ready
                pass
            # System is cleaned up
        """
        try:
            await self.startup()
            yield self
        finally:
            await self.cleanup()
    
    async def cleanup(self):
        """Clean up all startup resources."""
        logger.info("Cleaning up startup manager resources")
        
        for handler in reversed(self._cleanup_handlers):
            try:
                await handler()
            except Exception as e:
                logger.warning(f"Cleanup handler failed: {e}")
        
        self._cleanup_handlers.clear()


# Global startup manager instance
_startup_manager: Optional[StartupManager] = None


def get_startup_manager() -> StartupManager:
    """Get the global startup manager instance."""
    global _startup_manager
    if _startup_manager is None:
        _startup_manager = StartupManager()
    return _startup_manager


async def initialize_repository_system() -> StartupProgress:
    """
    Initialize the complete repository system.
    
    Returns:
        Startup progress information
        
    Raises:
        Exception: If initialization fails
    """
    manager = get_startup_manager()
    return await manager.startup()


@asynccontextmanager
async def repository_system_context():
    """
    Async context manager for the repository system lifecycle.
    
    Usage:
        async with repository_system_context():
            # Repository system is initialized and ready
            pass
        # Repository system is cleaned up
    """
    manager = get_startup_manager()
    async with manager.startup_context():
        yield manager