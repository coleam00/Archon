"""
Site Configuration Helper

Handles site-specific configurations and detection.
"""
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
from crawl4ai.content_filter_strategy import PruningContentFilter

from ....config.logfire_config import get_logger

logger = get_logger(__name__)


class SiteConfig:
    """Helper class for site-specific configurations."""

    # Common code block selectors for various editors and documentation frameworks
    CODE_BLOCK_SELECTORS = [
        # Milkdown
        ".milkdown-code-block pre",

        # Monaco Editor
        ".monaco-editor .view-lines",

        # CodeMirror
        ".cm-editor .cm-content",
        ".cm-line",

        # Prism.js (used by Docusaurus, Docsify, Gatsby)
        "pre[class*='language-']",
        "code[class*='language-']",
        ".prism-code",

        # highlight.js
        "pre code.hljs",
        ".hljs",

        # Shiki (used by VitePress, Nextra)
        ".shiki",
        "div[class*='language-'] pre",
        ".astro-code",

        # Generic patterns
        "pre code",
        ".code-block",
        ".codeblock",
        ".highlight pre"
    ]

    @staticmethod
    def is_documentation_site(url: str) -> bool:
        """
        Check if URL is likely a documentation site that needs special handling.
        
        Args:
            url: URL to check
            
        Returns:
            True if URL appears to be a documentation site
        """
        doc_patterns = [
            'docs.',
            'documentation.',
            '/docs/',
            '/documentation/',
            'readthedocs',
            'gitbook',
            'docusaurus',
            'vitepress',
            'docsify',
            'mkdocs'
        ]

        url_lower = url.lower()
        return any(pattern in url_lower for pattern in doc_patterns)

    @staticmethod
    def get_markdown_generator():
        """
        Get markdown generator that preserves code blocks.
        
        Returns:
            Configured markdown generator
        """
        return DefaultMarkdownGenerator(
            content_source="html",  # Use raw HTML to preserve code blocks
            options={
                "mark_code": True,         # Mark code blocks properly
                "handle_code_in_pre": True,  # Handle <pre><code> tags
                "body_width": 0,            # No line wrapping
                "skip_internal_links": True,  # Add to reduce noise
                "include_raw_html": False,    # Prevent HTML in markdown
                "escape": False,             # Don't escape special chars in code
                "decode_unicode": True,      # Decode unicode characters
                "strip_empty_lines": False,  # Preserve empty lines in code
                "preserve_code_formatting": True,  # Custom option if supported
                "code_language_callback": lambda el: el.get('class', '').replace('language-', '') if el else ''
            }
        )

    @staticmethod
    def get_link_pruning_markdown_generator():
        """
        Get markdown generator for the recursive crawling strategy that cleans up pages crawled.
        
        Returns:
            Configured markdown generator
        """
        prune_filter = PruningContentFilter(
            threshold=0.2,
            threshold_type="fixed"
        )

        return DefaultMarkdownGenerator(
            content_source="html",  # Use raw HTML to preserve code blocks
            content_filter=prune_filter,
            options={
                "mark_code": True,         # Mark code blocks properly
                "handle_code_in_pre": True,  # Handle <pre><code> tags
                "body_width": 0,            # No line wrapping
                "skip_internal_links": True,  # Add to reduce noise
                "include_raw_html": False,    # Prevent HTML in markdown
                "escape": False,             # Don't escape special chars in code
                "decode_unicode": True,      # Decode unicode characters
                "strip_empty_lines": False,  # Preserve empty lines in code
                "preserve_code_formatting": True,  # Custom option if supported
                "code_language_callback": lambda el: el.get('class', '').replace('language-', '') if el else ''
            }
        )
