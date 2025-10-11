"""
Code Storage Service

Handles extraction and storage of code examples from documents.
"""

import asyncio
import json
import os
import re
import time
from collections import defaultdict, deque
from collections.abc import Callable
from difflib import SequenceMatcher
from typing import Any
from urllib.parse import urlparse

from supabase import Client

from ...config.logfire_config import search_logger
from ..credential_service import credential_service
from ..embeddings.contextual_embedding_service import generate_contextual_embeddings_batch
from ..embeddings.embedding_service import create_embeddings_batch
from ..llm_provider_service import (
    extract_json_from_reasoning,
    extract_message_text,
    get_llm_client,
    prepare_chat_completion_params,
    synthesize_json_from_reasoning,
)


def _extract_json_payload(raw_response: str, context_code: str = "", language: str = "") -> str:
    """Return the best-effort JSON object from an LLM response."""

    if not raw_response:
        return raw_response

    cleaned = raw_response.strip()

    # Check if this looks like reasoning text first
    if _is_reasoning_text_response(cleaned):
        # Try intelligent extraction from reasoning text with context
        extracted = extract_json_from_reasoning(cleaned, context_code, language)
        if extracted:
            return extracted
        # extract_json_from_reasoning may return nothing; synthesize a fallback JSON if so\
        fallback_json = synthesize_json_from_reasoning("", context_code, language)
        if fallback_json:
            return fallback_json
        # If all else fails, return a minimal valid JSON object to avoid downstream errors
        return '{"example_name": "Code Example", "summary": "Code example extracted from context."}'


    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        # Drop opening fence
        lines = lines[1:]
        # Drop closing fence if present
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()

    # Trim any leading/trailing text outside the outermost JSON braces
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end != -1 and end >= start:
        cleaned = cleaned[start : end + 1]

    return cleaned.strip()


REASONING_STARTERS = [
    "okay, let's see", "okay, let me", "let me think", "first, i need to", "looking at this",
    "i need to", "analyzing", "let me work through", "thinking about", "let me see"
]

def _is_reasoning_text_response(text: str) -> bool:
    """Detect if response is reasoning text rather than direct JSON."""
    if not text or len(text) < 20:
        return False

    text_lower = text.lower().strip()

    # Check for XML-style thinking tags (common in models with extended thinking)
    if text_lower.startswith("<think>") or "<think>" in text_lower[:100]:
        return True

    # Check if it's clearly not JSON (starts with reasoning text)
    starts_with_reasoning = any(text_lower.startswith(starter) for starter in REASONING_STARTERS)

    # Check if it lacks immediate JSON structure
    lacks_immediate_json = not text_lower.lstrip().startswith('{')

    return starts_with_reasoning or (lacks_immediate_json and any(pattern in text_lower for pattern in REASONING_STARTERS))
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
    code: str,
    context_before: str,
    context_after: str,
    language: str = "",
    provider: str = None,
    client = None
) -> dict[str, str]:
    """
    Async version of generate_code_example_summary using unified LLM provider service.

    Args:
        code: The code example to summarize
        context_before: Context before the code block
        context_after: Context after the code block
        language: Programming language of the code
        provider: LLM provider to use (optional)
        client: Pre-initialized LLM client for reuse (optional, improves performance)
    """

    # Get model choice from credential service (RAG setting)
    model_choice = await _get_model_choice()

    # If provider is not specified, get it from credential service
    if provider is None:
        try:
            provider_config = await credential_service.get_active_provider("llm")
            provider = provider_config.get("provider", "openai")
            search_logger.debug(f"Auto-detected provider from credential service: {provider}")
        except Exception as e:
            search_logger.warning(f"Failed to get provider from credential service: {e}, defaulting to openai")
            provider = "openai"

    # Create the prompt variants: base prompt, guarded prompt (JSON reminder), and strict prompt for retries
    base_prompt = f"""<context_before>
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
    guard_prompt = (
        base_prompt
        + "\n\nImportant: Respond with a valid JSON object that exactly matches the keys "
        '{"example_name": string, "summary": string}. Do not include commentary, '
        "markdown fences, or reasoning notes."
    )
    strict_prompt = (
        guard_prompt
        + "\n\nSecond attempt enforcement: Return JSON only with the exact schema. No additional text or reasoning content."
    )

    # Use provided client or create a new one
    if client is not None:
        # Reuse provided client for better performance
        return await _generate_summary_with_client(
            client, code, context_before, context_after, language, provider,
            model_choice, guard_prompt, strict_prompt
        )
    else:
        # Create new client (backward compatibility)
        async with get_llm_client(provider=provider) as new_client:
            return await _generate_summary_with_client(
                new_client, code, context_before, context_after, language, provider,
                model_choice, guard_prompt, strict_prompt
            )


async def _generate_summary_with_client(
    llm_client, code: str, context_before: str, context_after: str,
    language: str, provider: str, model_choice: str,
    guard_prompt: str, strict_prompt: str
) -> dict[str, str]:
    """Helper function that generates summary using a provided client."""
    search_logger.info(
        f"Generating summary for {hash(code) & 0xffffff:06x} using model: {model_choice}"
    )

    provider_lower = provider.lower()
    is_grok_model = (provider_lower == "grok") or ("grok" in model_choice.lower())
    is_ollama = provider_lower == "ollama"

    supports_response_format_base = (
        provider_lower in {"openai", "google", "anthropic"}
        or (provider_lower == "openrouter" and model_choice.startswith("openai/"))
    )

    last_response_obj = None
    last_elapsed_time = None
    last_response_content = ""
    last_json_error: json.JSONDecodeError | None = None

    try:
        for enforce_json, current_prompt in ((False, guard_prompt), (True, strict_prompt)):
            request_params = {
                "model": model_choice,
                "messages": [
                    {
                        "role": "system",
                        "content": "You are a helpful assistant that analyzes code examples and provides JSON responses with example names and summaries.",
                    },
                    {"role": "user", "content": current_prompt},
                ],
                "max_tokens": 2000,
                "temperature": 0.3,
            }

            should_use_response_format = False
            if enforce_json:
                if not is_grok_model and (supports_response_format_base or provider_lower == "openrouter"):
                    should_use_response_format = True
            else:
                if supports_response_format_base:
                    should_use_response_format = True

            if should_use_response_format:
                request_params["response_format"] = {"type": "json_object"}

            # Ollama uses a different parameter format for JSON mode
            if is_ollama and enforce_json:
                # Remove response_format if it was set (shouldn't be for ollama)
                request_params.pop("response_format", None)
                # Ollama expects "format": "json" parameter
                request_params["format"] = "json"
                search_logger.debug("Using Ollama-specific JSON format parameter")

            if is_grok_model:
                unsupported_params = ["presence_penalty", "frequency_penalty", "stop", "reasoning_effort"]
                for param in unsupported_params:
                    if param in request_params:
                        removed_value = request_params.pop(param)
                        search_logger.warning(f"Removed unsupported Grok parameter '{param}': {removed_value}")

                supported_params = ["model", "messages", "max_tokens", "temperature", "response_format", "stream", "tools", "tool_choice"]
                for param in list(request_params.keys()):
                    if param not in supported_params:
                        search_logger.warning(f"Parameter '{param}' may not be supported by Grok reasoning models")

            start_time = time.time()
            max_retries = 3 if is_grok_model else 1
            retry_delay = 1.0
            response_content_local = ""
            reasoning_text_local = ""
            json_error_occurred = False

            for attempt in range(max_retries):
                try:
                    if is_grok_model and attempt > 0:
                        search_logger.info(f"Grok retry attempt {attempt + 1}/{max_retries} after {retry_delay:.1f}s delay")
                        await asyncio.sleep(retry_delay)

                    final_params = prepare_chat_completion_params(model_choice, request_params)
                    response = await llm_client.chat.completions.create(**final_params)
                    last_response_obj = response

                    choice = response.choices[0] if response.choices else None
                    message = choice.message if choice and hasattr(choice, "message") else None
                    response_content_local = ""
                    reasoning_text_local = ""

                    if choice:
                        response_content_local, reasoning_text_local, _ = extract_message_text(choice)

                    # Enhanced logging for response analysis
                    if message and reasoning_text_local:
                        content_preview = response_content_local[:100] if response_content_local else "None"
                        reasoning_preview = reasoning_text_local[:100] if reasoning_text_local else "None"
                        search_logger.debug(
                            f"Response has reasoning content - content: '{content_preview}', reasoning: '{reasoning_preview}'"
                        )

                    if response_content_local:
                        last_response_content = response_content_local.strip()

                        # Pre-validate response before processing
                        if len(last_response_content) < 20 or (len(last_response_content) < 50 and not last_response_content.strip().startswith('{')):
                            # Very minimal response - likely "Okay\nOkay" type
                            search_logger.debug(f"Minimal response detected: {repr(last_response_content)}")
                            # Generate fallback directly from context
                            fallback_json = synthesize_json_from_reasoning("", code, language)
                            if fallback_json:
                                try:
                                    result = json.loads(fallback_json)
                                    final_result = {
                                        "example_name": result.get("example_name", f"Code Example{f' ({language})' if language else ''}"),
                                        "summary": result.get("summary", "Code example for demonstration purposes."),
                                    }
                                    search_logger.info(f"Generated fallback summary from context - Name: '{final_result['example_name']}', Summary length: {len(final_result['summary'])}")
                                    return final_result
                                except json.JSONDecodeError:
                                    pass  # Continue to normal error handling
                            else:
                                # Even synthesis failed - provide hardcoded fallback for minimal responses
                                final_result = {
                                    "example_name": f"Code Example{f' ({language})' if language else ''}",
                                    "summary": "Code example extracted from development context.",
                                }
                                search_logger.info(f"Used hardcoded fallback for minimal response - Name: '{final_result['example_name']}', Summary length: {len(final_result['summary'])}")
                                return final_result

                        payload = _extract_json_payload(last_response_content, code, language)
                        if payload != last_response_content:
                            search_logger.debug(
                                f"Sanitized LLM response payload before parsing: {repr(payload[:200])}..."
                            )

                        try:
                            result = json.loads(payload)

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

                        except json.JSONDecodeError as json_error:
                            last_json_error = json_error
                            json_error_occurred = True
                            snippet = last_response_content[:200]
                            if not enforce_json:
                                # Check if this was reasoning text that couldn't be parsed
                                if _is_reasoning_text_response(last_response_content):
                                    search_logger.debug(
                                        f"Reasoning text detected but no JSON extracted. Response snippet: {repr(snippet)}"
                                    )
                                else:
                                    search_logger.warning(
                                        f"Failed to parse JSON response from LLM (non-strict attempt). Error: {json_error}. Response snippet: {repr(snippet)}"
                                    )
                                break
                            else:
                                search_logger.error(
                                    f"Strict JSON enforcement still failed to produce valid JSON: {json_error}. Response snippet: {repr(snippet)}"
                                )
                                break

                    elif is_grok_model and attempt < max_retries - 1:
                        search_logger.warning(f"Grok empty response on attempt {attempt + 1}, retrying...")
                        retry_delay *= 2
                        continue
                    else:
                        break

                except Exception as e:
                    if is_grok_model and attempt < max_retries - 1:
                        search_logger.error(f"Grok request failed on attempt {attempt + 1}: {e}, retrying...")
                        retry_delay *= 2
                        continue
                    else:
                        raise

            if is_grok_model:
                elapsed_time = time.time() - start_time
                last_elapsed_time = elapsed_time
                search_logger.debug(f"Grok total response time: {elapsed_time:.2f}s")

            if json_error_occurred:
                if not enforce_json:
                    continue
                else:
                    break

            if response_content_local:
                # We would have returned already on success; if we reach here, parsing failed but we are not retrying
                continue

        response_content = last_response_content
        response = last_response_obj
        elapsed_time = last_elapsed_time if last_elapsed_time is not None else 0.0

        if last_json_error is not None and response_content:
            search_logger.error(
                f"LLM response after strict enforcement was still not valid JSON: {last_json_error}. Clearing response to trigger error handling."
            )
            response_content = ""

        if not response_content:
            search_logger.error(f"Empty response from LLM for model: {model_choice} (provider: {provider})")
            if is_grok_model:
                search_logger.error("Grok empty response debugging:")
                search_logger.error(f"  - Request took: {elapsed_time:.2f}s")
                search_logger.error(f"  - Response status: {getattr(response, 'status_code', 'N/A')}")
                search_logger.error(f"  - Response headers: {getattr(response, 'headers', 'N/A')}")
                search_logger.error(f"  - Full response: {response}")
                search_logger.error(f"  - Response choices length: {len(response.choices) if response.choices else 0}")
                if response.choices:
                    search_logger.error(f"  - First choice: {response.choices[0]}")
                    search_logger.error(f"  - Message content: '{response.choices[0].message.content}'")
                    search_logger.error(f"  - Message role: {response.choices[0].message.role}")
                search_logger.error("Check: 1) API key validity, 2) rate limits, 3) model availability")

                # Implement fallback for Grok failures
                search_logger.warning("Attempting fallback to OpenAI due to Grok failure...")
                try:
                    # Use OpenAI as fallback with similar parameters
                    fallback_params = {
                        "model": "gpt-4o-mini",
                        "messages": request_params["messages"],
                        "temperature": request_params.get("temperature", 0.1),
                        "max_tokens": request_params.get("max_tokens", 500),
                    }

                    async with get_llm_client(provider="openai") as fallback_client:
                        fallback_response = await fallback_client.chat.completions.create(**fallback_params)
                        fallback_content = fallback_response.choices[0].message.content
                        if fallback_content and fallback_content.strip():
                            search_logger.info("gpt-4o-mini fallback succeeded")
                            response_content = fallback_content.strip()
                        else:
                            search_logger.error("gpt-4o-mini fallback also returned empty response")
                            raise ValueError(f"Both {model_choice} and gpt-4o-mini fallback failed")

                except Exception as fallback_error:
                    search_logger.error(f"gpt-4o-mini fallback failed: {fallback_error}")
                    raise ValueError(f"{model_choice} failed and fallback to gpt-4o-mini also failed: {fallback_error}") from fallback_error
            else:
                search_logger.debug(f"Full response object: {response}")
                raise ValueError("Empty response from LLM")

        if not response_content:
            # This should not happen after fallback logic, but safety check
            raise ValueError("No valid response content after all attempts")

        response_content = response_content.strip()
        search_logger.debug(f"LLM API response: {repr(response_content[:200])}...")

        payload = _extract_json_payload(response_content, code, language)
        if payload != response_content:
            search_logger.debug(
                f"Sanitized LLM response payload before parsing: {repr(payload[:200])}..."
            )

        result = json.loads(payload)

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
        # Try to generate context-aware fallback
        try:
            fallback_json = synthesize_json_from_reasoning("", code, language)
            if fallback_json:
                fallback_result = json.loads(fallback_json)
                search_logger.info("Generated context-aware fallback summary")
                return {
                    "example_name": fallback_result.get("example_name", f"Code Example{f' ({language})' if language else ''}"),
                    "summary": fallback_result.get("summary", "Code example for demonstration purposes."),
                }
        except Exception:
            pass  # Fall through to generic fallback

        return {
            "example_name": f"Code Example{f' ({language})' if language else ''}",
            "summary": "Code example for demonstration purposes.",
        }
    except Exception as e:
        search_logger.error(f"Error generating code summary using unified LLM provider: {e}")
        # Try to generate context-aware fallback
        try:
            fallback_json = synthesize_json_from_reasoning("", code, language)
            if fallback_json:
                fallback_result = json.loads(fallback_json)
                search_logger.info("Generated context-aware fallback summary after error")
                return {
                    "example_name": fallback_result.get("example_name", f"Code Example{f' ({language})' if language else ''}"),
                    "summary": fallback_result.get("summary", "Code example for demonstration purposes."),
                }
        except Exception:
            pass  # Fall through to generic fallback

        return {
            "example_name": f"Code Example{f' ({language})' if language else ''}",
            "summary": "Code example for demonstration purposes.",
        }


async def generate_code_summaries_batch(
    code_blocks: list[dict[str, Any]], max_workers: int = None, progress_callback=None, provider: str = None
) -> list[dict[str, str]]:
    """
    Generate summaries for multiple code blocks with rate limiting and proper worker management.

    Args:
        code_blocks: List of code block dictionaries
        max_workers: Maximum number of concurrent API requests
        progress_callback: Optional callback for progress updates (async function)
        provider: LLM provider to use for generation (e.g., 'grok', 'openai', 'anthropic')

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

    # Create a shared LLM client for all summaries (performance optimization)
    async with get_llm_client(provider=provider) as shared_client:
        search_logger.debug("Created shared LLM client for batch summary generation")

        # Semaphore to limit concurrent requests
        semaphore = asyncio.Semaphore(max_workers)
        completed_count = 0
        lock = asyncio.Lock()

        async def generate_single_summary_with_limit(block: dict[str, Any]) -> dict[str, str]:
            nonlocal completed_count
            async with semaphore:
                # Add delay between requests to avoid rate limiting
                await asyncio.sleep(0.5)  # 500ms delay between requests

                # Call async version directly with shared client (no event loop overhead)
                result = await _generate_code_example_summary_async(
                    block["code"],
                    block["context_before"],
                    block["context_after"],
                    block.get("language", ""),
                    provider,
                    shared_client  # Pass shared client for reuse
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
    embedding_provider: str | None = None,
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
        provider: Optional LLM provider used for summary generation tracking
        embedding_provider: Optional embedding provider override for vector generation
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

    # Check if contextual embeddings are enabled (use proper async method like document storage)
    try:
        raw_value = await credential_service.get_credential(
            "USE_CONTEXTUAL_EMBEDDINGS", "false", decrypt=True
        )
        if isinstance(raw_value, str):
            use_contextual_embeddings = raw_value.lower() == "true"
        else:
            use_contextual_embeddings = bool(raw_value)
    except Exception as e:
        search_logger.error(f"DEBUG: Error reading contextual embeddings: {e}")
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

        # Create embeddings for the batch (optionally overriding the embedding provider)
        result = await create_embeddings_batch(batch_texts, provider=embedding_provider)

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

        # Get embedding model name
        embedding_model_name = await get_embedding_model(provider=embedding_provider)

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
                llm_chat_model = await _get_model_choice()
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
        for embedding, text in zip(valid_embeddings, successful_texts, strict=True):
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
                # Skip unsupported dimensions to avoid corrupting the schema
                search_logger.error(
                    f"Unsupported embedding dimension {embedding_dim}; skipping record to prevent column mismatch"
                )
                continue

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
                    await asyncio.sleep(retry_delay)
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
