"""
AWS Bedrock Client Adapter

Provides an OpenAI-compatible interface for AWS Bedrock's Converse API.
This adapter wraps the boto3 bedrock-runtime client to work with our existing
LLM provider infrastructure.
"""

import asyncio
import json
from typing import Any

from ..config.logfire_config import get_logger

logger = get_logger(__name__)


class AWSBedrockClientAdapter:
    """
    Adapter to make AWS Bedrock Converse API compatible with OpenAI-style async clients.

    This adapter implements the minimum interface needed for our LLM operations,
    translating between OpenAI's chat completion format and AWS Bedrock's Converse API.
    """

    def __init__(self, bedrock_client: Any, region: str):
        """
        Initialize the AWS Bedrock adapter.

        Args:
            bedrock_client: boto3 bedrock-runtime client instance
            region: AWS region for the Bedrock service
        """
        self.bedrock_client = bedrock_client
        self.region = region
        self._executor = None  # Will be created on first use

    def _get_executor(self):
        """Get or create thread pool executor for async operations."""
        if self._executor is None:
            import concurrent.futures

            self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)
        return self._executor

    async def aclose(self):
        """Close the adapter and cleanup resources."""
        if self._executor is not None:
            self._executor.shutdown(wait=True)
            self._executor = None
        logger.debug("AWS Bedrock adapter closed")

    async def close(self):
        """Alias for aclose() for compatibility."""
        await self.aclose()

    @property
    def chat(self):
        """Return chat completions interface."""
        return self

    @property
    def completions(self):
        """Return completions interface."""
        return ChatCompletions(self)

    def _openai_to_bedrock_messages(self, openai_messages: list[dict]) -> list[dict]:
        """
        Convert OpenAI message format to Bedrock Converse API format.

        OpenAI format:
        [{"role": "system", "content": "..."},
         {"role": "user", "content": "..."},
         {"role": "assistant", "content": "..."}]

        Bedrock format:
        [{"role": "user", "content": [{"text": "..."}]},
         {"role": "assistant", "content": [{"text": "..."}]}]

        Note: Bedrock handles system prompts separately, not in messages.
        """
        bedrock_messages = []
        system_prompt = None

        for msg in openai_messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            if role == "system":
                # Bedrock handles system prompts separately
                system_prompt = content
                continue

            # Convert role (Bedrock uses "user" and "assistant")
            bedrock_role = "assistant" if role == "assistant" else "user"

            # Convert content to Bedrock format
            if isinstance(content, str):
                bedrock_content = [{"text": content}]
            elif isinstance(content, list):
                # Handle multimodal content if needed
                bedrock_content = []
                for item in content:
                    if isinstance(item, dict):
                        if item.get("type") == "text":
                            bedrock_content.append({"text": item.get("text", "")})
                        # Add support for images if needed in future
                    elif isinstance(item, str):
                        bedrock_content.append({"text": item})
            else:
                bedrock_content = [{"text": str(content)}]

            bedrock_messages.append({"role": bedrock_role, "content": bedrock_content})

        return bedrock_messages, system_prompt

    def _bedrock_to_openai_response(self, bedrock_response: dict, model: str) -> dict:
        """
        Convert Bedrock Converse API response to OpenAI format.

        Bedrock response:
        {
            "output": {
                "message": {
                    "role": "assistant",
                    "content": [{"text": "..."}]
                }
            },
            "stopReason": "end_turn",
            "usage": {
                "inputTokens": 10,
                "outputTokens": 20,
                "totalTokens": 30
            }
        }

        OpenAI format:
        {
            "id": "chatcmpl-xxx",
            "object": "chat.completion",
            "created": 1234567890,
            "model": "model-name",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "..."
                },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 20,
                "total_tokens": 30
            }
        }
        """
        import time
        import uuid

        # Extract message content
        output_message = bedrock_response.get("output", {}).get("message", {})
        content_blocks = output_message.get("content", [])

        # Combine text blocks
        content = " ".join(
            block.get("text", "") for block in content_blocks if "text" in block
        )

        # Map stop reason
        stop_reason_map = {
            "end_turn": "stop",
            "max_tokens": "length",
            "stop_sequence": "stop",
            "content_filtered": "content_filter",
        }
        finish_reason = stop_reason_map.get(
            bedrock_response.get("stopReason", "end_turn"), "stop"
        )

        # Extract usage
        bedrock_usage = bedrock_response.get("usage", {})

        return {
            "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": finish_reason,
                }
            ],
            "usage": {
                "prompt_tokens": bedrock_usage.get("inputTokens", 0),
                "completion_tokens": bedrock_usage.get("outputTokens", 0),
                "total_tokens": bedrock_usage.get("totalTokens", 0),
            },
        }

    async def create(
        self,
        model: str,
        messages: list[dict],
        temperature: float = 1.0,
        max_tokens: int | None = None,
        max_completion_tokens: int | None = None,
        stream: bool = False,
        **kwargs: Any,
    ) -> dict:
        """
        Create a chat completion using AWS Bedrock Converse API.

        Args:
            model: Bedrock model ID (e.g., "anthropic.claude-3-sonnet-20240229-v1:0")
            messages: List of messages in OpenAI format
            temperature: Sampling temperature (0.0 to 1.0)
            max_tokens: Maximum tokens to generate (OpenAI style)
            max_completion_tokens: Maximum tokens to generate (new OpenAI style)
            stream: Whether to stream the response (not supported yet)
            **kwargs: Additional parameters

        Returns:
            Chat completion response in OpenAI format
        """
        if stream:
            raise NotImplementedError(
                "Streaming is not yet supported for AWS Bedrock adapter"
            )

        # Convert messages to Bedrock format
        bedrock_messages, system_prompt = self._openai_to_bedrock_messages(messages)

        # Determine max tokens (prefer max_completion_tokens if provided)
        max_tokens_value = max_completion_tokens or max_tokens or 2048

        # Build inference configuration
        inference_config = {
            "temperature": temperature,
            "maxTokens": max_tokens_value,
        }

        # Add top_p if provided
        if "top_p" in kwargs:
            inference_config["topP"] = kwargs["top_p"]

        # Build converse request
        converse_params = {
            "modelId": model,
            "messages": bedrock_messages,
            "inferenceConfig": inference_config,
        }

        # Add system prompt if present
        if system_prompt:
            converse_params["system"] = [{"text": system_prompt}]

        try:
            # Call Bedrock Converse API asynchronously
            loop = asyncio.get_event_loop()
            executor = self._get_executor()

            bedrock_response = await loop.run_in_executor(
                executor, lambda: self.bedrock_client.converse(**converse_params)
            )

            # Convert response to OpenAI format
            openai_response = self._bedrock_to_openai_response(bedrock_response, model)

            logger.debug(
                f"AWS Bedrock completion successful. Tokens used: {openai_response['usage']['total_tokens']}"
            )

            return openai_response

        except Exception as e:
            logger.error(f"Error calling AWS Bedrock Converse API: {e}")
            raise


class ChatCompletions:
    """Chat completions interface wrapper."""

    def __init__(self, adapter: AWSBedrockClientAdapter):
        self.adapter = adapter

    async def create(self, *args, **kwargs):
        """Create a chat completion."""
        return await self.adapter.create(*args, **kwargs)


# Bedrock embedding adapter for future use
class AWSBedrockEmbeddingAdapter:
    """
    Adapter for AWS Bedrock embeddings.

    AWS Bedrock supports embedding models like Amazon Titan Embeddings.
    This adapter will be used by the embedding service.
    """

    def __init__(self, bedrock_client: Any, region: str):
        """
        Initialize the AWS Bedrock embedding adapter.

        Args:
            bedrock_client: boto3 bedrock-runtime client instance
            region: AWS region for the Bedrock service
        """
        self.bedrock_client = bedrock_client
        self.region = region
        self._executor = None

    def _get_executor(self):
        """Get or create thread pool executor for async operations."""
        if self._executor is None:
            import concurrent.futures

            self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)
        return self._executor

    async def aclose(self):
        """Close the adapter and cleanup resources."""
        if self._executor is not None:
            self._executor.shutdown(wait=True)
            self._executor = None
        logger.debug("AWS Bedrock embedding adapter closed")

    async def generate_embeddings(
        self, texts: list[str], model: str = "amazon.titan-embed-text-v1"
    ) -> list[list[float]]:
        """
        Generate embeddings using AWS Bedrock.

        Args:
            texts: List of text strings to embed
            model: Bedrock embedding model ID

        Returns:
            List of embedding vectors
        """
        embeddings = []

        try:
            loop = asyncio.get_event_loop()
            executor = self._get_executor()

            for text in texts:
                # Prepare request body for Titan Embeddings
                request_body = json.dumps({"inputText": text})

                # Call invoke_model asynchronously (bind request_body in lambda)
                response = await loop.run_in_executor(
                    executor,
                    lambda body=request_body: self.bedrock_client.invoke_model(
                        modelId=model,
                        contentType="application/json",
                        accept="application/json",
                        body=body,
                    ),
                )

                # Parse response
                response_body = json.loads(response["body"].read())
                embedding = response_body.get("embedding", [])
                embeddings.append(embedding)

            logger.debug(f"Generated {len(embeddings)} embeddings using AWS Bedrock")
            return embeddings

        except Exception as e:
            logger.error(f"Error generating embeddings with AWS Bedrock: {e}")
            raise
