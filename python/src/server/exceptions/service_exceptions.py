"""
Vector Database Service Exceptions

This is a minimal implementation to support the foundation abstractions.
Full exception hierarchy will be added in subsequent PRs.
"""


class CredentialError(Exception):
    """
    Credential-related errors.

    Minimal implementation for foundation abstractions.
    """

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message

