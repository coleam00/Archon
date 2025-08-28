"""
Type-safe dependency injection system for repositories.

This module provides a comprehensive dependency injection system with:
- Type-safe dependency resolution
- Lazy loading capabilities
- Lifecycle management
- Configuration-based instantiation
- Health checking and monitoring
- Error handling and recovery

The system follows the Dependency Inversion Principle and provides
clean abstractions for managing repository dependencies.
"""

import asyncio
import logging
import threading
from abc import ABC, abstractmethod
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from enum import Enum
from typing import (
    Any, Dict, Type, Optional, Union, Generic, TypeVar, 
    Protocol, runtime_checkable, Callable, List, Set
)
from uuid import uuid4

from ..interfaces.unit_of_work import IUnitOfWork
from .lazy_imports import get_repository_class, LazyImportError


logger = logging.getLogger(__name__)

T = TypeVar('T')
RepositoryType = TypeVar('RepositoryType')


class DependencyLifecycle(Enum):
    """Dependency lifecycle management options."""
    SINGLETON = "singleton"  # Single instance across application
    SCOPED = "scoped"       # Instance per scope (e.g., request)
    TRANSIENT = "transient"  # New instance per resolution


class DependencyState(Enum):
    """State of a dependency instance."""
    UNINITIALIZED = "uninitialized"
    INITIALIZING = "initializing" 
    INITIALIZED = "initialized"
    FAILED = "failed"
    DISPOSED = "disposed"


@dataclass
class DependencyRegistration:
    """Registration information for a dependency."""
    name: str
    interface_type: Type
    implementation_type: Optional[Type] = None
    implementation_name: Optional[str] = None  # For lazy loading
    lifecycle: DependencyLifecycle = DependencyLifecycle.SINGLETON
    factory: Optional[Callable[..., Any]] = None
    dependencies: List[str] = field(default_factory=list)
    health_check: Optional[Callable[[Any], bool]] = None
    
    def __post_init__(self):
        """Validate registration after initialization."""
        if not self.implementation_type and not self.implementation_name and not self.factory:
            raise ValueError(
                f"Registration for {self.name} must have either "
                "implementation_type, implementation_name, or factory"
            )


@dataclass 
class DependencyInstance:
    """Runtime information about a dependency instance."""
    registration: DependencyRegistration
    instance: Any
    state: DependencyState = DependencyState.UNINITIALIZED
    created_at: float = field(default_factory=lambda: asyncio.get_event_loop().time())
    error: Optional[Exception] = None
    instance_id: str = field(default_factory=lambda: str(uuid4()))


@runtime_checkable
class IDependencyProvider(Protocol):
    """Protocol for dependency providers."""
    
    def get(self, dependency_type: Type[T]) -> T:
        """Get a dependency by type."""
        ...
    
    def get_by_name(self, name: str) -> Any:
        """Get a dependency by name."""
        ...


class DependencyResolutionError(Exception):
    """Raised when dependency resolution fails."""
    pass


class CircularDependencyError(DependencyResolutionError):
    """Raised when a circular dependency is detected."""
    pass


class DependencyContainer:
    """
    Type-safe dependency injection container with lazy loading support.
    
    This container provides comprehensive dependency management including:
    - Type-safe registration and resolution
    - Lazy loading with error handling
    - Lifecycle management (singleton, scoped, transient)
    - Circular dependency detection
    - Health monitoring
    - Graceful cleanup
    """
    
    def __init__(self):
        """Initialize the dependency container."""
        self._registrations: Dict[str, DependencyRegistration] = {}
        self._instances: Dict[str, DependencyInstance] = {}
        self._type_to_name: Dict[Type, str] = {}
        self._lock = threading.RLock()
        self._resolution_stack: Set[str] = set()
        self._health_check_tasks: Dict[str, asyncio.Task] = {}
        
        logger.info("Dependency container initialized")
    
    def register(
        self,
        interface_type: Type[T],
        implementation_type: Optional[Type[T]] = None,
        implementation_name: Optional[str] = None,
        name: Optional[str] = None,
        lifecycle: DependencyLifecycle = DependencyLifecycle.SINGLETON,
        factory: Optional[Callable[..., T]] = None,
        dependencies: Optional[List[str]] = None,
        health_check: Optional[Callable[[T], bool]] = None
    ) -> 'DependencyContainer':
        """
        Register a dependency in the container.
        
        Args:
            interface_type: The interface/abstract type
            implementation_type: The concrete implementation type
            implementation_name: Name for lazy loading
            name: Optional custom name for the dependency
            lifecycle: Lifecycle management option
            factory: Custom factory function
            dependencies: List of dependency names this depends on
            health_check: Optional health check function
            
        Returns:
            Self for method chaining
            
        Raises:
            ValueError: If registration parameters are invalid
        """
        with self._lock:
            registration_name = name or interface_type.__name__
            
            if registration_name in self._registrations:
                logger.warning(f"Overriding existing registration for {registration_name}")
            
            registration = DependencyRegistration(
                name=registration_name,
                interface_type=interface_type,
                implementation_type=implementation_type,
                implementation_name=implementation_name,
                lifecycle=lifecycle,
                factory=factory,
                dependencies=dependencies or [],
                health_check=health_check
            )
            
            self._registrations[registration_name] = registration
            self._type_to_name[interface_type] = registration_name
            
            logger.info(
                f"Registered dependency: {registration_name} "
                f"(lifecycle: {lifecycle.value})"
            )
            
            return self
    
    def register_repository(
        self,
        interface_type: Type[T],
        implementation_name: str,
        name: Optional[str] = None,
        dependencies: Optional[List[str]] = None
    ) -> 'DependencyContainer':
        """
        Convenience method for registering repositories with lazy loading.
        
        Args:
            interface_type: The repository interface
            implementation_name: Name of the implementation class for lazy loading
            name: Optional custom name
            dependencies: List of dependency names
            
        Returns:
            Self for method chaining
        """
        return self.register(
            interface_type=interface_type,
            implementation_name=implementation_name,
            name=name,
            lifecycle=DependencyLifecycle.SINGLETON,
            dependencies=dependencies or ["client"]
        )
    
    def get(self, dependency_type: Type[T]) -> T:
        """
        Get a dependency by its type.
        
        Args:
            dependency_type: The type of dependency to resolve
            
        Returns:
            The resolved dependency instance
            
        Raises:
            DependencyResolutionError: If dependency cannot be resolved
        """
        with self._lock:
            if dependency_type not in self._type_to_name:
                raise DependencyResolutionError(
                    f"No registration found for type: {dependency_type}"
                )
            
            name = self._type_to_name[dependency_type]
            return self.get_by_name(name)
    
    def get_by_name(self, name: str) -> Any:
        """
        Get a dependency by its registered name.
        
        Args:
            name: The name of the dependency
            
        Returns:
            The resolved dependency instance
            
        Raises:
            DependencyResolutionError: If dependency cannot be resolved
        """
        with self._lock:
            if name not in self._registrations:
                available = list(self._registrations.keys())
                raise DependencyResolutionError(
                    f"No registration found for name: {name}. "
                    f"Available: {', '.join(available)}"
                )
            
            registration = self._registrations[name]
            
            # Check for circular dependencies
            if name in self._resolution_stack:
                circular_chain = " -> ".join(self._resolution_stack) + f" -> {name}"
                raise CircularDependencyError(
                    f"Circular dependency detected: {circular_chain}"
                )
            
            self._resolution_stack.add(name)
            
            try:
                # Check lifecycle for existing instances
                if (registration.lifecycle == DependencyLifecycle.SINGLETON and 
                    name in self._instances):
                    instance = self._instances[name]
                    if instance.state == DependencyState.INITIALIZED:
                        return instance.instance
                    elif instance.state == DependencyState.FAILED:
                        raise DependencyResolutionError(
                            f"Dependency {name} previously failed to initialize: {instance.error}"
                        )
                
                # Create new instance
                return self._create_instance(registration)
                
            finally:
                self._resolution_stack.discard(name)
    
    def _create_instance(self, registration: DependencyRegistration) -> Any:
        """
        Create a new instance of a dependency.
        
        Args:
            registration: The dependency registration
            
        Returns:
            The created instance
            
        Raises:
            DependencyResolutionError: If instance creation fails
        """
        instance_record = DependencyInstance(
            registration=registration,
            instance=None,
            state=DependencyState.INITIALIZING
        )
        
        try:
            # Resolve dependencies first
            resolved_deps = {}
            for dep_name in registration.dependencies:
                resolved_deps[dep_name] = self.get_by_name(dep_name)
            
            # Create instance using appropriate method
            if registration.factory:
                instance = registration.factory(**resolved_deps)
            elif registration.implementation_type:
                # Direct instantiation
                if registration.dependencies:
                    instance = registration.implementation_type(**resolved_deps)
                else:
                    instance = registration.implementation_type()
            elif registration.implementation_name:
                # Lazy loading
                impl_class = get_repository_class(registration.implementation_name)
                if registration.dependencies:
                    instance = impl_class(**resolved_deps)
                else:
                    instance = impl_class()
            else:
                raise DependencyResolutionError(
                    f"No implementation method available for {registration.name}"
                )
            
            # Update instance record
            instance_record.instance = instance
            instance_record.state = DependencyState.INITIALIZED
            
            # Store for lifecycle management
            if registration.lifecycle == DependencyLifecycle.SINGLETON:
                self._instances[registration.name] = instance_record
            
            # Start health monitoring if configured
            if registration.health_check:
                self._start_health_monitoring(registration.name, instance_record)
            
            logger.info(f"Created instance of {registration.name}")
            return instance
            
        except Exception as e:
            instance_record.state = DependencyState.FAILED
            instance_record.error = e
            
            # Store failed instance for singleton to avoid retry
            if registration.lifecycle == DependencyLifecycle.SINGLETON:
                self._instances[registration.name] = instance_record
            
            logger.error(f"Failed to create instance of {registration.name}: {e}")
            raise DependencyResolutionError(
                f"Failed to create instance of {registration.name}: {e}"
            ) from e
    
    def _start_health_monitoring(self, name: str, instance_record: DependencyInstance):
        """Start health monitoring for an instance."""
        async def health_monitor():
            while instance_record.state == DependencyState.INITIALIZED:
                try:
                    is_healthy = instance_record.registration.health_check(instance_record.instance)
                    if not is_healthy:
                        logger.warning(f"Health check failed for {name}")
                except Exception as e:
                    logger.error(f"Health check error for {name}: {e}")
                
                await asyncio.sleep(30)  # Check every 30 seconds
        
        try:
            loop = asyncio.get_event_loop()
            task = loop.create_task(health_monitor())
            self._health_check_tasks[name] = task
        except RuntimeError:
            # No event loop running, skip health monitoring
            logger.debug(f"No event loop available for health monitoring {name}")
    
    async def health_check(self) -> Dict[str, Dict[str, Any]]:
        """
        Perform health checks on all registered dependencies.
        
        Returns:
            Dictionary with health status for each dependency
        """
        results = {}
        
        for name, instance_record in self._instances.items():
            if instance_record.state != DependencyState.INITIALIZED:
                results[name] = {
                    "healthy": False,
                    "state": instance_record.state.value,
                    "error": str(instance_record.error) if instance_record.error else None
                }
                continue
            
            # Run health check if available
            registration = instance_record.registration
            if registration.health_check:
                try:
                    is_healthy = registration.health_check(instance_record.instance)
                    results[name] = {
                        "healthy": is_healthy,
                        "state": instance_record.state.value,
                        "instance_id": instance_record.instance_id
                    }
                except Exception as e:
                    results[name] = {
                        "healthy": False,
                        "state": instance_record.state.value,
                        "error": str(e),
                        "instance_id": instance_record.instance_id
                    }
            else:
                results[name] = {
                    "healthy": True,
                    "state": instance_record.state.value,
                    "instance_id": instance_record.instance_id,
                    "note": "No health check configured"
                }
        
        return results
    
    async def cleanup(self):
        """Clean up all resources and instances."""
        logger.info("Starting dependency container cleanup")
        
        # Cancel health monitoring tasks
        for task in self._health_check_tasks.values():
            if not task.cancelled():
                task.cancel()
        
        if self._health_check_tasks:
            await asyncio.gather(*self._health_check_tasks.values(), return_exceptions=True)
        
        # Dispose of instances
        for name, instance_record in self._instances.items():
            try:
                if hasattr(instance_record.instance, 'close'):
                    if asyncio.iscoroutinefunction(instance_record.instance.close):
                        await instance_record.instance.close()
                    else:
                        instance_record.instance.close()
                        
                instance_record.state = DependencyState.DISPOSED
                logger.debug(f"Disposed instance: {name}")
                
            except Exception as e:
                logger.warning(f"Error disposing instance {name}: {e}")
        
        # Clear all data
        self._instances.clear()
        self._health_check_tasks.clear()
        
        logger.info("Dependency container cleanup completed")
    
    def get_registration_info(self) -> Dict[str, Dict[str, Any]]:
        """
        Get information about all registered dependencies.
        
        Returns:
            Dictionary with registration information
        """
        return {
            name: {
                "interface_type": reg.interface_type.__name__,
                "implementation_type": reg.implementation_type.__name__ if reg.implementation_type else None,
                "implementation_name": reg.implementation_name,
                "lifecycle": reg.lifecycle.value,
                "dependencies": reg.dependencies,
                "has_factory": reg.factory is not None,
                "has_health_check": reg.health_check is not None
            }
            for name, reg in self._registrations.items()
        }


# Global container instance
_container = DependencyContainer()


def get_container() -> DependencyContainer:
    """Get the global dependency container."""
    return _container


def reset_container():
    """Reset the global container (primarily for testing)."""
    global _container
    _container = DependencyContainer()


@asynccontextmanager
async def dependency_scope():
    """
    Create a scoped dependency context.
    
    This can be used to ensure proper cleanup of scoped dependencies.
    """
    # In a full implementation, this would create a child scope
    # For now, it's a placeholder for the concept
    try:
        yield _container
    finally:
        # Cleanup scoped instances would go here
        pass