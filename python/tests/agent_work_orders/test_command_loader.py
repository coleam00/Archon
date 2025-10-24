"""Tests for Command Loader"""

from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from src.agent_work_orders.command_loader.claude_command_loader import (
    ClaudeCommandLoader,
)
from src.agent_work_orders.models import CommandNotFoundError


def test_load_command_success():
    """Test loading an existing command file"""
    with TemporaryDirectory() as tmpdir:
        # Create a test command file
        commands_dir = Path(tmpdir) / "commands"
        commands_dir.mkdir()
        command_file = commands_dir / "agent_workflow_plan.md"
        command_file.write_text("# Test Command\n\nThis is a test command.")

        loader = ClaudeCommandLoader(str(commands_dir))
        command_path = loader.load_command("agent_workflow_plan")

        assert command_path == str(command_file)
        assert Path(command_path).exists()


def test_load_command_not_found():
    """Test loading a non-existent command file"""
    with TemporaryDirectory() as tmpdir:
        commands_dir = Path(tmpdir) / "commands"
        commands_dir.mkdir()

        loader = ClaudeCommandLoader(str(commands_dir))

        with pytest.raises(CommandNotFoundError) as exc_info:
            loader.load_command("nonexistent_command")

        assert "Command file not found" in str(exc_info.value)


def test_list_available_commands():
    """Test listing all available commands"""
    with TemporaryDirectory() as tmpdir:
        commands_dir = Path(tmpdir) / "commands"
        commands_dir.mkdir()

        # Create multiple command files
        (commands_dir / "agent_workflow_plan.md").write_text("Command 1")
        (commands_dir / "agent_workflow_build.md").write_text("Command 2")
        (commands_dir / "agent_workflow_test.md").write_text("Command 3")

        loader = ClaudeCommandLoader(str(commands_dir))
        commands = loader.list_available_commands()

        assert len(commands) == 3
        assert "agent_workflow_plan" in commands
        assert "agent_workflow_build" in commands
        assert "agent_workflow_test" in commands


def test_list_available_commands_empty_directory():
    """Test listing commands when directory is empty"""
    with TemporaryDirectory() as tmpdir:
        commands_dir = Path(tmpdir) / "commands"
        commands_dir.mkdir()

        loader = ClaudeCommandLoader(str(commands_dir))
        commands = loader.list_available_commands()

        assert len(commands) == 0


def test_list_available_commands_nonexistent_directory():
    """Test listing commands when directory doesn't exist"""
    with TemporaryDirectory() as tmpdir:
        nonexistent_dir = Path(tmpdir) / "nonexistent"

        loader = ClaudeCommandLoader(str(nonexistent_dir))
        commands = loader.list_available_commands()

        assert len(commands) == 0
