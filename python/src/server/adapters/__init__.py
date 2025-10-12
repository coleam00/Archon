"""
Adapters for external LLM providers that don't have OpenAI-compatible APIs.
"""

from .aws_bedrock_adapter import AWSBedrockClientAdapter

__all__ = ["AWSBedrockClientAdapter"]
