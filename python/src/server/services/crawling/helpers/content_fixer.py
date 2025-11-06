"""
Content fixing utilities for crawled content.

Handles post-processing of content from Crawl4AI to fix known issues.
"""
import re


def fix_code_span_spaces(markdown: str) -> str:
    """
    Fix spaces inside code spans that Crawl4AI/BeautifulSoup adds when extracting text.

    BeautifulSoup's get_text() adds spaces between nested elements, which corrupts
    code paths and imports like 'next/headers' becoming 'next / headers'.

    Example fixes:
        - 'next / headers' -> 'next/headers'
        - '@/ lib / auth' -> '@/lib/auth'
        - 'server - only' -> 'server-only'

    Args:
        markdown: Markdown content with potential space issues in code blocks

    Returns:
        Cleaned markdown with spaces removed from code paths
    """
    if not markdown:
        return markdown

    # Pattern to match code blocks with language specification
    code_block_pattern = r'```(\w+)?\n(.*?)\n```'

    def fix_code_block(match):
        language = match.group(1) or ''
        code = match.group(2)

        # Fix import/require paths: 'next / headers' -> 'next/headers'
        code = re.sub(r"'([^']*?)\s+/\s+([^']*?)'", r"'\1/\2'", code)
        code = re.sub(r'"([^"]*?)\s+/\s+([^"]*?)"', r'"\1/\2"', code)

        # Fix multiple slashes in paths: 'lib / utils / helper' -> 'lib/utils/helper'
        # Repeat to handle chains
        for _ in range(5):  # Max 5 slashes in a path
            code = re.sub(r"'([^']*?)/\s+([^']*?)'", r"'\1/\2'", code)
            code = re.sub(r'"([^"]*?)/\s+([^"]*?)"', r'"\1/\2"', code)
            code = re.sub(r"'([^']*?)\s+/([^']*?)'", r"'\1/\2'", code)
            code = re.sub(r'"([^"]*?)\s+/([^"]*?)"', r'"\1/\2"', code)

        # Fix @ paths: '@/ lib' -> '@/lib'
        code = re.sub(r"'@\s*/\s+", r"'@/", code)
        code = re.sub(r'"@\s*/\s+', r'"@/', code)

        # Fix server-only and other hyphenated imports: 'server - only' -> 'server-only'
        code = re.sub(r"'([a-z]+)\s+-\s+([a-z]+)'", r"'\1-\2'", code)
        code = re.sub(r'"([a-z]+)\s+-\s+([a-z]+)"', r'"\1-\2"', code)

        return f'```{language}\n{code}\n```'

    # Process all code blocks
    markdown = re.sub(code_block_pattern, fix_code_block, markdown, flags=re.DOTALL)

    return markdown
