"""Claude Command Loader

Loads command files from .claude/commands directory.
"""

from pathlib import Path

from ..config import config
from ..models import CommandNotFoundError
from ..utils.structured_logger import get_logger

logger = get_logger(__name__)


class ClaudeCommandLoader:
    """Loads Claude command files"""

    def __init__(self, commands_directory: str | None = None):
        self.commands_directory = Path(commands_directory or config.COMMANDS_DIRECTORY)
        self._logger = logger.bind(commands_directory=str(self.commands_directory))

    def load_command(self, command_name: str) -> str:
        """Load command file content

        Args:
            command_name: Command name (e.g., 'agent_workflow_plan')
                         Will load {command_name}.md

        Returns:
            Path to the command file

        Raises:
            CommandNotFoundError: If command file not found
        """
        file_path = self.commands_directory / f"{command_name}.md"

        self._logger.info("command_load_started", command_name=command_name, file_path=str(file_path))

        if not file_path.exists():
            self._logger.error("command_not_found", command_name=command_name, file_path=str(file_path))
            raise CommandNotFoundError(
                f"Command file not found: {file_path}. "
                f"Please create it at {file_path}"
            )

        self._logger.info("command_load_completed", command_name=command_name)
        return str(file_path)

    def list_available_commands(self) -> list[str]:
        """List all available command files

        Returns:
            List of command names (without .md extension)
        """
        if not self.commands_directory.exists():
            self._logger.warning("commands_directory_not_found")
            return []

        commands = []
        for file_path in self.commands_directory.glob("*.md"):
            commands.append(file_path.stem)

        self._logger.info("commands_listed", count=len(commands), commands=commands)
        return commands
