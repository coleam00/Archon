"""Tests for Agent Executor"""

import asyncio
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.agent_work_orders.agent_executor.agent_cli_executor import AgentCLIExecutor


def test_build_command():
    """Test building Claude CLI command with all flags"""
    executor = AgentCLIExecutor(cli_path="claude")

    # Create a temporary command file with placeholders
    with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
        f.write("Test command content with args: $1 and $2")
        command_file_path = f.name

    try:
        command, prompt_text = executor.build_command(
            command_file_path=command_file_path,
            args=["issue-42", "wo-test123"],
            model="sonnet",
        )

        # Verify command includes required flags
        assert "claude" in command
        assert "--print" in command
        assert "--output-format" in command
        assert "stream-json" in command
        assert "--verbose" in command  # Required for stream-json with --print
        assert "--model" in command  # Model specification
        assert "sonnet" in command  # Model value
        assert "--dangerously-skip-permissions" in command  # Automation
        # Note: --max-turns is optional (None by default = unlimited)

        # Verify prompt text includes command content and placeholder replacements
        assert "Test command content" in prompt_text
        assert "issue-42" in prompt_text
        assert "wo-test123" in prompt_text
        assert "$1" not in prompt_text  # Placeholders should be replaced
        assert "$2" not in prompt_text
    finally:
        Path(command_file_path).unlink()


def test_build_command_no_args():
    """Test building command without arguments"""
    executor = AgentCLIExecutor()

    # Create a temporary command file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
        f.write("Command without args")
        command_file_path = f.name

    try:
        command, prompt_text = executor.build_command(
            command_file_path=command_file_path,
            model="opus",
        )

        assert "claude" in command
        assert "--verbose" in command
        assert "--model" in command
        assert "opus" in command
        assert "Command without args" in prompt_text
        # Note: --max-turns is optional (None by default = unlimited)
    finally:
        Path(command_file_path).unlink()


def test_build_command_with_custom_max_turns():
    """Test building command with custom max-turns configuration"""
    with patch("src.agent_work_orders.agent_executor.agent_cli_executor.config") as mock_config:
        mock_config.CLAUDE_CLI_PATH = "claude"
        mock_config.CLAUDE_CLI_VERBOSE = True
        mock_config.CLAUDE_CLI_MAX_TURNS = 50
        mock_config.CLAUDE_CLI_SKIP_PERMISSIONS = True

        executor = AgentCLIExecutor()

        with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
            f.write("Test content")
            command_file_path = f.name

        try:
            command, _ = executor.build_command(
                command_file_path=command_file_path,
                model="sonnet",
            )

            assert "--max-turns 50" in command
        finally:
            Path(command_file_path).unlink()


def test_build_command_missing_file():
    """Test building command with non-existent file"""
    executor = AgentCLIExecutor()

    with pytest.raises(ValueError, match="Failed to read command file"):
        executor.build_command(
            command_file_path="/nonexistent/path/to/command.md",
            model="sonnet",
        )


@pytest.mark.asyncio
async def test_execute_async_success():
    """Test successful command execution with prompt via stdin"""
    executor = AgentCLIExecutor()

    # Mock subprocess
    mock_process = MagicMock()
    mock_process.returncode = 0
    mock_process.communicate = AsyncMock(
        return_value=(
            b'{"session_id": "session-123", "type": "init"}\n{"type": "result"}',
            b"",
        )
    )

    with patch("asyncio.create_subprocess_shell", return_value=mock_process):
        result = await executor.execute_async(
            command="claude --print --output-format stream-json --verbose --max-turns 20 --dangerously-skip-permissions",
            working_directory="/tmp",
            timeout_seconds=30,
            prompt_text="Test prompt content",
        )

    assert result.success is True
    assert result.exit_code == 0
    assert result.session_id == "session-123"
    assert result.stdout is not None


@pytest.mark.asyncio
async def test_execute_async_failure():
    """Test failed command execution"""
    executor = AgentCLIExecutor()

    # Mock subprocess
    mock_process = MagicMock()
    mock_process.returncode = 1
    mock_process.communicate = AsyncMock(
        return_value=(b"", b"Error: Command failed")
    )

    with patch("asyncio.create_subprocess_shell", return_value=mock_process):
        result = await executor.execute_async(
            command="claude --print --output-format stream-json --verbose",
            working_directory="/tmp",
            prompt_text="Test prompt",
        )

    assert result.success is False
    assert result.exit_code == 1
    assert result.error_message is not None


@pytest.mark.asyncio
async def test_execute_async_timeout():
    """Test command execution timeout"""
    executor = AgentCLIExecutor()

    # Mock subprocess that times out
    mock_process = MagicMock()
    mock_process.kill = MagicMock()
    mock_process.wait = AsyncMock()

    async def mock_communicate(input=None):
        await asyncio.sleep(10)  # Longer than timeout
        return (b"", b"")

    mock_process.communicate = mock_communicate

    with patch("asyncio.create_subprocess_shell", return_value=mock_process):
        result = await executor.execute_async(
            command="claude --print --output-format stream-json --verbose",
            working_directory="/tmp",
            timeout_seconds=0.1,  # Very short timeout
            prompt_text="Test prompt",
        )

    assert result.success is False
    assert result.exit_code == -1
    assert "timed out" in result.error_message.lower()


def test_extract_session_id():
    """Test extracting session ID from JSONL output"""
    executor = AgentCLIExecutor()

    jsonl_output = """
{"type": "init", "session_id": "session-abc123"}
{"type": "message", "content": "Hello"}
{"type": "result"}
"""

    session_id = executor._extract_session_id(jsonl_output)
    assert session_id == "session-abc123"


def test_extract_session_id_not_found():
    """Test extracting session ID when not present"""
    executor = AgentCLIExecutor()

    jsonl_output = """
{"type": "message", "content": "Hello"}
{"type": "result"}
"""

    session_id = executor._extract_session_id(jsonl_output)
    assert session_id is None


def test_extract_session_id_invalid_json():
    """Test extracting session ID with invalid JSON"""
    executor = AgentCLIExecutor()

    jsonl_output = "Not valid JSON"

    session_id = executor._extract_session_id(jsonl_output)
    assert session_id is None


@pytest.mark.asyncio
async def test_execute_async_extracts_result_text():
    """Test that result text is extracted from JSONL output"""
    executor = AgentCLIExecutor()

    # Mock subprocess that returns JSONL with result
    jsonl_output = '{"type":"session_started","session_id":"test-123"}\n{"type":"result","result":"/feature","is_error":false}'

    with patch("asyncio.create_subprocess_shell") as mock_subprocess:
        mock_process = AsyncMock()
        mock_process.communicate = AsyncMock(return_value=(jsonl_output.encode(), b""))
        mock_process.returncode = 0
        mock_subprocess.return_value = mock_process

        result = await executor.execute_async(
            "claude --print",
            "/tmp/test",
            prompt_text="test prompt",
            work_order_id="wo-test",
        )

        assert result.success is True
        assert result.result_text == "/feature"
        assert result.session_id == "test-123"
        assert '{"type":"result"' in result.stdout


def test_build_command_replaces_arguments_placeholder():
    """Test that $ARGUMENTS placeholder is replaced with actual arguments"""
    executor = AgentCLIExecutor()

    # Create temp command file with $ARGUMENTS
    import os
    import tempfile

    with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
        f.write("Classify this issue:\n\n$ARGUMENTS")
        temp_file = f.name

    try:
        command, prompt = executor.build_command(
            temp_file, args=['{"title": "Add feature", "body": "description"}']
        )

        assert "$ARGUMENTS" not in prompt
        assert '{"title": "Add feature"' in prompt
        assert "Classify this issue:" in prompt
    finally:
        os.unlink(temp_file)


def test_build_command_replaces_positional_arguments():
    """Test that $1, $2, $3 are replaced with positional arguments"""
    executor = AgentCLIExecutor()

    import os
    import tempfile

    with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
        f.write("Issue: $1\nWorkOrder: $2\nData: $3")
        temp_file = f.name

    try:
        command, prompt = executor.build_command(
            temp_file, args=["42", "wo-test", '{"title":"Test"}']
        )

        assert "$1" not in prompt
        assert "$2" not in prompt
        assert "$3" not in prompt
        assert "Issue: 42" in prompt
        assert "WorkOrder: wo-test" in prompt
        assert 'Data: {"title":"Test"}' in prompt
    finally:
        os.unlink(temp_file)
