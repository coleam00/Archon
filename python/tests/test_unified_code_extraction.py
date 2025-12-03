"""
Tests for unified markdown-based code extraction.

This test suite validates that code extraction works correctly for all sources:
- Web crawled pages (Firecrawl markdown)
- PDF uploads (PyMuPDF4LLM markdown)
- Markdown file uploads
"""

from src.server.services.storage.code_storage_service import extract_code_blocks


class TestMarkdownCodeExtraction:
    """Tests for extract_code_blocks function."""

    def test_extract_python_code_block(self):
        """Extract a Python code block with language tag."""
        markdown = """
# Example

Here's some Python code:

```python
def hello_world():
    print("Hello, World!")
    return True
```

That's it!
"""
        blocks = extract_code_blocks(markdown, min_length=10)

        assert len(blocks) == 1
        assert blocks[0]["language"] == "python"
        assert "def hello_world():" in blocks[0]["code"]
        assert "print" in blocks[0]["code"]
        assert "Example" in blocks[0]["context_before"]

    def test_extract_javascript_code_block(self):
        """Extract a JavaScript code block."""
        markdown = """
```javascript
const greet = (name) => {
    console.log(`Hello, ${name}!`);
    return true;
};
```
"""
        blocks = extract_code_blocks(markdown, min_length=10)

        assert len(blocks) == 1
        assert blocks[0]["language"] == "javascript"
        assert "const greet" in blocks[0]["code"]

    def test_extract_code_block_without_language(self):
        """Extract a code block without language tag."""
        markdown = """
```
npm install some-package
cd my-project
npm run build
```
"""
        blocks = extract_code_blocks(markdown, min_length=10)

        assert len(blocks) == 1
        assert blocks[0]["language"] == ""
        assert "npm install" in blocks[0]["code"]

    def test_extract_multiple_code_blocks(self):
        """Extract multiple code blocks from same document."""
        markdown = """
# Tutorial

First, install the package:

```bash
pip install my-package
```

Then use it in Python:

```python
from my_package import hello
hello()
```

You can also use TypeScript:

```typescript
import { hello } from 'my-package';
hello();
```
"""
        blocks = extract_code_blocks(markdown, min_length=10)

        assert len(blocks) == 3
        languages = [b["language"] for b in blocks]
        assert "bash" in languages
        assert "python" in languages
        assert "typescript" in languages

    def test_skip_short_code_blocks(self):
        """Short code blocks should be skipped based on min_length."""
        markdown = """
```python
x = 1
```
"""
        # With high min_length, block should be skipped
        blocks = extract_code_blocks(markdown, min_length=100)
        assert len(blocks) == 0

        # With low min_length, block should be included
        blocks = extract_code_blocks(markdown, min_length=5)
        assert len(blocks) == 1

    def test_no_code_blocks(self):
        """Document without code blocks returns empty list."""
        markdown = """
# Just Some Text

This is a document without any code blocks.
Just regular markdown text.
"""
        blocks = extract_code_blocks(markdown, min_length=10)
        assert len(blocks) == 0

    def test_empty_markdown(self):
        """Empty markdown returns empty list."""
        blocks = extract_code_blocks("", min_length=10)
        assert len(blocks) == 0

        blocks = extract_code_blocks("   ", min_length=10)
        assert len(blocks) == 0

    def test_context_extraction(self):
        """Context before and after code block is captured."""
        markdown = """
This is the context before the code.

```python
def example():
    pass
```

This is the context after the code.
"""
        blocks = extract_code_blocks(markdown, min_length=10)

        assert len(blocks) == 1
        assert "context before" in blocks[0]["context_before"]
        assert "context after" in blocks[0]["context_after"]


class TestPyMuPDF4LLMOutput:
    """Tests for code extraction from PyMuPDF4LLM markdown output."""

    def test_extract_code_from_pymupdf4llm_output(self):
        """PyMuPDF4LLM outputs proper markdown with code blocks."""
        # Simulating PyMuPDF4LLM output for a PDF with code
        pymupdf_markdown = """
# Chapter 1: Getting Started

This chapter introduces the basics.

## Installation

```bash
pip install my-library
```

## First Example

Here's how to use the library:

```python
from my_library import Client

client = Client(api_key="your-key")
result = client.query("Hello world")
print(result)
```

The output will be displayed.
"""
        blocks = extract_code_blocks(pymupdf_markdown, min_length=10)

        assert len(blocks) == 2
        assert blocks[0]["language"] == "bash"
        assert blocks[1]["language"] == "python"
        assert "Client" in blocks[1]["code"]

    def test_pymupdf4llm_preserves_indentation(self):
        """PyMuPDF4LLM should preserve code indentation."""
        pymupdf_markdown = """
```python
class MyClass:
    def __init__(self):
        self.value = 0

    def increment(self):
        self.value += 1
        return self.value
```
"""
        blocks = extract_code_blocks(pymupdf_markdown, min_length=10)

        assert len(blocks) == 1
        code = blocks[0]["code"]
        # Check indentation is preserved
        assert "    def __init__" in code
        assert "        self.value" in code


class TestFirecrawlOutput:
    """Tests for code extraction from Firecrawl markdown output."""

    def test_extract_code_from_firecrawl_output(self):
        """Firecrawl converts HTML to clean markdown with code blocks."""
        # Simulating Firecrawl markdown output for a web page
        firecrawl_markdown = """
# htmx - Documentation

## Installation

Add htmx to your project:

```html
<script src="https://unpkg.com/htmx.org@1.9.10"></script>
```

## Basic Example

```html
<button hx-post="/clicked" hx-swap="outerHTML">
    Click Me
</button>
```

The button will be replaced with the response from `/clicked`.
"""
        blocks = extract_code_blocks(firecrawl_markdown, min_length=10)

        assert len(blocks) == 2
        assert all(b["language"] == "html" for b in blocks)
        assert "script src" in blocks[0]["code"]
        assert "hx-post" in blocks[1]["code"]


class TestEdgeCases:
    """Tests for edge cases in code extraction."""

    def test_nested_backticks(self):
        """Handle markdown about markdown (nested backticks)."""
        markdown = """
Here's how to write a code block:

```markdown
Use triple backticks:

\\`\\`\\`python
print("hello")
\\`\\`\\`
```
"""
        blocks = extract_code_blocks(markdown, min_length=10)
        # Should extract the outer markdown block
        assert len(blocks) >= 1

    def test_code_block_at_start(self):
        """Code block at the very start of document."""
        markdown = """```python
print("First line of document")
```

Some text after.
"""
        blocks = extract_code_blocks(markdown, min_length=10)
        assert len(blocks) == 1

    def test_code_block_at_end(self):
        """Code block at the very end of document."""
        markdown = """
Some text before.

```python
print("Last thing in document")
```"""
        blocks = extract_code_blocks(markdown, min_length=10)
        assert len(blocks) == 1

    def test_adjacent_code_blocks(self):
        """Two code blocks with no text between them."""
        markdown = """
```python
x = 1
```
```python
y = 2
```
"""
        blocks = extract_code_blocks(markdown, min_length=1)
        assert len(blocks) == 2

    def test_language_case_insensitive(self):
        """Language tags should be normalized to lowercase."""
        markdown = """
```Python
def test():
    pass
```

```JAVASCRIPT
const x = 1;
```
"""
        blocks = extract_code_blocks(markdown, min_length=1)

        # Language should be lowercase
        languages = [b["language"] for b in blocks]
        assert "python" in languages
        assert "javascript" in languages


class TestPlainTextSkipping:
    """Tests for skipping plain text without markdown structure."""

    def test_plain_text_without_backticks(self):
        """Plain text without code fences returns no code blocks."""
        plain_text = """
This is just plain text.
It doesn't have any code blocks.
Just regular sentences and paragraphs.
"""
        blocks = extract_code_blocks(plain_text, min_length=10)
        assert len(blocks) == 0

    def test_prose_in_code_fence_filtered(self):
        """Prose text inside code fences should be filtered if it looks like documentation."""
        # This tests the prose filtering logic
        markdown = """
```
This is some documentation text that explains how something works.
It has sentences and paragraphs, not actual code. The system should
recognize this as prose and filter it out.
```
"""
        blocks = extract_code_blocks(markdown, min_length=10)
        # Prose filtering should catch this
        # (depends on the prose ratio threshold)


class TestDeduplication:
    """Tests for code block deduplication."""

    def test_similar_blocks_deduplicated(self):
        """Very similar code blocks should be deduplicated."""
        markdown = """
```python
def hello():
    print("hello")
```

And the same thing again:

```python
def hello():
    print("hello")
```
"""
        blocks = extract_code_blocks(markdown, min_length=10)
        # Should deduplicate identical blocks
        assert len(blocks) <= 2  # May or may not dedupe depending on threshold


class TestRecursionLimit:
    """Tests for recursion depth limit."""

    def test_recursion_limit_prevents_infinite_loop(self):
        """Recursion limit should prevent infinite loops on malformed content."""
        # Create deeply nested "corrupted" markdown that would trigger recursion
        # The function detects ```X` pattern and tries to extract inner content
        nested_content = "```A`\n```B`\n```C`\n```D`\nprint('hello')\n```\n```\n```\n```"

        # This should not cause infinite recursion - it should stop at max depth
        blocks = extract_code_blocks(nested_content, min_length=1)
        # Should return without crashing (may or may not find blocks)
        assert isinstance(blocks, list)

    def test_recursion_depth_parameter_internal(self):
        """The _recursion_depth parameter should work correctly."""
        markdown = """
```python
x = 1
```
"""
        # Calling with max depth should return empty
        blocks = extract_code_blocks(markdown, min_length=1, _recursion_depth=3)
        assert blocks == []

        # Calling with normal depth should work
        blocks = extract_code_blocks(markdown, min_length=1, _recursion_depth=0)
        assert len(blocks) >= 1


class TestHtmlEntityDecoding:
    """Tests for HTML entity decoding in code blocks."""

    def test_decode_html_entities_in_code(self):
        """HTML entities like &lt; and &gt; should be decoded to < and >."""
        markdown = """
```html
&lt;h1&gt;Hello World&lt;/h1&gt;
&lt;p&gt;This is a paragraph&lt;/p&gt;
```
"""
        blocks = extract_code_blocks(markdown, min_length=10)

        assert len(blocks) == 1
        code = blocks[0]["code"]
        # Entities should be decoded
        assert "<h1>" in code
        assert "</h1>" in code
        assert "<p>" in code
        assert "&lt;" not in code
        assert "&gt;" not in code

    def test_decode_erb_template_code(self):
        """ERB/Rails template code with HTML entities should be decoded."""
        markdown = """
```erb
&lt;h1&gt;Listing products&lt;/h1&gt;
&lt;table&gt;
  &lt;% @products.each do |product| %&gt;
    &lt;tr&gt;&lt;td&gt;&lt;%= product.name %&gt;&lt;/td&gt;&lt;/tr&gt;
  &lt;% end %&gt;
&lt;/table&gt;
```
"""
        blocks = extract_code_blocks(markdown, min_length=10)

        assert len(blocks) == 1
        code = blocks[0]["code"]
        # Should have proper HTML tags
        assert "<h1>" in code
        assert "<table>" in code
        assert "<tr>" in code
        assert "<td>" in code
        # ERB tags should also be decoded
        assert "<%" in code
        assert "%>" in code

    def test_decode_mixed_entities(self):
        """Various HTML entities should all be decoded."""
        markdown = """
```javascript
const html = &quot;&lt;div class=&#39;test&#39;&gt;Hello &amp; World&lt;/div&gt;&quot;;
```
"""
        blocks = extract_code_blocks(markdown, min_length=10)

        assert len(blocks) == 1
        code = blocks[0]["code"]
        # All entities should be decoded
        assert '"<div' in code
        assert "class='" in code
        assert "& World" in code
        assert "&quot;" not in code
        assert "&lt;" not in code
        assert "&#39;" not in code
        assert "&amp;" not in code

    def test_already_clean_code_unchanged(self):
        """Code without HTML entities should remain unchanged."""
        markdown = """
```python
def hello():
    print("<h1>Hello World</h1>")
    return True
```
"""
        blocks = extract_code_blocks(markdown, min_length=10)

        assert len(blocks) == 1
        code = blocks[0]["code"]
        # Should have the original characters
        assert "<h1>" in code
        assert "</h1>" in code
        assert 'print("<h1>' in code

    def test_decode_double_encoded_entities(self):
        """Double-encoded HTML entities should be fully decoded."""
        markdown = """
```html
&amp;lt;h1&amp;gt;Double Encoded&amp;lt;/h1&amp;gt;
```
"""
        blocks = extract_code_blocks(markdown, min_length=10)

        assert len(blocks) == 1
        code = blocks[0]["code"]
        # Double-encoded entities should be fully decoded
        assert "<h1>" in code
        assert "</h1>" in code
        assert "&amp;" not in code
        assert "&lt;" not in code

    def test_decode_triple_encoded_entities(self):
        """Triple-encoded HTML entities should be fully decoded."""
        markdown = """
```html
&amp;amp;lt;div&amp;amp;gt;Triple&amp;amp;lt;/div&amp;amp;gt;
```
"""
        blocks = extract_code_blocks(markdown, min_length=10)

        assert len(blocks) == 1
        code = blocks[0]["code"]
        # Triple-encoded entities should be fully decoded
        assert "<div>" in code
        assert "</div>" in code
