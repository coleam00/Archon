"""
Code Storage Service

Handles extraction and storage of code examples from documents.
"""

import asyncio
import json
import time
import os
import re
from collections import defaultdict, deque
from collections.abc import Callable
from difflib import SequenceMatcher
from typing import Any
from urllib.parse import urlparse

from supabase import Client

from ...config.logfire_config import search_logger
from ..embeddings.contextual_embedding_service import generate_contextual_embeddings_batch
from ..embeddings.embedding_service import create_embeddings_batch
from ..llm_provider_service import get_llm_client, prepare_chat_completion_params, requires_max_completion_tokens
from ..credential_service import credential_service


def _is_reasoning_model(model: str) -> bool:
    """
    Check if a model is a reasoning model that may return empty responses.

    Args:
        model: The model identifier

    Returns:
        True if the model is a reasoning model (GPT-5, o1, o3 series)
    """
    return requires_max_completion_tokens(model)


def _supports_response_format(provider: str, model: str) -> bool:
    """
    Determine if a specific provider/model combination supports response_format.

    Args:
        provider: The LLM provider name
        model: The model identifier

    Returns:
        True if the model supports structured JSON output via response_format
    """
    if not provider:
        return True  # Default to supporting it

    provider = provider.lower()

    if provider == "openai":
        return True  # OpenAI models generally support response_format
    elif provider == "openrouter":
        # OpenRouter: "OpenAI models, Nitro models, and some others" support it
        model_lower = model.lower()

        # Known compatible model patterns on OpenRouter
        compatible_patterns = [
            "openai/",      # OpenAI models on OpenRouter
            "gpt-",         # GPT models
            "nitro/",       # Nitro models
            "deepseek/",    # DeepSeek models often support JSON
            "google/",      # Some Google models support it
        ]

        for pattern in compatible_patterns:
            if pattern in model_lower:
                search_logger.debug(f"Model {model} supports response_format (pattern: {pattern})")
                return True

        search_logger.debug(f"Model {model} may not support response_format, skipping")
        return False
    else:
        # Conservative approach for other providers
        return False


async def _get_model_choice() -> str:
    """Get MODEL_CHOICE with provider-aware defaults from centralized service."""
    try:
        # Get the active provider configuration
        provider_config = await credential_service.get_active_provider("llm")
        active_provider = provider_config.get("provider", "openai")
        model = provider_config.get("chat_model")

        # If no custom model is set, use provider-specific defaults
        if not model or model.strip() == "":
            # Provider-specific defaults
            provider_defaults = {
                "openai": "gpt-4o-mini",
                "openrouter": "anthropic/claude-3.5-sonnet",
                "google": "gemini-1.5-flash",
                "ollama": "llama3.2:latest",
                "anthropic": "claude-3-5-haiku-20241022",
                "grok": "grok-3-mini"
            }
            model = provider_defaults.get(active_provider, "gpt-4o-mini")
            search_logger.debug(f"Using default model for provider {active_provider}: {model}")

        search_logger.debug(f"Using model for provider {active_provider}: {model}")
        return model
    except Exception as e:
        search_logger.warning(f"Error getting model choice: {e}, using default")
        return "gpt-4o-mini"


def _get_max_workers() -> int:
    """Get max workers from environment, defaulting to 3."""
    return int(os.getenv("CONTEXTUAL_EMBEDDINGS_MAX_WORKERS", "3"))


def _normalize_code_for_comparison(code: str) -> str:
    """
    Normalize code for similarity comparison by removing version-specific variations.

    Args:
        code: The code string to normalize

    Returns:
        Normalized code string for comparison
    """
    # Remove extra whitespace and normalize line endings
    normalized = re.sub(r"\s+", " ", code.strip())

    # Remove common version-specific imports that don't change functionality
    # Handle typing imports variations
    normalized = re.sub(r"from typing_extensions import", "from typing import", normalized)
    normalized = re.sub(r"from typing import Annotated[^,\n]*,?", "", normalized)
    normalized = re.sub(r"from typing_extensions import Annotated[^,\n]*,?", "", normalized)

    # Remove Annotated wrapper variations for comparison
    # This handles: Annotated[type, dependency] -> type
    normalized = re.sub(r"Annotated\[\s*([^,\]]+)[^]]*\]", r"\1", normalized)

    # Normalize common FastAPI parameter patterns
    normalized = re.sub(r":\s*Annotated\[[^\]]+\]\s*=", "=", normalized)

    # Remove trailing commas and normalize punctuation spacing
    normalized = re.sub(r",\s*\)", ")", normalized)
    normalized = re.sub(r",\s*]", "]", normalized)

    return normalized


def _calculate_code_similarity(code1: str, code2: str) -> float:
    """
    Calculate similarity between two code strings using normalized comparison.

    Args:
        code1: First code string
        code2: Second code string

    Returns:
        Similarity ratio between 0.0 and 1.0
    """
    # Normalize both code strings for comparison
    norm1 = _normalize_code_for_comparison(code1)
    norm2 = _normalize_code_for_comparison(code2)

    # Use difflib's SequenceMatcher for similarity calculation
    similarity = SequenceMatcher(None, norm1, norm2).ratio()

    return similarity


def _select_best_code_variant(similar_blocks: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Select the best variant from a list of similar code blocks.

    Criteria:
    1. Prefer blocks with more complete language specification
    2. Prefer longer, more comprehensive examples
    3. Prefer blocks with better context

    Args:
        similar_blocks: List of similar code block dictionaries

    Returns:
        The best code block variant
    """
    if len(similar_blocks) == 1:
        return similar_blocks[0]

    def score_block(block):
        score = 0

        # Prefer blocks with explicit language specification
        if block.get("language") and block["language"] not in ["", "text", "plaintext"]:
            score += 10

        # Prefer longer code (more comprehensive examples)
        score += len(block["code"]) * 0.01

        # Prefer blocks with better context
        context_before_len = len(block.get("context_before", ""))
        context_after_len = len(block.get("context_after", ""))
        score += (context_before_len + context_after_len) * 0.005

        # Slight preference for Python 3.10+ syntax (most modern)
        if "python 3.10" in block.get("full_context", "").lower():
            score += 5
        elif "annotated" in block.get("code", "").lower():
            score += 3

        return score

    # Sort by score and return the best one
    best_block = max(similar_blocks, key=score_block)

    # Add metadata about consolidated variants
    variant_count = len(similar_blocks)
    if variant_count > 1:
        languages = [block.get("language", "") for block in similar_blocks if block.get("language")]
        unique_languages = list(set(filter(None, languages)))

        # Add consolidated metadata
        best_block["consolidated_variants"] = variant_count
        if unique_languages:
            best_block["variant_languages"] = unique_languages

    return best_block


def _should_attempt_fallback(provider: str, model: str, is_reasoning: bool, error_context: dict) -> bool:
    """
    Determine if fallback should be attempted based on error type and configuration.

    Args:
        provider: The LLM provider name
        model: The model identifier
        is_reasoning: Whether this is a reasoning model
        error_context: Context about the error that occurred

    Returns:
        True if fallback should be attempted
    """
    # Check for environment variable to disable fallbacks (fail-fast mode)
    if os.getenv("DISABLE_LLM_FALLBACKS", "false").lower() == "true":
        search_logger.debug("LLM fallbacks disabled by DISABLE_LLM_FALLBACKS environment variable")
        return False

    # Only attempt fallback for specific provider/model combinations
    fallback_eligible_providers = ["grok", "openai"]  # Providers that support fallback

    if provider not in fallback_eligible_providers:
        search_logger.debug(f"Provider {provider} not eligible for fallback")
        return False

    # Only allow fallback for empty responses, not other error types
    if error_context.get("response_type") != "empty_content":
        search_logger.debug(f"Error type {error_context.get('response_type')} not eligible for fallback")
        return False

    # Allow fallback for Grok and reasoning models that commonly have empty responses
    if provider == "grok" or is_reasoning:
        search_logger.debug(f"Fallback enabled for {provider}/{model} (reasoning: {is_reasoning})")
        return True

    return False


async def _attempt_single_fallback(
    original_model: str,
    original_provider: str,
    is_reasoning: bool,
    original_params: dict,
    error_context: dict
) -> str | None:
    """
    Attempt a single fallback to gpt-4o-mini with structured tracking.

    Args:
        original_model: The original model that failed
        original_provider: The original provider that failed
        is_reasoning: Whether original was a reasoning model
        original_params: The original request parameters
        error_context: Context about the original error

    Returns:
        Response content if fallback succeeded, None if failed
    """
    fallback_start_time = time.time()

    # Always fallback to reliable gpt-4o-mini
    fallback_model = "gpt-4o-mini"
    fallback_provider = "openai"

    fallback_context = {
        "original_model": original_model,
        "original_provider": original_provider,
        "fallback_model": fallback_model,
        "fallback_provider": fallback_provider,
        "original_error": error_context,
        "fallback_attempt_time": time.time()
    }

    search_logger.info(f"Attempting single fallback: {original_model} → {fallback_model}")

    try:
        # Prepare fallback parameters (simplified, no JSON format to avoid issues)
        fallback_params = {
            "model": fallback_model,
            "messages": original_params["messages"],
            "max_tokens": min(original_params.get("max_tokens", 500), 500),  # Cap for reliability
            "temperature": original_params.get("temperature", 0.3)
        }

        # No response_format for fallback to maximize reliability
        if "response_format" in fallback_params:
            del fallback_params["response_format"]

        async with get_llm_client(provider=fallback_provider) as fallback_client:
            fallback_response = await fallback_client.chat.completions.create(**fallback_params)
            fallback_content = fallback_response.choices[0].message.content

            if fallback_content and fallback_content.strip():
                fallback_time = time.time() - fallback_start_time
                fallback_success = {
                    **fallback_context,
                    "fallback_succeeded": True,
                    "fallback_time": f"{fallback_time:.2f}s",
                    "fallback_content_length": len(fallback_content.strip())
                }
                search_logger.info(f"Fallback success: {fallback_success}")
                return fallback_content.strip()
            else:
                # Fallback returned empty - log and return None
                fallback_failure = {
                    **fallback_context,
                    "fallback_succeeded": False,
                    "fallback_error": "empty_response"
                }
                search_logger.error(f"Fallback returned empty response: {fallback_failure}")
                return None

    except Exception as e:
        fallback_time = time.time() - fallback_start_time
        fallback_error = {
            **fallback_context,
            "fallback_succeeded": False,
            "fallback_error": str(e),
            "fallback_time": f"{fallback_time:.2f}s"
        }
        search_logger.error(f"Fallback exception: {fallback_error}")
        return None


def extract_code_blocks(markdown_content: str, min_length: int = None) -> list[dict[str, Any]]:
    """
    Extract code blocks from markdown content along with context.

    Args:
        markdown_content: The markdown content to extract code blocks from
        min_length: Minimum length of code blocks to extract (default: from settings or 250)

    Returns:
        List of dictionaries containing code blocks and their context
    """
    # Load all code extraction settings with direct fallback
    try:
        def _get_setting_fallback(key: str, default: str) -> str:
            if credential_service._cache_initialized and key in credential_service._cache:
                return credential_service._cache[key]
            return os.getenv(key, default)

        # Get all relevant settings with defaults
        if min_length is None:
            min_length = int(_get_setting_fallback("MIN_CODE_BLOCK_LENGTH", "250"))

        max_length = int(_get_setting_fallback("MAX_CODE_BLOCK_LENGTH", "5000"))
        enable_prose_filtering = (
            _get_setting_fallback("ENABLE_PROSE_FILTERING", "true").lower() == "true"
        )
        max_prose_ratio = float(_get_setting_fallback("MAX_PROSE_RATIO", "0.15"))
        min_code_indicators = int(_get_setting_fallback("MIN_CODE_INDICATORS", "3"))
        enable_diagram_filtering = (
            _get_setting_fallback("ENABLE_DIAGRAM_FILTERING", "true").lower() == "true"
        )
        enable_contextual_length = (
            _get_setting_fallback("ENABLE_CONTEXTUAL_LENGTH", "true").lower() == "true"
        )
        context_window_size = int(_get_setting_fallback("CONTEXT_WINDOW_SIZE", "1000"))

    except Exception as e:
        # Fallback to defaults if settings retrieval fails
        search_logger.warning(f"Failed to get code extraction settings: {e}, using defaults")
        if min_length is None:
            min_length = 250
        max_length = 5000
        enable_prose_filtering = True
        max_prose_ratio = 0.15
        min_code_indicators = 3
        enable_diagram_filtering = True
        enable_contextual_length = True
        context_window_size = 1000

    search_logger.debug(f"Extracting code blocks with minimum length: {min_length} characters")
    code_blocks = []

    # Skip if content starts with triple backticks (edge case for files wrapped in backticks)
    content = markdown_content.strip()
    start_offset = 0

    # Check for corrupted markdown (entire content wrapped in code block)
    if content.startswith("```"):
        first_line = content.split("\n")[0] if "\n" in content else content[:10]
        # If it's ```K` or similar single-letter "language" followed by backtick, it's corrupted
        # This pattern specifically looks for ```K` or ```K` (with extra backtick)
        if re.match(r"^```[A-Z]`$", first_line):
            search_logger.warning(f"Detected corrupted markdown with fake language: {first_line}")
            # Try to find actual code blocks within the corrupted content
            # Look for nested triple backticks
            # Skip the outer ```K` and closing ```
            inner_content = content[5:-3] if content.endswith("```") else content[5:]
            # Now extract normally from inner content
            search_logger.info(
                f"Attempting to extract from inner content (length: {len(inner_content)})"
            )
            return extract_code_blocks(inner_content, min_length)
        # For normal language identifiers (e.g., ```python, ```javascript), process normally
        # No need to skip anything - the extraction logic will handle it correctly
        start_offset = 0

    # Find all occurrences of triple backticks
    backtick_positions = []
    pos = start_offset
    while True:
        pos = markdown_content.find("```", pos)
        if pos == -1:
            break
        backtick_positions.append(pos)
        pos += 3

    # Process pairs of backticks
    i = 0
    while i < len(backtick_positions) - 1:
        start_pos = backtick_positions[i]
        end_pos = backtick_positions[i + 1]

        # Extract the content between backticks
        code_section = markdown_content[start_pos + 3 : end_pos]

        # Check if there's a language specifier on the first line
        lines = code_section.split("\n", 1)
        if len(lines) > 1:
            # Check if first line is a language specifier (no spaces, common language names)
            first_line = lines[0].strip()
            if first_line and " " not in first_line and len(first_line) < 20:
                language = first_line.lower()
                # Keep the code content with its original formatting (don't strip)
                code_content = lines[1] if len(lines) > 1 else ""
            else:
                language = ""
                # No language identifier, so the entire section is code
                code_content = code_section
        else:
            language = ""
            # Single line code block - keep as is
            code_content = code_section

        # Skip if code block is too short
        if len(code_content) < min_length:
            i += 2  # Move to next pair
            continue

        # Skip if code block is too long (likely corrupted or not actual code)
        if len(code_content) > max_length:
            search_logger.debug(
                f"Skipping code block that exceeds max length ({len(code_content)} > {max_length})"
            )
            i += 2  # Move to next pair
            continue

        # Check if this is actually code or just documentation text
        # If no language specified, check content to determine if it's code
        if not language or language in ["text", "plaintext", "txt"]:
            # Check if content looks like prose/documentation rather than code
            code_lower = code_content.lower()

            # Common indicators this is documentation, not code
            doc_indicators = [
                # Prose patterns
                ("this ", "that ", "these ", "those ", "the "),  # Articles
                ("is ", "are ", "was ", "were ", "will ", "would "),  # Verbs
                ("to ", "from ", "with ", "for ", "and ", "or "),  # Prepositions/conjunctions
                # Documentation specific
                "for example:",
                "note:",
                "warning:",
                "important:",
                "description:",
                "usage:",
                "parameters:",
                "returns:",
                # Sentence endings
                ". ",
                "? ",
                "! ",
            ]

            # Count documentation indicators
            doc_score = 0
            for indicator in doc_indicators:
                if isinstance(indicator, tuple):
                    # Check if multiple words from tuple appear
                    doc_score += sum(1 for word in indicator if word in code_lower)
                else:
                    if indicator in code_lower:
                        doc_score += 2

            # Calculate lines and check structure
            content_lines = code_content.split("\n")
            non_empty_lines = [line for line in content_lines if line.strip()]

            # If high documentation score relative to content size, skip (if prose filtering enabled)
            if enable_prose_filtering:
                words = code_content.split()
                if len(words) > 0:
                    doc_ratio = doc_score / len(words)
                    # Use configurable prose ratio threshold
                    if doc_ratio > max_prose_ratio:
                        search_logger.debug(
                            f"Skipping documentation text disguised as code | doc_ratio={doc_ratio:.2f} | threshold={max_prose_ratio} | first_50_chars={repr(code_content[:50])}"
                        )
                        i += 2
                        continue

            # Additional check: if no typical code patterns found
            code_patterns = [
                "=",
                "(",
                ")",
                "{",
                "}",
                "[",
                "]",
                ";",
                "function",
                "def",
                "class",
                "import",
                "export",
                "const",
                "let",
                "var",
                "return",
                "if",
                "for",
                "->",
                "=>",
                "==",
                "!=",
                "<=",
                ">=",
            ]

            code_pattern_count = sum(1 for pattern in code_patterns if pattern in code_content)
            if code_pattern_count < min_code_indicators and len(non_empty_lines) > 5:
                # Looks more like prose than code
                search_logger.debug(
                    f"Skipping prose text | code_patterns={code_pattern_count} | min_indicators={min_code_indicators} | lines={len(non_empty_lines)}"
                )
                i += 2
                continue

            # Check for ASCII art diagrams if diagram filtering is enabled
            if enable_diagram_filtering:
                # Common indicators of ASCII art diagrams
                diagram_indicators = [
                    "┌",
                    "┐",
                    "└",
                    "┘",
                    "│",
                    "─",
                    "├",
                    "┤",
                    "┬",
                    "┴",
                    "┼",  # Box drawing chars
                    "+-+",
                    "|_|",
                    "___",
                    "...",  # ASCII art patterns
                    "→",
                    "←",
                    "↑",
                    "↓",
                    "⟶",
                    "⟵",  # Arrows
                ]

                # Count lines that are mostly special characters or whitespace
                special_char_lines = 0
                for line in non_empty_lines[:10]:  # Check first 10 lines
                    # Count non-alphanumeric characters
                    special_chars = sum(1 for c in line if not c.isalnum() and not c.isspace())
                    if len(line) > 0 and special_chars / len(line) > 0.7:
                        special_char_lines += 1

                # Check for diagram indicators
                diagram_indicator_count = sum(
                    1 for indicator in diagram_indicators if indicator in code_content
                )

                # If looks like a diagram, skip it
                if (
                    special_char_lines >= 3 or diagram_indicator_count >= 5
                ) and code_pattern_count < 5:
                    search_logger.debug(
                        f"Skipping ASCII art diagram | special_lines={special_char_lines} | diagram_indicators={diagram_indicator_count}"
                    )
                    i += 2
                    continue

        # Extract context before (configurable window size)
        context_start = max(0, start_pos - context_window_size)
        context_before = markdown_content[context_start:start_pos].strip()

        # Extract context after (configurable window size)
        context_end = min(len(markdown_content), end_pos + 3 + context_window_size)
        context_after = markdown_content[end_pos + 3 : context_end].strip()

        # Add the extracted code block
        stripped_code = code_content.strip()
        code_blocks.append({
            "code": stripped_code,
            "language": language,
            "context_before": context_before,
            "context_after": context_after,
            "full_context": f"{context_before}\n\n{stripped_code}\n\n{context_after}",
        })

        # Move to next pair (skip the closing backtick we just processed)
        i += 2

    # Apply deduplication logic to remove similar code variants
    if not code_blocks:
        return code_blocks

    search_logger.debug(f"Starting deduplication process for {len(code_blocks)} code blocks")

    # Group similar code blocks together
    similarity_threshold = 0.85  # 85% similarity threshold
    grouped_blocks = []
    processed_indices = set()

    for i, block1 in enumerate(code_blocks):
        if i in processed_indices:
            continue

        # Start a new group with this block
        similar_group = [block1]
        processed_indices.add(i)

        # Find all similar blocks
        for j, block2 in enumerate(code_blocks):
            if j <= i or j in processed_indices:
                continue

            similarity = _calculate_code_similarity(block1["code"], block2["code"])

            if similarity >= similarity_threshold:
                similar_group.append(block2)
                processed_indices.add(j)
                search_logger.debug(f"Found similar code blocks with {similarity:.2f} similarity")

        # Select the best variant from the similar group
        best_variant = _select_best_code_variant(similar_group)
        grouped_blocks.append(best_variant)

    deduplicated_count = len(code_blocks) - len(grouped_blocks)
    if deduplicated_count > 0:
        search_logger.info(
            f"Code deduplication: removed {deduplicated_count} duplicate variants, kept {len(grouped_blocks)} unique code blocks"
        )

    return grouped_blocks


def generate_code_example_summary(
    code: str, context_before: str, context_after: str, language: str = "", provider: str = None
) -> dict[str, str]:
    """
    Generate a summary and name for a code example using its surrounding context.

    Args:
        code: The code example
        context_before: Context before the code
        context_after: Context after the code
        language: The code language (if known)
        provider: Optional provider override

    Returns:
        A dictionary with 'summary' and 'example_name'
    """
    import asyncio
    
    # Run the async version in the current thread
    return asyncio.run(_generate_code_example_summary_async(code, context_before, context_after, language, provider))


async def _generate_code_example_summary_async(
    code: str, context_before: str, context_after: str, language: str = "", provider: str = None
) -> dict[str, str]:
    """
    Async version of generate_code_example_summary using unified LLM provider service.
    """
    from ..llm_provider_service import get_llm_client
    
    # Get model choice from credential service (RAG setting)
    model_choice = _get_model_choice()

    # Create the prompt
    prompt = f"""<context_before>
{context_before[-500:] if len(context_before) > 500 else context_before}
</context_before>

<code_example language="{language}">
{code[:1500] if len(code) > 1500 else code}
</code_example>

<context_after>
{context_after[:500] if len(context_after) > 500 else context_after}
</context_after>

Based on the code example and its surrounding context, provide:
1. A concise, action-oriented name (1-4 words) that describes what this code DOES, not what it is. Focus on the action or purpose.
   Good examples: "Parse JSON Response", "Validate Email Format", "Connect PostgreSQL", "Handle File Upload", "Sort Array Items", "Fetch User Data"
   Bad examples: "Function Example", "Code Snippet", "JavaScript Code", "API Code"
2. A summary (2-3 sentences) that describes what this code example demonstrates and its purpose

Format your response as JSON:
{{
  "example_name": "Action-oriented name (1-4 words)",
  "summary": "2-3 sentence description of what the code demonstrates"
}}
"""

    try:
        # Use unified LLM provider service
        async with get_llm_client(provider=provider) as client:
            search_logger.info(
                f"Generating summary for {hash(code) & 0xffffff:06x} using model: {model_choice}"
            )
            
            response = await client.chat.completions.create(
                model=model_choice,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a helpful assistant that analyzes code examples and provides JSON responses with example names and summaries.",
                    },
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": 2000 if (_is_reasoning_model(model_choice) or provider == "grok") else 500,  # 2000 tokens for both reasoning models (GPT-5) and Grok for complex reasoning
                "temperature": 0.3,
            }

            # Try to use response_format, but handle gracefully if not supported
            # Note: Grok and reasoning models (GPT-5, o1, o3) don't work well with response_format
            supports_response_format = (
                provider in ["openai", "google", "anthropic"] or
                (provider == "openrouter" and model_choice.startswith("openai/"))
            )
            # Exclude reasoning models from using response_format
            if supports_response_format and not _is_reasoning_model(model_choice):
                request_params["response_format"] = {"type": "json_object"}

            # Grok-specific parameter validation and filtering
            if provider == "grok":
                # Remove any parameters that Grok reasoning models don't support
                # Based on xAI docs: presencePenalty, frequencyPenalty, stop are not supported
                unsupported_params = ["presence_penalty", "frequency_penalty", "stop", "reasoning_effort"]
                for param in unsupported_params:
                    if param in request_params:
                        removed_value = request_params.pop(param)
                        search_logger.warning(f"Removed unsupported Grok parameter '{param}': {removed_value}")

                # Validate that we're using supported parameters only
                supported_params = ["model", "messages", "max_tokens", "temperature", "response_format", "stream", "tools", "tool_choice"]
                for param in request_params:
                    if param not in supported_params:
                        search_logger.warning(f"Parameter '{param}' may not be supported by Grok reasoning models")

            # Enhanced debugging for Grok provider
            # Implement retry logic for Grok and reasoning models (GPT-5, o1, o3) empty responses
            is_reasoning = _is_reasoning_model(model_choice)

            start_time = time.time()  # Initialize for all models
            if provider == "grok" or is_reasoning:
                model_type = "Grok" if provider == "grok" else f"reasoning model ({model_choice})"
                search_logger.debug(f"{model_type} request params: {request_params}")
                search_logger.debug(f"{model_type} prompt length: {len(prompt)} characters")
                search_logger.debug(f"{model_type} prompt preview: {prompt[:200]}...")

            max_retries = 3 if (provider == "grok" or is_reasoning) else 1
            retry_delay = 1.0  # Start with 1 second delay
            failure_reasons = []  # Track failure reasons for circuit breaker analysis

            for attempt in range(max_retries):
                try:
                    if (provider == "grok" or is_reasoning) and attempt > 0:
                        model_type = "Grok" if provider == "grok" else f"reasoning model ({model_choice})"
                        search_logger.info(f"{model_type} retry attempt {attempt + 1}/{max_retries} after {retry_delay:.1f}s delay")
                        await asyncio.sleep(retry_delay)
                    elif is_reasoning and attempt == 0:
                        # Small delay for reasoning models on first attempt to help with cold start
                        search_logger.debug(f"reasoning model ({model_choice}) first attempt - adding 0.5s delay for cold start")
                        await asyncio.sleep(0.5)

                    # Convert max_tokens to max_completion_tokens for GPT-5/reasoning models
                    final_params = prepare_chat_completion_params(model_choice, request_params)
                    response = await client.chat.completions.create(**final_params)

                    # Check for empty response - handle Grok reasoning models
                    message = response.choices[0].message if response.choices else None
                    response_content = None

                    # Enhanced debugging for Grok and reasoning models - log both content fields
                    if (provider == "grok" or is_reasoning) and message:
                        content_preview = message.content[:100] if message.content else "None"
                        reasoning_preview = getattr(message, 'reasoning_content', 'N/A')[:100] if hasattr(message, 'reasoning_content') and message.reasoning_content else "None"
                        model_type = "Grok" if provider == "grok" else f"reasoning model ({model_choice})"

                        # Additional debugging for first attempt failures
                        finish_reason = getattr(response.choices[0], 'finish_reason', 'unknown') if response.choices else 'no_choices'
                        usage_info = getattr(response, 'usage', None)
                        if usage_info:
                            completion_tokens = getattr(usage_info, 'completion_tokens', 0)
                            reasoning_tokens = getattr(getattr(usage_info, 'completion_tokens_details', None), 'reasoning_tokens', 0) if hasattr(usage_info, 'completion_tokens_details') else 0
                            search_logger.debug(f"{model_type} attempt {attempt + 1} - finish_reason: {finish_reason}, completion_tokens: {completion_tokens}, reasoning_tokens: {reasoning_tokens}")
                        else:
                            search_logger.debug(f"{model_type} attempt {attempt + 1} - finish_reason: {finish_reason}, no usage info")

                        search_logger.debug(f"{model_type} response fields - content: '{content_preview}', reasoning_content: '{reasoning_preview}'")

                    if message:
                        # For Grok and reasoning models, check content first, then reasoning_content
                        if provider == "grok" or is_reasoning:
                            # First try content (where final answer should be)
                            if message.content and message.content.strip():
                                response_content = message.content.strip()
                                model_type = "Grok" if provider == "grok" else f"reasoning model ({model_choice})"
                                search_logger.debug(f"{model_type} using content field: {len(response_content)} chars")
                            # Fallback to reasoning_content if content is empty
                            elif hasattr(message, 'reasoning_content') and message.reasoning_content:
                                response_content = message.reasoning_content.strip()
                                model_type = "Grok" if provider == "grok" else f"reasoning model ({model_choice})"
                                search_logger.debug(f"{model_type} fallback to reasoning_content: {len(response_content)} chars")
                            else:
                                search_logger.debug(f"Grok no content in either field: content='{message.content}', reasoning_content='{getattr(message, 'reasoning_content', 'N/A')}'")
                        elif message.content:
                            response_content = message.content
                        else:
                            search_logger.debug(f"No content in message: content={message.content}, reasoning_content={getattr(message, 'reasoning_content', 'N/A')}")

                    if response_content and response_content.strip():
                        # Success - break out of retry loop
                        if (provider == "grok" or is_reasoning) and attempt > 0:
                            model_type = "Grok" if provider == "grok" else f"reasoning model ({model_choice})"
                            search_logger.info(f"{model_type} request succeeded on attempt {attempt + 1}")
                        break
                    elif (provider == "grok" or is_reasoning) and attempt < max_retries - 1:
                        # Empty response from Grok or reasoning models - retry with exponential backoff
                        model_type = "Grok" if provider == "grok" else f"reasoning model ({model_choice})"
                        search_logger.warning(f"{model_type} empty response on attempt {attempt + 1}, retrying...")
                        retry_delay *= 2  # Exponential backoff
                        continue
                    else:
                        # Final attempt failed or not Grok/reasoning model - handle below
                        break

                except Exception as e:
                    if (provider == "grok" or is_reasoning) and attempt < max_retries - 1:
                        model_type = "Grok" if provider == "grok" else f"reasoning model ({model_choice})"
                        search_logger.error(f"{model_type} request failed on attempt {attempt + 1}: {e}, retrying...")
                        retry_delay *= 2
                        continue
                    else:
                        # Re-raise on final attempt or non-Grok/reasoning providers
                        raise

            # Log timing for Grok and reasoning model requests
            if provider == "grok" or is_reasoning:
                elapsed_time = time.time() - start_time
                model_type = "Grok" if provider == "grok" else f"reasoning model ({model_choice})"
                search_logger.debug(f"{model_type} total response time: {elapsed_time:.2f}s")

            # Handle empty response with streamlined fallback logic
            if not response_content:
                # Structured error analysis for debugging
                error_context = {
                    "model": model_choice,
                    "provider": provider,
                    "request_time": f"{elapsed_time:.2f}s" if 'elapsed_time' in locals() else "unknown",
                    "response_type": "empty_content",
                    "response_choices_count": len(response.choices) if response.choices else 0
                }
                search_logger.error(f"Empty response from LLM: {error_context}")
                # Determine if fallback should be attempted based on error type and configuration
                should_fallback = _should_attempt_fallback(provider, model_choice, is_reasoning, error_context)

                if should_fallback:
                    # Single fallback attempt with tracking
                    fallback_result = await _attempt_single_fallback(
                        model_choice, provider, is_reasoning, request_params, error_context
                    )
                    if fallback_result:
                        response_content = fallback_result
                        search_logger.info(f"Fallback succeeded for {model_choice}")
                    else:
                        # Log fallback failure analysis for circuit breaker patterns
                        fallback_failure = {
                            "original_model": model_choice,
                            "original_provider": provider,
                            "fallback_attempted": True,
                            "fallback_succeeded": False,
                            "error_context": error_context
                        }
                    elif (provider == "grok" or is_reasoning) and attempt < max_retries - 1:
                        # Empty response from Grok or reasoning models - track failure and retry
                        model_type = "Grok" if provider == "grok" else f"reasoning model ({model_choice})"
                        failure_reason = f"empty_response_attempt_{attempt + 1}"
                        failure_reasons.append(failure_reason)

                        async with get_llm_client(provider="openai") as fallback_client:
                            search_logger.info("Using OpenAI fallback for Grok failure")
                            # Convert max_tokens to max_completion_tokens for GPT-5/reasoning models
                            final_fallback_params = prepare_chat_completion_params(fallback_params["model"], fallback_params)
                            fallback_response = await fallback_client.chat.completions.create(**final_fallback_params)
                            fallback_content = fallback_response.choices[0].message.content

                            if fallback_content and fallback_content.strip():
                                search_logger.info("OpenAI fallback succeeded")
                                response_content = fallback_content.strip()
                            else:
                                search_logger.error("OpenAI fallback also returned empty response")
                                raise ValueError("Both Grok and OpenAI fallback failed")

                    except Exception as fallback_error:
                        search_logger.error(f"OpenAI fallback failed: {fallback_error}")
                        raise ValueError(f"Grok failed and fallback to OpenAI also failed: {fallback_error}") from fallback_error
                elif is_reasoning:
                    # Implement fallback for reasoning model (GPT-5, o1, o3) failures
                    search_logger.error("Reasoning model empty response debugging:")
                    search_logger.error(f"  - Model: {model_choice}")
                    search_logger.error(f"  - Provider: {provider}")
                    search_logger.error(f"  - Request took: {elapsed_time:.2f}s")
                    search_logger.error(f"  - Full response: {response}")
                    search_logger.error(f"  - Response choices length: {len(response.choices) if response.choices else 0}")
                    if response.choices:
                        search_logger.error(f"  - First choice: {response.choices[0]}")
                        search_logger.error(f"  - Message content: '{response.choices[0].message.content}'")
                        search_logger.error(f"  - Message role: {response.choices[0].message.role}")
                    search_logger.error("Check: 1) API key validity, 2) rate limits, 3) model availability")

                    # Implement fallback to non-reasoning model for reasoning model failures
                    search_logger.warning(f"Attempting fallback to gpt-4o-mini due to {model_choice} failure...")
                    try:
                        # Use a reliable non-reasoning model as fallback
                        fallback_params = {
                            "model": "gpt-4o-mini",
                            "messages": request_params["messages"],
                            "max_tokens": request_params.get("max_tokens", 500),
                            "temperature": request_params.get("temperature", 0.3),
                            "response_format": {"type": "json_object"}
                        }

                        async with get_llm_client(provider="openai") as fallback_client:
                            search_logger.info(f"Using gpt-4o-mini fallback for {model_choice} failure")
                            # No parameter conversion needed for non-reasoning model
                            fallback_response = await fallback_client.chat.completions.create(**fallback_params)
                            fallback_content = fallback_response.choices[0].message.content

                            if fallback_content and fallback_content.strip():
                                search_logger.info(f"gpt-4o-mini fallback succeeded for {model_choice}")
                                response_content = fallback_content.strip()
                            else:
                                search_logger.error("gpt-4o-mini fallback also returned empty response")
                                raise ValueError(f"Both {model_choice} and gpt-4o-mini fallback failed")

                    except Exception as fallback_error:
                        search_logger.error(f"gpt-4o-mini fallback failed: {fallback_error}")
                        raise ValueError(f"{model_choice} failed and fallback to gpt-4o-mini also failed: {fallback_error}") from fallback_error
                else:
                    # No fallback attempted - fail fast with detailed context
                    search_logger.error(f"No fallback configured for {provider}/{model_choice} - failing fast")
                    raise ValueError(f"Empty response from {model_choice} (provider: {provider}). Check: API key validity, rate limits, model availability")

            if not response_content:
                # This should not happen after fallback logic, but safety check
                raise ValueError("No valid response content after all attempts")

            response_content = response_content.strip()
            search_logger.debug(f"LLM API response: {repr(response_content[:200])}...")

            result = json.loads(response_content)

            # Validate the response has the required fields
            if not result.get("example_name") or not result.get("summary"):
                search_logger.warning(f"Incomplete response from LLM: {result}")

            final_result = {
                "example_name": result.get(
                    "example_name", f"Code Example{f' ({language})' if language else ''}"
                ),
                "summary": result.get("summary", "Code example for demonstration purposes."),
            }

            search_logger.info(
                f"Generated code example summary - Name: '{final_result['example_name']}', Summary length: {len(final_result['summary'])}"
            )
            return final_result

    except json.JSONDecodeError as e:
        search_logger.error(
            f"Failed to parse JSON response from LLM: {e}, Response: {repr(response_content) if 'response_content' in locals() else 'No response'}"
        )
        return {
            "example_name": f"Code Example{f' ({language})' if language else ''}",
            "summary": "Code example for demonstration purposes.",
        }
    except Exception as e:
        search_logger.error(f"Error generating code summary using unified LLM provider: {e}")
        return {
            "example_name": f"Code Example{f' ({language})' if language else ''}",
            "summary": "Code example for demonstration purposes.",
        }


async def generate_code_summaries_batch(
    code_blocks: list[dict[str, Any]], max_workers: int = None, progress_callback=None
) -> list[dict[str, str]]:
    """
    Generate summaries for multiple code blocks with rate limiting and proper worker management.

    Args:
        code_blocks: List of code block dictionaries
        max_workers: Maximum number of concurrent API requests
        progress_callback: Optional callback for progress updates (async function)

    Returns:
        List of summary dictionaries
    """
    if not code_blocks:
        return []

    # Get max_workers from settings if not provided
    if max_workers is None:
        try:
            if (
                credential_service._cache_initialized
                and "CODE_SUMMARY_MAX_WORKERS" in credential_service._cache
            ):
                max_workers = int(credential_service._cache["CODE_SUMMARY_MAX_WORKERS"])
            else:
                max_workers = int(os.getenv("CODE_SUMMARY_MAX_WORKERS", "3"))
        except:
            max_workers = 3  # Default fallback

    search_logger.info(
        f"Generating summaries for {len(code_blocks)} code blocks with max_workers={max_workers}"
    )

    # Semaphore to limit concurrent requests
    semaphore = asyncio.Semaphore(max_workers)
    completed_count = 0
    lock = asyncio.Lock()

    async def generate_single_summary_with_limit(block: dict[str, Any]) -> dict[str, str]:
        nonlocal completed_count
        async with semaphore:
            # Add delay between requests to avoid rate limiting
            await asyncio.sleep(0.5)  # 500ms delay between requests

            # Run the synchronous function in a thread
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                generate_code_example_summary,
                block["code"],
                block["context_before"],
                block["context_after"],
                block.get("language", ""),
            )

            # Update progress
            async with lock:
                completed_count += 1
                if progress_callback:
                    # Simple progress based on summaries completed
                    progress_percentage = int((completed_count / len(code_blocks)) * 100)
                    await progress_callback({
                        "status": "code_extraction",
                        "percentage": progress_percentage,
                        "log": f"Generated {completed_count}/{len(code_blocks)} code summaries",
                        "completed_summaries": completed_count,
                        "total_summaries": len(code_blocks),
                    })

            return result

    # Process all blocks concurrently but with rate limiting
    try:
        summaries = await asyncio.gather(
            *[generate_single_summary_with_limit(block) for block in code_blocks],
            return_exceptions=True,
        )

        # Handle any exceptions in the results
        final_summaries = []
        for i, summary in enumerate(summaries):
            if isinstance(summary, Exception):
                search_logger.error(f"Error generating summary for code block {i}: {summary}")
                # Use fallback summary
                language = code_blocks[i].get("language", "")
                fallback = {
                    "example_name": f"Code Example{f' ({language})' if language else ''}",
                    "summary": "Code example for demonstration purposes.",
                }
                final_summaries.append(fallback)
            else:
                final_summaries.append(summary)

        search_logger.info(f"Successfully generated {len(final_summaries)} code summaries")
        return final_summaries

    except Exception as e:
        search_logger.error(f"Error in batch summary generation: {e}")
        # Return fallback summaries for all blocks
        fallback_summaries = []
        for block in code_blocks:
            language = block.get("language", "")
            fallback = {
                "example_name": f"Code Example{f' ({language})' if language else ''}",
                "summary": "Code example for demonstration purposes.",
            }
            fallback_summaries.append(fallback)
        return fallback_summaries


async def add_code_examples_to_supabase(
    client: Client,
    urls: list[str],
    chunk_numbers: list[int],
    code_examples: list[str],
    summaries: list[str],
    metadatas: list[dict[str, Any]],
    batch_size: int = 20,
    url_to_full_document: dict[str, str] | None = None,
    progress_callback: Callable | None = None,
    provider: str | None = None,
):
    """
    Add code examples to the Supabase code_examples table in batches.

    Args:
        client: Supabase client
        urls: List of URLs
        chunk_numbers: List of chunk numbers
        code_examples: List of code example contents
        summaries: List of code example summaries
        metadatas: List of metadata dictionaries
        batch_size: Size of each batch for insertion
        url_to_full_document: Optional mapping of URLs to full document content
        progress_callback: Optional async callback for progress updates
    """
    if not urls:
        return

    # Delete existing records for these URLs
    unique_urls = list(set(urls))
    for url in unique_urls:
        try:
            client.table("archon_code_examples").delete().eq("url", url).execute()
        except Exception as e:
            search_logger.error(f"Error deleting existing code examples for {url}: {e}")

    # Check if contextual embeddings are enabled
    try:
        use_contextual_embeddings = credential_service._cache.get("USE_CONTEXTUAL_EMBEDDINGS")
        if isinstance(use_contextual_embeddings, str):
            use_contextual_embeddings = use_contextual_embeddings.lower() == "true"
        elif isinstance(use_contextual_embeddings, dict) and use_contextual_embeddings.get(
            "is_encrypted"
        ):
            # Handle encrypted value
            encrypted_value = use_contextual_embeddings.get("encrypted_value")
            if encrypted_value:
                try:
                    decrypted = credential_service._decrypt_value(encrypted_value)
                    use_contextual_embeddings = decrypted.lower() == "true"
                except:
                    use_contextual_embeddings = False
            else:
                use_contextual_embeddings = False
        else:
            use_contextual_embeddings = bool(use_contextual_embeddings)
    except:
        # Fallback to environment variable
        use_contextual_embeddings = (
            os.getenv("USE_CONTEXTUAL_EMBEDDINGS", "false").lower() == "true"
        )

    search_logger.info(
        f"Using contextual embeddings for code examples: {use_contextual_embeddings}"
    )

    # Process in batches
    total_items = len(urls)
    for i in range(0, total_items, batch_size):
        batch_end = min(i + batch_size, total_items)
        batch_texts = []
        batch_metadatas_for_batch = metadatas[i:batch_end]

        # Create combined texts for embedding (code + summary)
        combined_texts = []
        original_indices: list[int] = []
        for j in range(i, batch_end):
            # Validate inputs
            code = code_examples[j] if isinstance(code_examples[j], str) else str(code_examples[j])
            summary = summaries[j] if isinstance(summaries[j], str) else str(summaries[j])

            if not code:
                search_logger.warning(f"Empty code at index {j}, skipping...")
                continue

            combined_text = f"{code}\n\nSummary: {summary}"
            combined_texts.append(combined_text)
            original_indices.append(j)

        # Apply contextual embeddings if enabled
        if use_contextual_embeddings and url_to_full_document:
            # Get full documents for context
            full_documents = []
            for j in range(i, batch_end):
                url = urls[j]
                full_doc = url_to_full_document.get(url, "")
                full_documents.append(full_doc)

            # Generate contextual embeddings
            contextual_results = await generate_contextual_embeddings_batch(
                full_documents, combined_texts
            )

            # Process results
            for j, (contextual_text, success) in enumerate(contextual_results):
                batch_texts.append(contextual_text)
                if success and j < len(batch_metadatas_for_batch):
                    batch_metadatas_for_batch[j]["contextual_embedding"] = True
        else:
            # Use original combined texts
            batch_texts = combined_texts

        # Create embeddings for the batch
        result = await create_embeddings_batch(batch_texts, provider=provider)

        # Log any failures
        if result.has_failures:
            search_logger.error(
                f"Failed to create {result.failure_count} code example embeddings. "
                f"Successful: {result.success_count}"
            )

        # Use only successful embeddings
        valid_embeddings = result.embeddings
        successful_texts = result.texts_processed
        
        # Get model information for tracking
        from ..llm_provider_service import get_embedding_model
        from ..credential_service import credential_service
        
        # Get embedding model name
        embedding_model_name = await get_embedding_model(provider=provider)
        
        # Get LLM chat model (used for code summaries and contextual embeddings if enabled)
        llm_chat_model = None
        try:
            # First check if contextual embeddings were used
            if use_contextual_embeddings:
                provider_config = await credential_service.get_active_provider("llm")
                llm_chat_model = provider_config.get("chat_model", "")
                if not llm_chat_model:
                    # Fallback to MODEL_CHOICE
                    llm_chat_model = await credential_service.get_credential("MODEL_CHOICE", "gpt-4o-mini")
            else:
                # For code summaries, we use MODEL_CHOICE
                llm_chat_model = _get_model_choice()
        except Exception as e:
            search_logger.warning(f"Failed to get LLM chat model: {e}")
            llm_chat_model = "gpt-4o-mini"  # Default fallback

        if not valid_embeddings:
            search_logger.warning("Skipping batch - no successful embeddings created")
            continue

        # Prepare batch data - only for successful embeddings
        batch_data = []

        # Build positions map to handle duplicate texts correctly
        # Each text maps to a queue of indices where it appears
        positions_by_text = defaultdict(deque)
        for k, text in enumerate(batch_texts):
            # map text -> original j index (not k)
            positions_by_text[text].append(original_indices[k])

        # Map successful texts back to their original indices
        for embedding, text in zip(valid_embeddings, successful_texts, strict=False):
            # Get the next available index for this text (handles duplicates)
            if positions_by_text[text]:
                orig_idx = positions_by_text[text].popleft()  # Original j index in [i, batch_end)
            else:
                search_logger.warning(f"Could not map embedding back to original code example (no remaining index for text: {text[:50]}...)")
                continue

            idx = orig_idx  # Global index into urls/chunk_numbers/etc.

            # Use source_id from metadata if available, otherwise extract from URL
            if metadatas[idx] and "source_id" in metadatas[idx]:
                source_id = metadatas[idx]["source_id"]
            else:
                parsed_url = urlparse(urls[idx])
                source_id = parsed_url.netloc or parsed_url.path

            # Determine the correct embedding column based on dimension
            embedding_dim = len(embedding) if isinstance(embedding, list) else len(embedding.tolist())
            embedding_column = None
            
            if embedding_dim == 768:
                embedding_column = "embedding_768"
            elif embedding_dim == 1024:
                embedding_column = "embedding_1024"
            elif embedding_dim == 1536:
                embedding_column = "embedding_1536"
            elif embedding_dim == 3072:
                embedding_column = "embedding_3072"
            else:
                # Default to closest supported dimension
                search_logger.warning(f"Unsupported embedding dimension {embedding_dim}, using embedding_1536")
                embedding_column = "embedding_1536"
            
            batch_data.append({
                "url": urls[idx],
                "chunk_number": chunk_numbers[idx],
                "content": code_examples[idx],
                "summary": summaries[idx],
                "metadata": metadatas[idx],  # Store as JSON object, not string
                "source_id": source_id,
                embedding_column: embedding,
                "llm_chat_model": llm_chat_model,  # Add LLM model tracking
                "embedding_model": embedding_model_name,  # Add embedding model tracking
                "embedding_dimension": embedding_dim,  # Add dimension tracking
            })

        if not batch_data:
            search_logger.warning("No records to insert for this batch; skipping insert.")
            continue

        # Insert batch into Supabase with retry logic
        max_retries = 3
        retry_delay = 1.0

        for retry in range(max_retries):
            try:
                client.table("archon_code_examples").insert(batch_data).execute()
                # Success - break out of retry loop
                break
            except Exception as e:
                if retry < max_retries - 1:
                    search_logger.warning(
                        f"Error inserting batch into Supabase (attempt {retry + 1}/{max_retries}): {e}"
                    )
                    search_logger.info(f"Retrying in {retry_delay} seconds...")
                    import time

                    time.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff
                else:
                    # Final attempt failed
                    search_logger.error(f"Failed to insert batch after {max_retries} attempts: {e}")
                    # Optionally, try inserting records one by one as a last resort
                    search_logger.info("Attempting to insert records individually...")
                    successful_inserts = 0
                    for record in batch_data:
                        try:
                            client.table("archon_code_examples").insert(record).execute()
                            successful_inserts += 1
                        except Exception as individual_error:
                            search_logger.error(
                                f"Failed to insert individual record for URL {record['url']}: {individual_error}"
                            )

                    if successful_inserts > 0:
                        search_logger.info(
                            f"Successfully inserted {successful_inserts}/{len(batch_data)} records individually"
                        )

        search_logger.info(
            f"Inserted batch {i // batch_size + 1} of {(total_items + batch_size - 1) // batch_size} code examples"
        )

        # Report progress if callback provided
        if progress_callback:
            batch_num = i // batch_size + 1
            total_batches = (total_items + batch_size - 1) // batch_size
            progress_percentage = int((batch_num / total_batches) * 100)
            await progress_callback({
                "status": "code_storage",
                "percentage": progress_percentage,
                "log": f"Stored batch {batch_num}/{total_batches} of code examples",
                # Stage-specific batch fields to prevent contamination with document storage
                "code_current_batch": batch_num,
                "code_total_batches": total_batches,
                # Keep generic fields for backward compatibility
                "batch_number": batch_num,
                "total_batches": total_batches,
            })

    # Report final completion at 100% after all batches are done
    if progress_callback and total_items > 0:
        await progress_callback({
            "status": "code_storage",
            "percentage": 100,
            "log": f"Code storage completed. Stored {total_items} code examples.",
            "total_items": total_items,
            # Keep final batch info for code storage completion
            "code_total_batches": (total_items + batch_size - 1) // batch_size,
            "code_current_batch": (total_items + batch_size - 1) // batch_size,
        })
