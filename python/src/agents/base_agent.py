"""
Base Agent class for all PydanticAI agents in the Archon system.

This provides common functionality and dependency injection for all agents.
"""

import asyncio
import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from pydantic import BaseModel
from pydantic_ai import Agent

logger = logging.getLogger(__name__)


@dataclass
class ArchonDependencies:
    """Base dependencies for all Archon agents."""

    request_id: str | None = None
    user_id: str | None = None
    trace_id: str | None = None


# Type variables for generic agent typing
DepsT = TypeVar("DepsT", bound=ArchonDependencies)
OutputT = TypeVar("OutputT")


class BaseAgentOutput(BaseModel):
    """Base output model for all agent responses."""

    success: bool
    message: str
    data: dict[str, Any] | None = None
    errors: list[str] | None = None


class RateLimitHandler:
    """Handles OpenAI rate limiting with exponential backoff."""

    def __init__(self, max_retries: int = 5, base_delay: float = 1.0):
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.last_request_time = 0
        self.min_request_interval = 0.1  # Minimum 100ms between requests

    async def execute_with_rate_limit(self, func, *args, progress_callback=None, **kwargs):
        """Execute a function with rate limiting protection."""
        retries = 0

        while retries <= self.max_retries:
            try:
                # Ensure minimum interval between requests
                current_time = time.time()
                time_since_last = current_time - self.last_request_time
                if time_since_last < self.min_request_interval:
                    await asyncio.sleep(self.min_request_interval - time_since_last)

                self.last_request_time = time.time()
                return await func(*args, **kwargs)

            except Exception as e:
                error_str = str(e).lower()
                full_error = str(e)

                logger.debug(f"Agent error caught: {full_error}")
                logger.debug(f"Error type: {type(e).__name__}")
                logger.debug(f"Error class: {e.__class__.__module__}.{e.__class__.__name__}")

                # Check for different types of rate limits
                is_rate_limit = (
                    "rate limit" in error_str
                    or "429" in error_str
                    or "request_limit" in error_str  # New: catch PydanticAI limits
                    or "exceed" in error_str
                )

                if is_rate_limit:
                    retries += 1
                    if retries > self.max_retries:
                        logger.debug(f"Max retries exceeded for rate limit: {full_error}")
                        if progress_callback:
                            await progress_callback({
                                "step": "ai_generation",
                                "log": f"❌ Rate limit exceeded after {self.max_retries} retries",
                            })
                        raise Exception(
                            f"Rate limit exceeded after {self.max_retries} retries: {full_error}"
                        )

                    # Extract wait time from error message if available
                    wait_time = self._extract_wait_time(full_error)
                    if wait_time is None:
                        # Use exponential backoff
                        wait_time = self.base_delay * (2 ** (retries - 1))

                    logger.info(
                        f"Rate limit hit. Type: {type(e).__name__}, Waiting {wait_time:.2f}s before retry {retries}/{self.max_retries}"
                    )

                    # Send progress update if callback provided
                    if progress_callback:
                        await progress_callback({
                            "step": "ai_generation",
                            "log": f"⏱️ Rate limit hit. Waiting {wait_time:.0f}s before retry {retries}/{self.max_retries}",
                        })

                    await asyncio.sleep(wait_time)
                    continue
                else:
                    # Non-rate-limit error, re-raise immediately
                    logger.debug(f"Non-rate-limit error, re-raising: {full_error}")
                    if progress_callback:
                        await progress_callback({
                            "step": "ai_generation",
                            "log": f"❌ Error: {str(e)}",
                        })
                    raise

        raise Exception(f"Failed after {self.max_retries} retries")

    def _extract_wait_time(self, error_message: str) -> float | None:
        """Extract wait time from OpenAI error message."""
        try:
            # Look for patterns like "Please try again in 1.242s"
            import re

            match = re.search(r"try again in (\d+(?:\.\d+)?)s", error_message)
            if match:
                return float(match.group(1))
        except:
            pass
        return None


class BaseAgent(ABC, Generic[DepsT, OutputT]):
    """
    Base class for all PydanticAI agents in the Archon system.

    Provides common functionality like:
    - Error handling and retries
    - Rate limiting protection
    - Logging and monitoring
    - Standard dependency injection
    - Common tools and utilities
    """

    def __init__(
        self,
        model: str = "openai:gpt-4o",
        name: str = None,
        retries: int = 3,
        enable_rate_limiting: bool = True,
        **agent_kwargs,
    ):
        self.model = model
        self.name = name or self.__class__.__name__
        self.retries = retries
        self.enable_rate_limiting = enable_rate_limiting

        # Initialize rate limiting
        if self.enable_rate_limiting:
            self.rate_limiter = RateLimitHandler(max_retries=retries)
        else:
            self.rate_limiter = None

        # Initialize the PydanticAI agent
        self._agent = self._create_agent(**agent_kwargs)

        # Setup logging
        self.logger = logging.getLogger(f"agents.{self.name}")

    @abstractmethod
    def _create_agent(self, **kwargs) -> Agent:
        """Create and configure the PydanticAI agent. Must be implemented by subclasses."""
        pass

    @abstractmethod
    def get_system_prompt(self) -> str:
        """Get the system prompt for this agent. Must be implemented by subclasses."""
        pass

    async def run(self, user_prompt: str, deps: DepsT) -> OutputT:
        """
        Run the agent with rate limiting protection.

        Args:
            user_prompt: The user's input prompt
            deps: Dependencies for the agent

        Returns:
            The agent's structured output
        """
        if self.rate_limiter:
            # Extract progress callback from deps if available
            progress_callback = getattr(deps, "progress_callback", None)
            return await self.rate_limiter.execute_with_rate_limit(
                self._run_agent, user_prompt, deps, progress_callback=progress_callback
            )
        else:
            return await self._run_agent(user_prompt, deps)

    async def _run_agent(self, user_prompt: str, deps: DepsT) -> OutputT:
        """Internal method to run the agent."""
        try:
            # Add timeout to prevent hanging
            result = await asyncio.wait_for(
                self._agent.run(user_prompt, deps=deps),
                timeout=120.0,  # 2 minute timeout for agent operations
            )
            self.logger.info(f"Agent {self.name} completed successfully")
            # PydanticAI returns a RunResult with data attribute
            return result.data
        except asyncio.TimeoutError:
            self.logger.error(f"Agent {self.name} timed out after 120 seconds")
            raise Exception(f"Agent {self.name} operation timed out - taking too long to respond")
        except Exception as e:
            self.logger.error(f"Agent {self.name} failed: {str(e)}")
            raise

    def run_stream(self, user_prompt: str, deps: DepsT):
        """
        Run the agent with streaming output.

        Args:
            user_prompt: The user's input prompt
            deps: Dependencies for the agent

        Returns:
            Async context manager for streaming results
        """
        # Note: Rate limiting not supported for streaming to avoid complexity
        # The async context manager pattern doesn't work well with rate limiting
        self.logger.info(f"Starting streaming for agent {self.name}")
        # run_stream returns an async context manager directly, not a coroutine
        return self._agent.run_stream(user_prompt, deps=deps)

    def add_tool(self, func, **tool_kwargs):
        """
        Add a tool function to the agent.

        Args:
            func: The function to register as a tool
            **tool_kwargs: Additional arguments for the tool decorator
        """
        return self._agent.tool(**tool_kwargs)(func)

    def add_system_prompt_function(self, func):
        """
        Add a dynamic system prompt function to the agent.

        Args:
            func: The function to register as a system prompt
        """
        return self._agent.system_prompt(func)

    @property
    def agent(self) -> Agent:
        """Get the underlying PydanticAI agent instance."""
        return self._agent
