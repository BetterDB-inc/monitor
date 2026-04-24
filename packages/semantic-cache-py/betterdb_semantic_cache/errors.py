from __future__ import annotations


class SemanticCacheUsageError(Exception):
    """Thrown when the caller does something wrong — e.g. calling check() before
    initialize(), or providing an embedding with the wrong dimension.
    The message is always actionable: it tells the caller what to fix.
    """


class EmbeddingError(Exception):
    """Thrown when the embedding function fails.
    Check the underlying cause for the original error from the embedding provider.
    """

    def __init__(self, message: str, cause: BaseException | None = None) -> None:
        super().__init__(message)
        self.cause = cause


class ValkeyCommandError(Exception):
    """Thrown when a Valkey command fails unexpectedly.
    Includes the command name and the underlying error.
    """

    def __init__(self, command: str, cause: BaseException | Exception | None = None) -> None:
        cause_msg = str(cause) if cause is not None else ""
        super().__init__(f"Valkey command '{command}' failed: {cause_msg}")
        self.command = command
        self.cause = cause
