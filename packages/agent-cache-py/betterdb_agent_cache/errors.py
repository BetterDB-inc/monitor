class AgentCacheError(Exception):
    """Base class for all agent cache errors."""


class AgentCacheUsageError(AgentCacheError):
    """Raised for API misuse (e.g. invalid arguments)."""


class ValkeyCommandError(AgentCacheError):
    """Raised when a Valkey command fails."""

    def __init__(self, command: str, cause: Exception) -> None:
        super().__init__(f"Valkey command failed: {command} - {cause}")
        self.command = command
        self.__cause__ = cause
