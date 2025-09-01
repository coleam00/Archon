"""
Threading Service for Archon

This service provides comprehensive threading patterns for high-performance AI operations
while maintaining WebSocket connection health and system stability.

Based on proven patterns from crawl4ai_mcp.py architecture.
"""

import asyncio
import gc
import threading
import time
from collections import deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

# Removed direct logging import - using unified config
from enum import Enum
from typing import Any

import psutil
from fastapi import WebSocket

from ..config.logfire_config import get_logger

# Get logger for this module
logfire_logger = get_logger("threading")


class ProcessingMode(str, Enum):
    """Processing modes for different workload types"""

    CPU_INTENSIVE = "cpu_intensive"  # AI summaries, embeddings, heavy computation
    IO_BOUND = "io_bound"  # Database operations, file I/O
    NETWORK_BOUND = "network_bound"  # External API calls, web requests
    WEBSOCKET_SAFE = "websocket_safe"  # Operations that need to yield for WebSocket health


@dataclass
class RateLimitConfig:
    """Configuration for rate limiting"""

    tokens_per_minute: int = 200_000  # OpenAI embedding limit
    requests_per_minute: int = 3000  # Request rate limit
    max_concurrent: int = 2  # Concurrent request limit
    backoff_multiplier: float = 1.5  # Exponential backoff multiplier
    max_backoff: float = 60.0  # Maximum backoff delay in seconds


@dataclass
class SystemMetrics:
    """Current system performance metrics"""

    memory_percent: float
    cpu_percent: float
    available_memory_gb: float
    active_threads: int
    timestamp: float = field(default_factory=time.time)


@dataclass
class ThreadingConfig:
    """Configuration for threading behavior"""

    base_workers: int = 4
    max_workers: int = 16
    memory_threshold: float = 0.8
    cpu_threshold: float = 0.9
    batch_size: int = 15
    yield_interval: float = 0.1  # How often to yield for WebSocket health
    health_check_interval: float = 30  # System health check frequency


class RateLimiter:
    """Thread-safe rate limiter with token bucket algorithm"""

    def __init__(self, config: RateLimitConfig):
        self.config = config
        self.request_times = deque()
        self.token_usage = deque()
        self.semaphore = asyncio.Semaphore(config.max_concurrent)
        self._lock = asyncio.Lock()

    async def acquire(self, estimated_tokens: int = 8000, progress_callback: Callable | None = None) -> bool:
        """Acquire permission to make API call with token awareness
        
        Args:
            estimated_tokens: Estimated number of tokens for the operation
            progress_callback: Optional async callback for progress updates during wait
        """
        while True:  # Loop instead of recursion to avoid stack overflow
            wait_time_to_sleep = None
            
            async with self._lock:
                now = time.time()

                # Clean old entries
                self._clean_old_entries(now)

                # Check if we can make the request
                if self._can_make_request(estimated_tokens):
                    # Record the request
                    self.request_times.append(now)
                    self.token_usage.append((now, estimated_tokens))
                    return True
                
                # Calculate wait time if we can't make the request
                wait_time = self._calculate_wait_time(estimated_tokens)
                if wait_time > 0:
                    logfire_logger.info(
                        f"Rate limiting: waiting {wait_time:.1f}s",
                        extra={
                            "tokens": estimated_tokens,
                            "current_usage": self._get_current_usage(),
                        }
                    )
                    wait_time_to_sleep = wait_time
                else:
                    return False
            
            # Sleep outside the lock to avoid deadlock
            if wait_time_to_sleep is not None:
                # For long waits, break into smaller chunks with progress updates
                if wait_time_to_sleep > 5 and progress_callback:
                    chunks = int(wait_time_to_sleep / 5)  # 5 second chunks
                    for i in range(chunks):
                        await asyncio.sleep(5)
                        remaining = wait_time_to_sleep - (i + 1) * 5
                        if progress_callback:
                            await progress_callback({
                                "type": "rate_limit_wait",
                                "remaining_seconds": max(0, remaining),
                                "message": f"waiting {max(0, remaining):.1f}s more..."
                            })
                    # Sleep any remaining time
                    if wait_time_to_sleep % 5 > 0:
                        await asyncio.sleep(wait_time_to_sleep % 5)
                else:
                    await asyncio.sleep(wait_time_to_sleep)
                # Continue the loop to try again

    def _can_make_request(self, estimated_tokens: int) -> bool:
        """Check if request can be made within limits"""
        # Check request rate limit
        if len(self.request_times) >= self.config.requests_per_minute:
            return False

        # Check token usage limit
        current_tokens = sum(tokens for _, tokens in self.token_usage)
        if current_tokens + estimated_tokens > self.config.tokens_per_minute:
            return False

        return True

    def _clean_old_entries(self, current_time: float):
        """Remove entries older than 1 minute"""
        cutoff_time = current_time - 60

        while self.request_times and self.request_times[0] < cutoff_time:
            self.request_times.popleft()

        while self.token_usage and self.token_usage[0][0] < cutoff_time:
            self.token_usage.popleft()

    def _calculate_wait_time(self, estimated_tokens: int) -> float:
        """Calculate how long to wait before retrying"""
        if not self.request_times:
            return 0

        oldest_request = self.request_times[0]
        time_since_oldest = time.time() - oldest_request

        if time_since_oldest < 60:
            return 60 - time_since_oldest + 0.1

        return 0

    def _get_current_usage(self) -> dict[str, int]:
        """Get current usage statistics"""
        current_tokens = sum(tokens for _, tokens in self.token_usage)
        return {
            "requests": len(self.request_times),
            "tokens": current_tokens,
            "max_requests": self.config.requests_per_minute,
            "max_tokens": self.config.tokens_per_minute,
        }


class MemoryAdaptiveDispatcher:
    """Dynamically adjust concurrency based on memory usage"""

    def __init__(self, config: ThreadingConfig):
        self.config = config
        self.current_workers = config.base_workers
        self.last_metrics = None

    def get_system_metrics(self) -> SystemMetrics:
        """Get current system performance metrics"""
        memory = psutil.virtual_memory()
        cpu_percent = psutil.cpu_percent(interval=1)
        active_threads = threading.active_count()

        return SystemMetrics(
            memory_percent=memory.percent,
            cpu_percent=cpu_percent,
            available_memory_gb=memory.available / (1024**3),
            active_threads=active_threads,
        )

    def calculate_optimal_workers(self, mode: ProcessingMode = ProcessingMode.CPU_INTENSIVE) -> int:
        """Calculate optimal worker count based on system load and processing mode"""
        metrics = self.get_system_metrics()
        self.last_metrics = metrics

        # Base worker count depends on processing mode
        if mode == ProcessingMode.CPU_INTENSIVE:
            base = min(self.config.base_workers, psutil.cpu_count())
        elif mode == ProcessingMode.IO_BOUND:
            base = self.config.base_workers * 2
        elif mode == ProcessingMode.NETWORK_BOUND:
            base = self.config.base_workers
        else:  # WEBSOCKET_SAFE
            base = max(1, self.config.base_workers // 2)

        # Adjust based on system load
        if metrics.memory_percent > self.config.memory_threshold * 100:
            # Reduce workers when memory is high
            workers = max(1, base // 2)
            logfire_logger.warning(
                "High memory usage detected, reducing workers",
                extra={
                    "memory_percent": metrics.memory_percent,
                    "workers": workers,
                }
            )
        elif metrics.cpu_percent > self.config.cpu_threshold * 100:
            # Reduce workers when CPU is high
            workers = max(1, base // 2)
            logfire_logger.warning(
                "High CPU usage detected, reducing workers",
                extra={
                    "cpu_percent": metrics.cpu_percent,
                    "workers": workers,
                }
            )
        elif metrics.memory_percent < 50 and metrics.cpu_percent < 50:
            # Increase workers when resources are available
            workers = min(self.config.max_workers, base * 2)
        else:
            # Use base worker count
            workers = base

        self.current_workers = workers
        return workers

    async def process_with_adaptive_concurrency(
        self,
        items: list[Any],
        process_func: Callable,
        mode: ProcessingMode = ProcessingMode.CPU_INTENSIVE,
        websocket: WebSocket | None = None,
        progress_callback: Callable | None = None,
        enable_worker_tracking: bool = False,
    ) -> list[Any]:
        """Process items with adaptive concurrency control"""

        if not items:
            return []

        optimal_workers = self.calculate_optimal_workers(mode)
        semaphore = asyncio.Semaphore(optimal_workers)

        logfire_logger.info(
            "Starting adaptive processing",
            extra={
                "items_count": len(items),
                "workers": optimal_workers,
                "mode": mode,
                "memory_percent": self.last_metrics.memory_percent,
                "cpu_percent": self.last_metrics.cpu_percent,
            }
        )

        # Track active workers
        active_workers = {}
        worker_counter = 0
        completed_count = 0
        lock = asyncio.Lock()

        async def process_single(item: Any, index: int) -> Any:
            nonlocal worker_counter, completed_count

            # Assign worker ID
            worker_id = None
            async with lock:
                for i in range(1, optimal_workers + 1):
                    if i not in active_workers:
                        worker_id = i
                        active_workers[worker_id] = index
                        break

            async with semaphore:
                try:
                    # Report worker started
                    if progress_callback and worker_id:
                        await progress_callback({
                            "type": "worker_started",
                            "worker_id": worker_id,
                            "item_index": index,
                            "total_items": len(items),
                            "message": f"Worker {worker_id} processing item {index + 1}",
                        })

                    # For CPU-intensive work, run in thread pool
                    if mode == ProcessingMode.CPU_INTENSIVE:
                        loop = asyncio.get_event_loop()
                        result = await loop.run_in_executor(None, process_func, item)
                    else:
                        # For other modes, run directly (assumed to be async)
                        if asyncio.iscoroutinefunction(process_func):
                            result = await process_func(item)
                        else:
                            result = process_func(item)

                    # Update completed count
                    async with lock:
                        completed_count += 1
                        if worker_id in active_workers:
                            del active_workers[worker_id]

                    # Progress reporting with worker info
                    if progress_callback:
                        await progress_callback({
                            "type": "worker_completed",
                            "worker_id": worker_id,
                            "item_index": index,
                            "completed_count": completed_count,
                            "total_items": len(items),
                            "message": f"Worker {worker_id} completed item {index + 1}",
                        })

                    # WebSocket health check
                    if websocket and mode == ProcessingMode.WEBSOCKET_SAFE:
                        if index % 10 == 0:  # Every 10 items
                            await asyncio.sleep(self.config.yield_interval)

                    return result

                except Exception as e:
                    # Clean up worker on error
                    async with lock:
                        if worker_id and worker_id in active_workers:
                            del active_workers[worker_id]

                    logfire_logger.error(
                        f"Processing failed for item {index}",
                        extra={"error": str(e), "item_index": index}
                    )
                    return None

        # Create tasks for all items
        tasks = [process_single(item, idx) for idx, item in enumerate(items)]

        # Execute with controlled concurrency
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Filter out failed results and exceptions
        successful_results = [r for r in results if r is not None and not isinstance(r, Exception)]

        success_rate = len(successful_results) / len(items) * 100
        logfire_logger.info(
            "Adaptive processing completed",
            extra={
                "total_items": len(items),
                "successful": len(successful_results),
                "success_rate": f"{success_rate:.1f}%",
                "workers_used": optimal_workers,
            }
        )

        return successful_results


class WebSocketSafeProcessor:
    """WebSocket-safe processing with progress updates"""

    def __init__(self, config: ThreadingConfig):
        self.config = config
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        """Connect WebSocket client"""
        await websocket.accept()
        self.active_connections.append(websocket)
        logfire_logger.info(
            "WebSocket client connected",
            extra={"total_connections": len(self.active_connections)}
        )

    def disconnect(self, websocket: WebSocket):
        """Disconnect WebSocket client"""
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logfire_logger.info(
                "WebSocket client disconnected",
                extra={"remaining_connections": len(self.active_connections)}
            )

    async def broadcast_progress(self, message: dict[str, Any]):
        """Broadcast progress to all connected clients"""
        if not self.active_connections:
            return

        # Send to all clients concurrently
        tasks = []
        for connection in self.active_connections.copy():
            try:
                task = connection.send_json(message)
                tasks.append(task)
            except Exception:
                self.disconnect(connection)

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def process_with_progress(
        self,
        items: list[Any],
        process_func: Callable,
        operation_name: str = "processing",
        batch_size: int | None = None,
    ) -> list[Any]:
        """Process items with WebSocket progress updates"""

        if not items:
            return []

        batch_size = batch_size or self.config.batch_size
        total_items = len(items)
        results = []

        for batch_start in range(0, total_items, batch_size):
            batch_end = min(batch_start + batch_size, total_items)
            batch = items[batch_start:batch_end]

            # Process batch
            for i, item in enumerate(batch):
                if asyncio.iscoroutinefunction(process_func):
                    result = await process_func(item)
                else:
                    # Run in thread pool for CPU-intensive work
                    loop = asyncio.get_event_loop()
                    result = await loop.run_in_executor(None, process_func, item)

                results.append(result)

                # Calculate progress
                items_processed = batch_start + i + 1
                progress = (items_processed / total_items) * 100

                # Broadcast progress
                await self.broadcast_progress({
                    "type": "progress",
                    "operation": operation_name,
                    "progress": progress,
                    "processed": items_processed,
                    "total": total_items,
                    "batch": f"Batch {batch_start // batch_size + 1}",
                    "current_item": str(getattr(item, "id", i)),
                })

                # Yield control for WebSocket health
                await asyncio.sleep(self.config.yield_interval)

        # Final completion message
        await self.broadcast_progress({
            "type": "complete",
            "operation": operation_name,
            "total_processed": len(results),
            "success_rate": f"{len(results) / total_items * 100:.1f}%",
        })

        return results


class ThreadingService:
    """Main threading service that coordinates all threading operations"""

    def __init__(
        self,
        threading_config: ThreadingConfig | None = None,
        rate_limit_config: RateLimitConfig | None = None,
    ):
        self.config = threading_config or ThreadingConfig()
        self.rate_limiter = RateLimiter(rate_limit_config or RateLimitConfig())
        self.memory_dispatcher = MemoryAdaptiveDispatcher(self.config)
        self.websocket_processor = WebSocketSafeProcessor(self.config)

        # Thread pools for different workload types
        self.cpu_executor = ThreadPoolExecutor(
            max_workers=self.config.max_workers, thread_name_prefix="archon-cpu"
        )
        self.io_executor = ThreadPoolExecutor(
            max_workers=self.config.max_workers * 2, thread_name_prefix="archon-io"
        )

        self._running = False
        self._health_check_task = None

    async def start(self):
        """Start the threading service"""
        if self._running:
            return

        self._running = True
        self._health_check_task = asyncio.create_task(self._health_check_loop())
        logfire_logger.info("Threading service started", extra={"config": self.config.__dict__})

    async def stop(self):
        """Stop the threading service"""
        if not self._running:
            return

        self._running = False

        if self._health_check_task:
            self._health_check_task.cancel()
            try:
                await self._health_check_task
            except asyncio.CancelledError:
                pass

        # Shutdown thread pools
        self.cpu_executor.shutdown(wait=True)
        self.io_executor.shutdown(wait=True)

        logfire_logger.info("Threading service stopped")

    @asynccontextmanager
    async def rate_limited_operation(self, estimated_tokens: int = 8000, progress_callback: Callable | None = None):
        """Context manager for rate-limited operations
        
        Args:
            estimated_tokens: Estimated number of tokens for the operation
            progress_callback: Optional async callback for progress updates during wait
        """
        async with self.rate_limiter.semaphore:
            can_proceed = await self.rate_limiter.acquire(estimated_tokens, progress_callback)
            if not can_proceed:
                raise Exception("Rate limit exceeded")

            start_time = time.time()
            try:
                yield
            finally:
                duration = time.time() - start_time
                logfire_logger.debug(
                    "Rate limited operation completed",
                    extra={"duration": duration, "tokens": estimated_tokens},
                )

    async def run_cpu_intensive(self, func: Callable, *args, **kwargs) -> Any:
        """Run CPU-intensive function in thread pool"""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(self.cpu_executor, func, *args, **kwargs)

    async def run_io_bound(self, func: Callable, *args, **kwargs) -> Any:
        """Run I/O-bound function in thread pool"""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(self.io_executor, func, *args, **kwargs)

    async def batch_process(
        self,
        items: list[Any],
        process_func: Callable,
        mode: ProcessingMode = ProcessingMode.CPU_INTENSIVE,
        websocket: WebSocket | None = None,
        progress_callback: Callable | None = None,
        enable_worker_tracking: bool = False,
    ) -> list[Any]:
        """Process items in batches with optimal threading"""
        return await self.memory_dispatcher.process_with_adaptive_concurrency(
            items=items,
            process_func=process_func,
            mode=mode,
            websocket=websocket,
            progress_callback=progress_callback,
            enable_worker_tracking=enable_worker_tracking,
        )

    async def websocket_safe_process(
        self, items: list[Any], process_func: Callable, operation_name: str = "processing"
    ) -> list[Any]:
        """Process items with WebSocket safety guarantees"""
        return await self.websocket_processor.process_with_progress(
            items=items, process_func=process_func, operation_name=operation_name
        )

    def get_system_metrics(self) -> SystemMetrics:
        """Get current system performance metrics"""
        return self.memory_dispatcher.get_system_metrics()

    async def _health_check_loop(self):
        """Monitor system health and adjust threading parameters"""
        while self._running:
            try:
                metrics = self.get_system_metrics()

                # Log system metrics
                logfire_logger.info(
                    "System health check",
                    extra={
                        "memory_percent": metrics.memory_percent,
                        "cpu_percent": metrics.cpu_percent,
                        "available_memory_gb": metrics.available_memory_gb,
                        "active_threads": metrics.active_threads,
                        "active_websockets": len(self.websocket_processor.active_connections),
                    }
                )

                # Alert on critical thresholds
                if metrics.memory_percent > 90:
                    logfire_logger.warning(
                        "Critical memory usage",
                        extra={"memory_percent": metrics.memory_percent}
                    )
                    # Force garbage collection
                    gc.collect()

                if metrics.cpu_percent > 95:
                    logfire_logger.warning(
                        "Critical CPU usage", extra={"cpu_percent": metrics.cpu_percent}
                    )

                # Check for memory leaks (too many threads)
                if metrics.active_threads > self.config.max_workers * 3:
                    logfire_logger.warning(
                        "High thread count detected",
                        extra={
                            "active_threads": metrics.active_threads,
                            "max_expected": self.config.max_workers * 3,
                        }
                    )

                await asyncio.sleep(self.config.health_check_interval)

            except Exception as e:
                logfire_logger.error("Health check failed", extra={"error": str(e)})
                await asyncio.sleep(self.config.health_check_interval)


# Global threading service instance
_threading_service: ThreadingService | None = None


def get_threading_service() -> ThreadingService:
    """Get the global threading service instance"""
    global _threading_service
    if _threading_service is None:
        _threading_service = ThreadingService()
    return _threading_service


async def start_threading_service() -> ThreadingService:
    """Start the global threading service"""
    service = get_threading_service()
    await service.start()
    return service


async def stop_threading_service():
    """Stop the global threading service"""
    global _threading_service
    if _threading_service:
        await _threading_service.stop()
        _threading_service = None
