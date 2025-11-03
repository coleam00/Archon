"""Agent CLI Executor

Executes Claude CLI commands for agent workflows.
"""

import asyncio
import json
import time
from pathlib import Path

from ..config import config
from ..models import CommandExecutionResult
from ..utils.structured_logger import get_logger

logger = get_logger(__name__)


class AgentCLIExecutor:
    """Executes Claude CLI commands"""

    def __init__(self, cli_path: str | None = None):
        self.cli_path = cli_path or config.CLAUDE_CLI_PATH
        self._logger = logger

    def build_command(
        self,
        command_file_path: str,
        args: list[str] | None = None,
        model: str | None = None,
    ) -> tuple[str, str]:
        """Build Claude CLI command

        Builds a Claude Code CLI command with all required flags for automated execution.
        The command uses stdin for prompt input and stream-json output format.

        Flags (per PRPs/ai_docs/cc_cli_ref.md):
        - --verbose: Required when using --print with --output-format=stream-json
        - --model: Claude model to use (sonnet, opus, haiku)
        - --max-turns: Optional limit for agent executions (None = unlimited)
        - --dangerously-skip-permissions: Enables non-interactive automation

        Args:
            command_file_path: Path to command file containing the prompt
            args: Optional arguments to append to prompt
            model: Model to use (default: from config)

        Returns:
            Tuple of (command string, prompt text for stdin)

        Raises:
            ValueError: If command file cannot be read
        """
        # Read command file content
        try:
            with open(command_file_path) as f:
                prompt_text = f.read()
        except Exception as e:
            raise ValueError(f"Failed to read command file {command_file_path}: {e}") from e

        # Replace argument placeholders in prompt text
        if args:
            # Replace $ARGUMENTS with first arg (or all args joined if multiple)
            prompt_text = prompt_text.replace("$ARGUMENTS", args[0] if len(args) == 1 else ", ".join(args))

            # Replace positional placeholders ($1, $2, $3, etc.)
            for i, arg in enumerate(args, start=1):
                prompt_text = prompt_text.replace(f"${i}", arg)

        # Build command with all required flags
        cmd_parts = [
            self.cli_path,
            "--print",
            "--output-format",
            "stream-json",
        ]

        # Add --verbose (required for stream-json with --print)
        if config.CLAUDE_CLI_VERBOSE:
            cmd_parts.append("--verbose")

        # Add --model (specify which Claude model to use)
        model_to_use = model or config.CLAUDE_CLI_MODEL
        cmd_parts.extend(["--model", model_to_use])

        # Add --max-turns only if configured (None = unlimited)
        if config.CLAUDE_CLI_MAX_TURNS is not None:
            cmd_parts.extend(["--max-turns", str(config.CLAUDE_CLI_MAX_TURNS)])

        # Add --dangerously-skip-permissions (automation)
        if config.CLAUDE_CLI_SKIP_PERMISSIONS:
            cmd_parts.append("--dangerously-skip-permissions")

        return " ".join(cmd_parts), prompt_text

    async def execute_async(
        self,
        command: str,
        working_directory: str,
        timeout_seconds: int | None = None,
        prompt_text: str | None = None,
        work_order_id: str | None = None,
    ) -> CommandExecutionResult:
        """Execute Claude CLI command asynchronously

        Args:
            command: Complete command to execute
            working_directory: Directory to execute in
            timeout_seconds: Optional timeout (defaults to config)
            prompt_text: Optional prompt text to pass via stdin
            work_order_id: Optional work order ID for logging artifacts

        Returns:
            CommandExecutionResult with execution details
        """
        timeout = timeout_seconds or config.EXECUTION_TIMEOUT
        self._logger.info(
            "agent_command_started",
            command=command,
            working_directory=working_directory,
            timeout=timeout,
            work_order_id=work_order_id,
        )

        # Save prompt if enabled and work_order_id provided
        if work_order_id and prompt_text:
            self._save_prompt(prompt_text, work_order_id)

        start_time = time.time()
        session_id: str | None = None

        try:
            process = await asyncio.create_subprocess_shell(
                command,
                cwd=working_directory,
                stdin=asyncio.subprocess.PIPE if prompt_text else None,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                # Pass prompt via stdin if provided
                stdin_data = prompt_text.encode() if prompt_text else None
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(input=stdin_data), timeout=timeout
                )
            except TimeoutError:
                process.kill()
                await process.wait()
                duration = time.time() - start_time
                self._logger.error(
                    "agent_command_timeout",
                    command=command,
                    timeout=timeout,
                    duration=duration,
                )
                return CommandExecutionResult(
                    success=False,
                    stdout=None,
                    stderr=None,
                    exit_code=-1,
                    error_message=f"Command timed out after {timeout}s",
                    duration_seconds=duration,
                )

            duration = time.time() - start_time

            # Decode output
            stdout_text = stdout.decode() if stdout else ""
            stderr_text = stderr.decode() if stderr else ""

            # Save output artifacts if enabled
            if work_order_id and stdout_text:
                self._save_output_artifacts(stdout_text, work_order_id)

            # Parse session ID and result message from JSONL output
            if stdout_text:
                session_id = self._extract_session_id(stdout_text)
                result_message = self._extract_result_message(stdout_text)
            else:
                result_message = None

            # Extract result text from JSONL result message
            result_text: str | None = None
            if result_message and "result" in result_message:
                result_value = result_message.get("result")
                # Convert result to string (handles both str and other types)
                result_text = str(result_value) if result_value is not None else None
            else:
                result_text = None

            # Determine success based on exit code AND result message
            success = process.returncode == 0
            error_message: str | None = None

            # Check for error_during_execution subtype (agent error without result)
            if result_message and result_message.get("subtype") == "error_during_execution":
                success = False
                error_message = "Error during execution: Agent encountered an error and did not return a result"
            elif result_message and result_message.get("is_error"):
                success = False
                error_message = str(result_message.get("result", "Unknown error"))
            elif not success:
                error_message = stderr_text if stderr_text else "Command failed"

            # Log extracted result text for debugging
            if result_text:
                self._logger.debug(
                    "result_text_extracted",
                    result_text_preview=result_text[:100] if len(result_text) > 100 else result_text,
                    work_order_id=work_order_id,
                )

            result = CommandExecutionResult(
                success=success,
                stdout=stdout_text,
                result_text=result_text,
                stderr=stderr_text,
                exit_code=process.returncode or 0,
                session_id=session_id,
                error_message=error_message,
                duration_seconds=duration,
            )

            if success:
                self._logger.info(
                    "agent_command_completed",
                    session_id=session_id,
                    duration=duration,
                    work_order_id=work_order_id,
                )
            else:
                self._logger.error(
                    "agent_command_failed",
                    exit_code=process.returncode,
                    duration=duration,
                    error=result.error_message,
                    work_order_id=work_order_id,
                )

            return result

        except Exception as e:
            duration = time.time() - start_time
            self._logger.error(
                "agent_command_error",
                command=command,
                error=str(e),
                duration=duration,
                exc_info=True,
            )
            return CommandExecutionResult(
                success=False,
                stdout=None,
                stderr=None,
                exit_code=-1,
                error_message=str(e),
                duration_seconds=duration,
            )

    def _save_prompt(self, prompt_text: str, work_order_id: str) -> Path | None:
        """Save prompt to file for debugging

        Args:
            prompt_text: The prompt text to save
            work_order_id: Work order ID for directory organization

        Returns:
            Path to saved file, or None if logging disabled
        """
        if not config.ENABLE_PROMPT_LOGGING:
            return None

        try:
            # Create directory: /tmp/agent-work-orders/{work_order_id}/prompts/
            prompt_dir = Path(config.TEMP_DIR_BASE) / work_order_id / "prompts"
            prompt_dir.mkdir(parents=True, exist_ok=True)

            # Save with timestamp
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            prompt_file = prompt_dir / f"prompt_{timestamp}.txt"

            with open(prompt_file, "w") as f:
                f.write(prompt_text)

            self._logger.info("prompt_saved", file_path=str(prompt_file))
            return prompt_file
        except Exception as e:
            self._logger.warning("prompt_save_failed", error=str(e))
            return None

    def _save_output_artifacts(self, jsonl_output: str, work_order_id: str) -> tuple[Path | None, Path | None]:
        """Save JSONL output and convert to JSON for easier consumption

        Args:
            jsonl_output: Raw JSONL output from Claude CLI
            work_order_id: Work order ID for directory organization

        Returns:
            Tuple of (jsonl_path, json_path) or (None, None) if disabled
        """
        if not config.ENABLE_OUTPUT_ARTIFACTS:
            return None, None

        try:
            # Create directory: /tmp/agent-work-orders/{work_order_id}/outputs/
            output_dir = Path(config.TEMP_DIR_BASE) / work_order_id / "outputs"
            output_dir.mkdir(parents=True, exist_ok=True)

            timestamp = time.strftime("%Y%m%d_%H%M%S")

            # Save JSONL
            jsonl_file = output_dir / f"output_{timestamp}.jsonl"
            with open(jsonl_file, "w") as f:
                f.write(jsonl_output)

            # Convert to JSON array
            json_file = output_dir / f"output_{timestamp}.json"
            try:
                messages = [json.loads(line) for line in jsonl_output.strip().split("\n") if line.strip()]
                with open(json_file, "w") as f:
                    json.dump(messages, f, indent=2)
            except Exception as e:
                self._logger.warning("jsonl_to_json_conversion_failed", error=str(e))
                json_file = None  # type: ignore[assignment]

            self._logger.info("output_artifacts_saved", jsonl=str(jsonl_file), json=str(json_file) if json_file else None)
            return jsonl_file, json_file
        except Exception as e:
            self._logger.warning("output_artifacts_save_failed", error=str(e))
            return None, None

    def _extract_session_id(self, jsonl_output: str) -> str | None:
        """Extract session ID from JSONL output

        Looks for session_id in JSON lines output from Claude CLI.

        Args:
            jsonl_output: JSONL output from Claude CLI

        Returns:
            Session ID if found, else None
        """
        try:
            lines = jsonl_output.strip().split("\n")
            for line in lines:
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                    if "session_id" in data:
                        session_id: str = data["session_id"]
                        return session_id
                except json.JSONDecodeError:
                    continue
        except Exception as e:
            self._logger.warning("session_id_extraction_failed", error=str(e))

        return None

    def _extract_result_message(self, jsonl_output: str) -> dict[str, object] | None:
        """Extract result message from JSONL output

        Looks for the final result message with error details.

        Args:
            jsonl_output: JSONL output from Claude CLI

        Returns:
            Result message dict if found, else None
        """
        try:
            lines = jsonl_output.strip().split("\n")
            # Result message should be last, but search from end to be safe
            for line in reversed(lines):
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                    if data.get("type") == "result":
                        return data  # type: ignore[no-any-return]
                except json.JSONDecodeError:
                    continue
        except Exception as e:
            self._logger.warning("result_message_extraction_failed", error=str(e))

        return None
