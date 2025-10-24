"""Tests for Sandbox Manager"""

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.agent_work_orders.models import SandboxSetupError, SandboxType
from src.agent_work_orders.sandbox_manager.git_branch_sandbox import GitBranchSandbox
from src.agent_work_orders.sandbox_manager.sandbox_factory import SandboxFactory


@pytest.mark.asyncio
async def test_git_branch_sandbox_setup_success():
    """Test successful sandbox setup"""
    sandbox = GitBranchSandbox(
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-test",
    )

    # Mock subprocess
    mock_process = MagicMock()
    mock_process.returncode = 0
    mock_process.communicate = AsyncMock(return_value=(b"Cloning...", b""))

    with patch("asyncio.create_subprocess_exec", return_value=mock_process):
        await sandbox.setup()

    assert Path(sandbox.working_dir).name == "sandbox-test"


@pytest.mark.asyncio
async def test_git_branch_sandbox_setup_failure():
    """Test failed sandbox setup"""
    sandbox = GitBranchSandbox(
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-test",
    )

    # Mock subprocess failure
    mock_process = MagicMock()
    mock_process.returncode = 1
    mock_process.communicate = AsyncMock(return_value=(b"", b"Error: Repository not found"))

    with patch("asyncio.create_subprocess_exec", return_value=mock_process):
        with pytest.raises(SandboxSetupError) as exc_info:
            await sandbox.setup()

        assert "Failed to clone repository" in str(exc_info.value)


@pytest.mark.asyncio
async def test_git_branch_sandbox_execute_command_success():
    """Test successful command execution in sandbox"""
    with TemporaryDirectory() as tmpdir:
        sandbox = GitBranchSandbox(
            repository_url="https://github.com/owner/repo",
            sandbox_identifier="sandbox-test",
        )
        sandbox.working_dir = tmpdir

        # Mock subprocess
        mock_process = MagicMock()
        mock_process.returncode = 0
        mock_process.communicate = AsyncMock(return_value=(b"Command output", b""))

        with patch("asyncio.create_subprocess_shell", return_value=mock_process):
            result = await sandbox.execute_command("echo 'test'", timeout=10)

        assert result.success is True
        assert result.exit_code == 0
        assert result.stdout == "Command output"


@pytest.mark.asyncio
async def test_git_branch_sandbox_execute_command_failure():
    """Test failed command execution in sandbox"""
    with TemporaryDirectory() as tmpdir:
        sandbox = GitBranchSandbox(
            repository_url="https://github.com/owner/repo",
            sandbox_identifier="sandbox-test",
        )
        sandbox.working_dir = tmpdir

        # Mock subprocess failure
        mock_process = MagicMock()
        mock_process.returncode = 1
        mock_process.communicate = AsyncMock(return_value=(b"", b"Command failed"))

        with patch("asyncio.create_subprocess_shell", return_value=mock_process):
            result = await sandbox.execute_command("false", timeout=10)

        assert result.success is False
        assert result.exit_code == 1
        assert result.error_message is not None


@pytest.mark.asyncio
async def test_git_branch_sandbox_execute_command_timeout():
    """Test command execution timeout in sandbox"""
    import asyncio

    with TemporaryDirectory() as tmpdir:
        sandbox = GitBranchSandbox(
            repository_url="https://github.com/owner/repo",
            sandbox_identifier="sandbox-test",
        )
        sandbox.working_dir = tmpdir

        # Mock subprocess that times out
        mock_process = MagicMock()
        mock_process.kill = MagicMock()
        mock_process.wait = AsyncMock()

        async def mock_communicate():
            await asyncio.sleep(10)
            return (b"", b"")

        mock_process.communicate = mock_communicate

        with patch("asyncio.create_subprocess_shell", return_value=mock_process):
            result = await sandbox.execute_command("sleep 100", timeout=0.1)

        assert result.success is False
        assert result.exit_code == -1
        assert "timed out" in result.error_message.lower()


@pytest.mark.asyncio
async def test_git_branch_sandbox_get_git_branch_name():
    """Test getting current git branch name"""
    with TemporaryDirectory() as tmpdir:
        sandbox = GitBranchSandbox(
            repository_url="https://github.com/owner/repo",
            sandbox_identifier="sandbox-test",
        )
        sandbox.working_dir = tmpdir

        with patch(
            "src.agent_work_orders.sandbox_manager.git_branch_sandbox.get_current_branch",
            new=AsyncMock(return_value="feat-wo-test123"),
        ):
            branch = await sandbox.get_git_branch_name()

        assert branch == "feat-wo-test123"


@pytest.mark.asyncio
async def test_git_branch_sandbox_cleanup():
    """Test sandbox cleanup"""
    with TemporaryDirectory() as tmpdir:
        test_dir = Path(tmpdir) / "sandbox-test"
        test_dir.mkdir()
        (test_dir / "test.txt").write_text("test")

        sandbox = GitBranchSandbox(
            repository_url="https://github.com/owner/repo",
            sandbox_identifier="sandbox-test",
        )
        sandbox.working_dir = str(test_dir)

        await sandbox.cleanup()

        assert not test_dir.exists()


def test_sandbox_factory_git_branch():
    """Test creating git branch sandbox via factory"""
    factory = SandboxFactory()

    sandbox = factory.create_sandbox(
        sandbox_type=SandboxType.GIT_BRANCH,
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-test",
    )

    assert isinstance(sandbox, GitBranchSandbox)
    assert sandbox.repository_url == "https://github.com/owner/repo"
    assert sandbox.sandbox_identifier == "sandbox-test"


def test_sandbox_factory_not_implemented():
    """Test creating unsupported sandbox types"""
    factory = SandboxFactory()

    with pytest.raises(NotImplementedError):
        factory.create_sandbox(
            sandbox_type=SandboxType.E2B,
            repository_url="https://github.com/owner/repo",
            sandbox_identifier="sandbox-test",
        )

    with pytest.raises(NotImplementedError):
        factory.create_sandbox(
            sandbox_type=SandboxType.DAGGER,
            repository_url="https://github.com/owner/repo",
            sandbox_identifier="sandbox-test",
        )
