"""
Code Storage Service

Handles extraction and storage of code examples from documents.
"""

import asyncio
import json
import os
import re
from collections.abc import Callable
from difflib import SequenceMatcher
from typing import Any
from urllib.parse import urlparse

from supabase import Client

from ...config.logfire_config import search_logger
from ..embeddings.contextual_embedding_service import generate_contextual_embeddings_batch
from ..embeddings.embedding_service import create_embeddings_batch


def _get_model_choice() -> str:
    """Get MODEL_CHOICE with direct fallback."""
    try:
        # Direct cache/env fallback
        from ..credential_service import credential_service

        if credential_service._cache_initialized and "MODEL_CHOICE" in credential_service._cache:
            model = credential_service._cache["MODEL_CHOICE"]
        else:
            model = os.getenv("MODEL_CHOICE", "gpt-4.1-nano")
        search_logger.debug(f"Using model choice: {model}")
        return model
    except Exception as e:
        search_logger.warning(f"Error getting model choice: {e}, using default")
        return "gpt-4.1-nano"


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
        from ...services.credential_service import credential_service

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
        # Get LLM client using fallback
        try:
            import os

            import openai

            api_key = os.getenv("OPENAI_API_KEY")
            if not api_key:
                # Try to get from credential service with direct fallback
                from ..credential_service import credential_service

                if (
                    credential_service._cache_initialized
                    and "OPENAI_API_KEY" in credential_service._cache
                ):
                    cached_key = credential_service._cache["OPENAI_API_KEY"]
                    if isinstance(cached_key, dict) and cached_key.get("is_encrypted"):
                        api_key = credential_service._decrypt_value(cached_key["encrypted_value"])
                    else:
                        api_key = cached_key
                else:
                    api_key = os.getenv("OPENAI_API_KEY", "")

            if not api_key:
                raise ValueError("No OpenAI API key available")

            client = openai.OpenAI(api_key=api_key)
        except Exception as e:
            search_logger.error(
                f"Failed to create LLM client fallback: {e} - returning default values"
            )
            return {
                "example_name": f"Code Example{f' ({language})' if language else ''}",
                "summary": "Code example for demonstration purposes.",
            }

        search_logger.debug(
            f"Calling OpenAI API with model: {model_choice}, language: {language}, code length: {len(code)}"
        )

        response = client.chat.completions.create(
            model=model_choice,
            messages=[
                {
                    "role": "system",
                    "content": "You are a helpful assistant that analyzes code examples and provides JSON responses with example names and summaries.",
                },
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
        )

        response_content = response.choices[0].message.content.strip()
        search_logger.debug(f"OpenAI API response: {repr(response_content[:200])}...")

        result = json.loads(response_content)

        # Validate the response has the required fields
        if not result.get("example_name") or not result.get("summary"):
            search_logger.warning(f"Incomplete response from OpenAI: {result}")

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
            f"Failed to parse JSON response from OpenAI: {e}, Response: {repr(response_content) if 'response_content' in locals() else 'No response'}"
        )
        return {
            "example_name": f"Code Example{f' ({language})' if language else ''}",
            "summary": "Code example for demonstration purposes.",
        }
    except Exception as e:
        search_logger.error(f"Error generating code example summary: {e}, Model: {model_choice}")
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
            from ...services.credential_service import credential_service

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
        from ..credential_service import credential_service

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
        for j in range(i, batch_end):
            # Validate inputs
            code = code_examples[j] if isinstance(code_examples[j], str) else str(code_examples[j])
            summary = summaries[j] if isinstance(summaries[j], str) else str(summaries[j])

            if not code:
                search_logger.warning(f"Empty code at index {j}, skipping...")
                continue

            combined_text = f"{code}\n\nSummary: {summary}"
            combined_texts.append(combined_text)

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
        for j, (embedding, text) in enumerate(
            zip(valid_embeddings, successful_texts, strict=False)
        ):
            # Find the original index
            orig_idx = None
            for k, orig_text in enumerate(batch_texts):
                if orig_text == text:
                    orig_idx = k
                    break

            if orig_idx is None:
                search_logger.warning("Could not map embedding back to original code example")
                continue

            idx = i + orig_idx  # Get the global index

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
        })
