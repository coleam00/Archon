# Code Extraction and Parsing

This document describes how Archon identifies, extracts, validates, and stores code examples from crawled websites and uploaded documents.

## Overview

The code extraction system is implemented in two primary service files:

- **`python/src/server/services/crawling/code_extraction_service.py`** - Main extraction logic and validation
- **`python/src/server/services/storage/code_storage_service.py`** - Storage, embedding generation, and AI summarization

The system uses multiple extraction strategies based on content type, performs comprehensive quality validation, and stores code examples with AI-generated summaries and semantic embeddings for intelligent search.

### ⚡ Key Concept: Separate Storage (with Intentional Duplication)

**Code examples are stored in BOTH tables - this is intentional and beneficial:**

| Aspect | Documents (Main Content) | Code Examples |
|--------|-------------------------|---------------|
| **Database Table** | `archon_crawled_pages` | `archon_code_examples` |
| **Content** | Markdown chunks (INCLUDES code blocks with context) | Extracted code blocks ONLY |
| **Code Included?** | ✅ Yes - as fenced blocks (` ```python...``` `) | ✅ Yes - extracted and isolated |
| **Embedding Source** | Full markdown text (context + code + backticks) | Code + AI summary (no backticks, no context) |
| **Metadata** | Document-level metadata | Code-specific metadata (language, example_name) |
| **Search Endpoint** | `/search` (general) | `/search?search_code_examples=true` |
| **Processing Order** | First (chunks, embeddings, storage) | Second (extraction, summaries, embeddings, storage) |
| **Chunking Strategy** | Smart chunking that preserves code blocks intact | N/A - code extracted as complete units |

**Important:** Code blocks appear in BOTH tables, but serve different purposes:

#### In `archon_crawled_pages`:
- **Purpose:** Preserve full context around code
- **Format:** Markdown with backticks, explanatory text before/after
- **Search Use:** "How do I..." / "What is the process for..."
- **Example Result:** Tutorial-style content with code embedded

#### In `archon_code_examples`:
- **Purpose:** Isolated, searchable code examples
- **Format:** Clean code with AI-generated summary
- **Search Use:** "Show me a code example for..." / "Sample code to..."
- **Example Result:** Copy-paste ready code snippets

This duplication enables:
- **Contextual learning** (documents) vs **quick reference** (code examples)
- **Different embedding strategies** (natural language vs code semantics)
- **Specialized search** for code-only queries
- **Code-specific features** (language detection, validation, AI naming)
- **Independent updates** (can re-extract code without re-crawling documents)

## Extraction Strategies

The system employs three distinct extraction strategies depending on the source type. **Importantly, both HTML and markdown versions of crawled pages are available**, but they are tried in priority order for optimal code extraction.

### Extraction Priority Order

For regular web pages:
1. **HTML extraction (PRIMARY)** - Tries HTML patterns first to preserve code block structure and metadata
2. **Markdown extraction (FALLBACK)** - Falls back to markdown triple-backtick extraction if HTML yields no results

For uploaded files:
1. **Text files (.txt, .md)** - Specialized text extraction (backticks, language labels, indented blocks)
2. **PDF files** - Section-based code detection using code vs. prose scoring

### 1. HTML-Based Extraction (Primary Method)

For web pages, the system **first attempts HTML extraction** by matching **30+ HTML patterns** used by popular documentation frameworks and syntax highlighters.

#### Supported Frameworks and Patterns

| Framework/Tool | HTML Pattern Example | Priority |
|---------------|---------------------|----------|
| **GitHub/GitLab** | `<div class="highlight">...<pre><code>` | High |
| **Docusaurus** | `<div class="codeBlockContainer">...<pre class="prism-code">` | High |
| **VitePress** | `<div class="language-*">...<pre>` | High |
| **Prism.js** | `<pre class="language-*"><code>` | High |
| **highlight.js** | `<code class="hljs">` | Medium |
| **Shiki** | `<pre class="shiki"><code>` | Medium |
| **Monaco Editor** | `<div class="monaco-editor"><div class="view-lines">` | Medium |
| **CodeMirror** | `<div class="cm-content"><div class="cm-line">` | Medium |
| **Nextra** | `<div data-nextra-code>...<pre>` | Medium |
| **Astro** | `<pre class="astro-code">` | Medium |
| **Milkdown** | `<pre class="code-block"><code>` | Low |
| **Generic** | `<pre><code>` | Low (Fallback) |

**Pattern Matching Strategy:**
- Patterns are ordered by specificity (most specific first)
- Each pattern extracts:
  - Code content
  - Language identifier (if available)
  - Context before and after the code block
- Overlapping extractions are deduplicated by position

**HTML Cleaning Process:**
```python
# Steps performed during extraction:
1. Decode HTML entities: &lt; → <, &gt; → >, &amp; → &
2. Remove syntax highlighting spans: <span class="token">...</span>
3. Clean CodeMirror/Monaco nested div structures
4. Preserve code formatting and indentation
5. Fix spacing issues from tag removal
```

#### Example: Docusaurus Pattern

```html
<div class="codeBlockContainer">
  <pre class="prism-code language-python">
    <code>
      <span class="token keyword">def</span>
      <span class="token function">hello</span>
      <span class="token punctuation">(</span>
      <span class="token punctuation">)</span>
      <span class="token punctuation">:</span>
    </code>
  </pre>
</div>
```

**Extracted Result:**
```python
{
  "code": "def hello():",
  "language": "python",
  "context_before": "...",
  "context_after": "..."
}
```

### 2. Markdown Extraction (Fallback Method)

**Only used when HTML extraction yields no results.** The system extracts **triple-backtick fenced code blocks** from the markdown-converted content:

**Why HTML is preferred over Markdown:**
- HTML preserves original code block structure (`<pre>`, `<code>` tags)
- Language info is explicit in CSS classes (`language-python`, `hljs typescript`)
- Framework-specific patterns can be detected (Docusaurus, VitePress, etc.)
- Syntax highlighter HTML contains rich metadata
- HTML → Markdown conversion may lose structural information

**When Markdown is used:**
- HTML extraction found no code blocks
- Content is a raw markdown file (.md upload)
- HTML content is not available
- Simpler extraction is sufficient

````markdown
```python
def hello():
    print("Hello, World!")
```
````

**Extraction Features:**
- Detects language from fence (e.g., ` ```python`)
- Extracts context (configurable window size, default: 1000 characters before/after)
- Handles nested/corrupted markdown structures
- Validates code block completeness

**Corrupted Markdown Detection:**
```markdown
# Detects and handles cases like:
```K`
<entire_file_content_here>
```
```

The system recognizes this as corrupted and extracts the inner content.

### 3. Plain Text Extraction (Text Files and PDFs)

For uploaded `.txt`, `.md` files and PDF-extracted text, the system uses three detection methods:

#### Method 1: Triple Backticks
```text
Here's an example:

```typescript
const example = "code";
```
```

#### Method 2: Language Labels
```text
TypeScript:
  const example = "code";
  console.log(example);

Python example:
  def hello():
      print("Hello")
```

#### Method 3: Indented Blocks
```text
Function implementation:

    def process_data(items):
        result = []
        for item in items:
            result.append(transform(item))
        return result
```

**PDF-Specific Extraction:**

PDFs lose markdown formatting during text extraction, so the system:
1. Splits content by double newlines and page breaks
2. Analyzes each section for "code-like" characteristics
3. Scores sections using code vs. prose indicators
4. Extracts sections with high code scores

**Code vs. Prose Scoring:**

```python
# Code indicators (with weights):
- Python imports: from X import Y (weight: 3)
- Function definitions: def func() (weight: 3)
- Class definitions: class Name (weight: 3)
- Method calls: obj.method() (weight: 2)
- Assignments: x = [...] (weight: 2)

# Prose indicators (with weights):
- Articles: the, this, that (weight: 1)
- Sentence endings: . [A-Z] (weight: 2)
- Transition words: however, therefore (weight: 2)

# Section is considered code if:
code_score > prose_score AND code_score > 2
```

## Language Detection

The system detects programming languages using:

### 1. Explicit Language Tags
- HTML: `class="language-python"`
- Markdown: ` ```python`
- Text files: "Python:" or "TypeScript example:"

### 2. Content-Based Detection

When no explicit language is provided, the system analyzes patterns:

```python
LANGUAGE_PATTERNS = {
    "python": [
        r"\bdef\s+\w+\s*\(",      # Function definitions
        r"\bclass\s+\w+",          # Class definitions
        r"\bimport\s+\w+",         # Imports
        r"\bfrom\s+\w+\s+import",  # From imports
    ],
    "javascript": [
        r"\bfunction\s+\w+\s*\(",  # Functions
        r"\bconst\s+\w+\s*=",      # Const declarations
        r"\blet\s+\w+\s*=",        # Let declarations
        r"\bvar\s+\w+\s*=",        # Var declarations
    ],
    "typescript": [
        r"\binterface\s+\w+",      # Interfaces
        r":\s*\w+\[\]",            # Type annotations
        r"\btype\s+\w+\s*=",       # Type aliases
    ],
    # ... more languages
}
```

### 3. Language-Specific Minimum Indicators

Each language has required indicators for validation:

| Language | Required Indicators |
|----------|-------------------|
| TypeScript | `:`, `{`, `}`, `=>`, `interface`, `type` |
| JavaScript | `function`, `{`, `}`, `=>`, `const`, `let` |
| Python | `def`, `:`, `return`, `self`, `import`, `class` |
| Java | `class`, `public`, `private`, `{`, `}`, `;` |
| Rust | `fn`, `let`, `mut`, `impl`, `struct`, `->` |
| Go | `func`, `type`, `struct`, `{`, `}`, `:=` |

## Code Quality Validation

After extraction, every code block undergoes rigorous validation through multiple filters:

### 1. Length Validation

**Dynamic Minimum Length:**

The minimum length adapts based on language and context:

```python
# Base minimum lengths by language:
- JSON/YAML/XML: 100 characters
- HTML/CSS/SQL: 150 characters
- Python/Go: 200 characters
- JavaScript/TypeScript/Rust: 250 characters
- Java/C++: 300 characters

# Context-based adjustments:
- Contains "example", "snippet", "demo": multiply by 0.7
- Contains "implementation", "complete": multiply by 1.5
- Contains "minimal", "simple", "basic": multiply by 0.8

# Configurable bounds: 100-1000 characters
```

**Maximum Length:**
- Default: 5,000 characters
- Prevents extraction of entire files or corrupted content

### 2. Code Indicator Validation

Requires at least **3 code indicators** (configurable via `MIN_CODE_INDICATORS`):

```python
CODE_INDICATORS = {
    "function_calls": r"\w+\s*\([^)]*\)",
    "assignments": r"\w+\s*=\s*.+",
    "control_flow": r"\b(if|for|while|switch|case|try|catch|except)\b",
    "declarations": r"\b(var|let|const|def|class|function|interface|type|struct|enum)\b",
    "imports": r"\b(import|from|require|include|using|use)\b",
    "brackets": r"[\{\}\[\]]",
    "operators": r"[\+\-\*\/\%\&\|\^<>=!]",
    "method_chains": r"\.\w+",
    "arrows": r"(=>|->)",
    "keywords": r"\b(return|break|continue|yield|await|async)\b",
}
```

**Validation Process:**
1. Count matches for each indicator pattern
2. Reject if fewer than minimum required (default: 3)
3. Log which indicators were found for debugging

### 3. Prose Filtering

Rejects blocks that appear to be documentation rather than code:

**Prose Indicators:**
```python
PROSE_PATTERNS = [
    r"\b(the|this|that|these|those|is|are|was|were|will|would|should|could|have|has|had)\b",
    r"[.!?]\s+[A-Z]",  # Sentence endings
    r"\b(however|therefore|furthermore|moreover|nevertheless)\b",
]
```

**Threshold:**
- Default: 15% prose ratio (`MAX_PROSE_RATIO`)
- If `prose_score / word_count > 0.15`, block is rejected

**Example:**
```text
This is a description of how to use the API. You should first
initialize the client, then make requests. The responses will
be in JSON format.
```
This would be rejected (high prose ratio), while:
```python
# Initialize client
client = APIClient()
response = client.get("/users")
data = response.json()
```
This would pass (low prose ratio, high code indicators).

### 4. Diagram Filtering

Filters out ASCII art diagrams and visual representations:

**Diagram Indicators:**
```python
DIAGRAM_CHARS = [
    "┌", "┐", "└", "┘", "│", "─", "├", "┤", "┬", "┴", "┼",  # Box drawing
    "+-+", "|_|", "___", "...",  # ASCII art
    "→", "←", "↑", "↓", "⟶", "⟵",  # Arrows
]
```

**Detection Logic:**
- Count lines with >70% special characters
- Count diagram indicator occurrences
- Reject if `special_char_lines >= 3` OR `diagram_indicators >= 5` AND `code_patterns < 5`

**Example Rejected:**
```text
┌─────────────┐
│   Server    │
│             │
└──────┬──────┘
       │
       ↓
┌─────────────┐
│   Client    │
└─────────────┘
```

### 5. Language-Specific Validation

For detected languages, validates presence of language-specific patterns:

```python
# Example: Python validation
if language == "python":
    required_indicators = ["def", ":", "return", "self", "import", "class"]
    found = sum(1 for indicator in required_indicators if indicator in code.lower())
    
    if found < 2:  # Need at least 2 language-specific indicators
        reject_block()
```

### 6. Structure Validation

Additional structural checks:

- **Minimum lines:** At least 3 non-empty lines
- **Line length:** Reject if >50% of lines exceed 300 characters
- **Comment ratio:** Reject if >70% of lines are comments
- **Bad patterns:** Reject if contains:
  - Unescaped HTML entities (`&lt;`, `&amp;`)
  - Excessive HTML tags
  - Concatenated keywords without spaces (e.g., `fromimport`)

## Code Cleaning Process

Extracted code undergoes cleaning to remove HTML artifacts and fix formatting issues:

### HTML Entity Decoding

```python
REPLACEMENTS = {
    "&lt;": "<",
    "&gt;": ">",
    "&amp;": "&",
    "&quot;": '"',
    "&#39;": "'",
    "&nbsp;": " ",
    "&#x27;": "'",
    "&#x2F;": "/",
}
```

### HTML Tag Removal

```python
# Strategy depends on tag usage:

# 1. Syntax highlighting (no spaces between tags)
if "</span><span" in text:
    # Just remove all spans - they're wrapping individual tokens
    text = re.sub(r"<span[^>]*>", "", text)
    text = re.sub(r"</span>", "", text)

# 2. Normal span usage
else:
    # Add space where needed to prevent concatenation
    text = re.sub(r"</span>(?=[A-Za-z0-9])", " ", text)
    text = re.sub(r"<span[^>]*>", "", text)
```

### Spacing Fixes

Fixes common concatenation issues from tag removal:

```python
SPACING_FIXES = [
    # Import statements
    (r"(\b(?:from|import|as)\b)([A-Za-z])", r"\1 \2"),
    
    # Function/class definitions
    (r"(\b(?:def|class|async|await|return)\b)([A-Za-z])", r"\1 \2"),
    
    # Control flow
    (r"(\b(?:if|elif|else|for|while|try|except)\b)([A-Za-z])", r"\1 \2"),
    
    # Operators (careful with negative numbers)
    (r"([A-Za-z_)])(\+|-|\*|/|=|<|>|%)", r"\1 \2"),
    (r"(\+|-|\*|/|=|<|>|%)([A-Za-z_(])", r"\1 \2"),
]
```

### Language-Specific Fixes

```python
# Python-specific
if language == "python":
    # Fix: "fromxximportyy" → "from xx import yy"
    code = re.sub(r"(\bfrom\b)(\w+)(\bimport\b)", r"\1 \2 \3", code)
    
    # Add missing colons at line ends
    code = re.sub(
        r"(\b(?:def|class|if|elif|else|for|while)\b[^:]+)$",
        r"\1:",
        code,
        flags=re.MULTILINE
    )
```

### Whitespace Normalization

```python
# Process each line individually to preserve indentation
lines = code.split("\n")
cleaned_lines = []

for line in lines:
    stripped = line.lstrip()
    indent = line[:len(line) - len(stripped)]  # Preserve indentation
    
    # Normalize internal spacing
    cleaned = re.sub(r" {2,}", " ", stripped)
    cleaned = cleaned.rstrip()  # Remove trailing spaces
    
    cleaned_lines.append(indent + cleaned)

code = "\n".join(cleaned_lines).strip()
```

## Code Deduplication

The system automatically deduplicates similar code variants (e.g., Python 3.9 vs 3.10 syntax):

### Normalization for Comparison

Before comparing code blocks, they are normalized:

```python
def _normalize_code_for_comparison(code: str) -> str:
    # 1. Normalize whitespace
    normalized = re.sub(r"\s+", " ", code.strip())
    
    # 2. Normalize typing imports
    normalized = re.sub(r"from typing_extensions import", "from typing import", normalized)
    normalized = re.sub(r"Annotated\[\s*([^,\]]+)[^]]*\]", r"\1", normalized)
    
    # 3. Normalize FastAPI parameters
    normalized = re.sub(r":\s*Annotated\[[^\]]+\]\s*=", "=", normalized)
    
    # 4. Normalize trailing commas
    normalized = re.sub(r",\s*\)", ")", normalized)
    
    return normalized
```

### Similarity Calculation

```python
# Uses Python's difflib.SequenceMatcher
similarity = SequenceMatcher(None, normalized1, normalized2).ratio()

# Threshold: 0.85 (85% similarity)
if similarity >= 0.85:
    # Blocks are considered duplicates
```

### Best Variant Selection

When duplicates are found, the system selects the best variant:

```python
def score_block(block):
    score = 0
    
    # Prefer explicit language specification
    if block.get("language") and block["language"] not in ["", "text", "plaintext"]:
        score += 10
    
    # Prefer longer, more comprehensive examples
    score += len(block["code"]) * 0.01
    
    # Prefer blocks with better context
    context_len = len(block.get("context_before", "")) + len(block.get("context_after", ""))
    score += context_len * 0.005
    
    # Slight preference for modern syntax
    if "python 3.10" in block.get("full_context", "").lower():
        score += 5
    
    return score

best_block = max(similar_blocks, key=score_block)
```

**Metadata Tracking:**

The best variant includes metadata about consolidation:

```python
{
    "code": "...",
    "language": "python",
    "consolidated_variants": 3,  # Number of similar variants found
    "variant_languages": ["python", "python3"],  # Languages from all variants
}
```

## AI-Powered Summarization

After extraction and validation, the system generates AI summaries for each code block:

### Summary Generation Process

```python
async def _generate_code_example_summary_async(
    code: str,
    context_before: str,
    context_after: str,
    language: str = "",
    provider: str = None
) -> dict[str, str]:
```

**Prompt Template:**

```xml
<context_before>
{last 500 chars of context before}
</context_before>

<code_example language="{language}">
{first 1500 chars of code}
</code_example>

<context_after>
{first 500 chars of context after}
</context_after>

Based on the code example and its surrounding context, provide:
1. A concise, action-oriented name (1-4 words) that describes what this code DOES
   Good: "Parse JSON Response", "Validate Email", "Connect PostgreSQL"
   Bad: "Function Example", "Code Snippet", "JavaScript Code"
   
2. A summary (2-3 sentences) describing what the code demonstrates

Format as JSON:
{
  "example_name": "Action-oriented name",
  "summary": "Description of what the code demonstrates"
}
```

**LLM Configuration:**

- **Model:** Uses `MODEL_CHOICE` setting (default: `gpt-4o-mini`)
- **Temperature:** 0.3 (consistent, focused responses)
- **Max tokens:** 500
- **Response format:** JSON object
- **Provider:** Unified LLM provider service (supports OpenAI, Anthropic, etc.)

### Batch Processing

Summaries are generated in batches with rate limiting:

```python
async def generate_code_summaries_batch(
    code_blocks: list[dict],
    max_workers: int = 3,  # Configurable via CODE_SUMMARY_MAX_WORKERS
    progress_callback = None
):
    # Use semaphore to limit concurrent requests
    semaphore = asyncio.Semaphore(max_workers)
    
    # Add 500ms delay between requests to avoid rate limiting
    await asyncio.sleep(0.5)
    
    # Process all blocks concurrently but with rate limiting
    summaries = await asyncio.gather(
        *[generate_single_summary_with_limit(block) for block in code_blocks],
        return_exceptions=True
    )
```

**Progress Reporting:**

During batch processing, progress updates are sent:

```python
{
    "status": "code_extraction",
    "percentage": 45,  # (completed / total) * 100
    "log": "Generated 23/50 code summaries",
    "completed_summaries": 23,
    "total_summaries": 50
}
```

### Fallback Handling

If AI summarization fails or is disabled:

```python
{
    "example_name": f"Code Example ({language})" if language else "Code Example",
    "summary": "Code example for demonstration purposes."
}
```

## Storage and Embedding

Code examples are stored in the `archon_code_examples` table with semantic embeddings:

### Embedding Generation

**Combined Text for Embedding:**

```python
combined_text = f"{code}\n\nSummary: {summary}"
```

**Contextual Embeddings (Optional):**

When `USE_CONTEXTUAL_EMBEDDINGS=true`, the system enriches embeddings with full document context:

```python
# Use LLM to create situating context
situating_context = await generate_situating_context(
    full_document=url_to_full_document[url],
    chunk=combined_text
)

# Enhanced embedding input
enhanced_text = f"{situating_context}\n\n{combined_text}"
```

**Embedding Dimensions:**

The system supports multiple embedding dimensions:
- **768** (e.g., all-minilm-L6-v2)
- **1024** (e.g., text-embedding-3-small with 1024 dims)
- **1536** (e.g., text-embedding-ada-002, text-embedding-3-small)
- **3072** (e.g., text-embedding-3-large)

### Database Schema

Each code example is stored with:

```python
{
    "url": str,                    # Source URL
    "chunk_number": int,           # Sequential number for this URL
    "content": str,                # The actual code
    "summary": str,                # AI-generated summary
    "metadata": {                  # JSON object
        "chunk_index": int,
        "url": str,
        "source": str,
        "source_id": str,
        "language": str,
        "char_count": int,
        "word_count": int,
        "example_name": str,
        "title": str,
        "contextual_embedding": bool,  # If contextual embedding used
        "consolidated_variants": int,  # If deduplicated
        "variant_languages": [str]     # Languages from variants
    },
    "source_id": str,              # Domain or identifier
    "embedding_768": vector,       # Embedding (dimension-specific column)
    "embedding_1024": vector,
    "embedding_1536": vector,
    "embedding_3072": vector,
    "llm_chat_model": str,         # Model used for summaries/contextual
    "embedding_model": str,        # Model used for embeddings
    "embedding_dimension": int,    # Actual dimension used
    "created_at": timestamp
}
```

### Batch Insertion

```python
# Insert in batches of 20 (configurable)
batch_size = 20

for i in range(0, total_items, batch_size):
    batch_data = prepare_batch(i, batch_size)
    
    # Retry logic with exponential backoff
    for retry in range(max_retries):
        try:
            client.table("archon_code_examples").insert(batch_data).execute()
            break
        except Exception as e:
            if retry < max_retries - 1:
                await asyncio.sleep(retry_delay)
                retry_delay *= 2  # Exponential backoff
            else:
                # Final attempt: insert individually
                for record in batch_data:
                    client.table("archon_code_examples").insert(record).execute()
```

## Configuration Settings

All code extraction behavior can be tuned via environment variables or the Settings UI:

### Length Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `MIN_CODE_BLOCK_LENGTH` | `250` | Minimum characters for code blocks |
| `MAX_CODE_BLOCK_LENGTH` | `5000` | Maximum characters (prevents corruption) |

### Validation Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `MIN_CODE_INDICATORS` | `3` | Minimum required code indicators |
| `ENABLE_PROSE_FILTERING` | `true` | Filter out documentation text |
| `MAX_PROSE_RATIO` | `0.15` | Maximum allowed prose ratio (15%) |
| `ENABLE_DIAGRAM_FILTERING` | `true` | Filter out ASCII art diagrams |

### Context Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `CONTEXT_WINDOW_SIZE` | `1000` | Characters of context before/after |
| `ENABLE_CONTEXTUAL_LENGTH` | `true` | Adjust min length by context |
| `ENABLE_COMPLETE_BLOCK_DETECTION` | `true` | Find complete code blocks |
| `ENABLE_LANGUAGE_SPECIFIC_PATTERNS` | `true` | Use language-specific validation |

### AI Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `ENABLE_CODE_SUMMARIES` | `true` | Generate AI summaries |
| `CODE_SUMMARY_MAX_WORKERS` | `3` | Concurrent summary requests |
| `MODEL_CHOICE` | `gpt-4o-mini` | Model for summaries |

### Embedding Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `USE_CONTEXTUAL_EMBEDDINGS` | `false` | Enrich embeddings with document context |
| `CONTEXTUAL_EMBEDDINGS_MAX_WORKERS` | `3` | Concurrent contextual requests |

## Processing Pipeline: Documents vs Code Examples

When a website is crawled, the content goes through **two separate pipelines**:

### Pipeline 1: Document Storage (Happens First)

```python
# 1. Crawl website → Get HTML & Markdown
crawl_results = [
    {
        "url": "https://fastapi.tiangolo.com/tutorial/",
        "html": "<div>...</div>",
        "markdown": "# Tutorial\n\nFastAPI is...",
        "title": "Tutorial - FastAPI"
    }
]

# 2. Chunk markdown into manageable pieces (INCLUDES code blocks!)
# Smart chunking breaks at code block boundaries to keep code intact
chunks = [
    "FastAPI is a modern, fast web framework for building APIs with Python...",
    "To create an API, first install FastAPI:\n\n```bash\npip install fastapi\n```\n\nThen create your first app...",
    "Define routes using decorators:\n\n```python\n@app.get(\"/\")\ndef read_root():\n    return {\"Hello\": \"World\"}\n```\n\nThis creates a GET endpoint..."
]

# 3. Create embeddings for each chunk (including embedded code)
chunk_embeddings = create_embeddings_batch(chunks)

# 4. Store in archon_crawled_pages table
await add_documents_to_supabase(
    contents=chunks,
    embeddings=chunk_embeddings,
    table="archon_crawled_pages"
)
```

### Pipeline 2: Code Example Extraction (Happens Second)

```python
# 5. Extract code from HTML (using same crawl_results)
code_blocks = extract_html_code_blocks(html_content)
# Result: [{"code": "from fastapi import...", "language": "python", ...}]

# 6. Generate AI summaries for each code block
summaries = generate_code_summaries_batch(code_blocks)
# Result: [{"example_name": "Create FastAPI App", "summary": "..."}]

# 7. Create embeddings for code + summary
code_embeddings = create_embeddings_batch([
    f"{code}\n\nSummary: {summary}"
    for code, summary in zip(code_blocks, summaries)
])

# 8. Store in archon_code_examples table (separate!)
await add_code_examples_to_supabase(
    code_examples=code_blocks,
    summaries=summaries,
    embeddings=code_embeddings,
    table="archon_code_examples"
)
```

### Why Store Code in Both Places?

**Yes, code appears in BOTH tables - this is a feature, not redundancy!**

1. **Different purposes:**
   - **Documents:** Learning and context ("Here's how to use FastAPI [code] and why it works...")
   - **Code examples:** Quick reference and copy-paste ("Show me the code for X")

2. **Different search semantics:**
   - **Documents:** Natural language queries about concepts
   - **Code examples:** Code-focused queries for specific implementations

3. **Different embeddings:**
   - **Documents:** Embedded as markdown text (optimized for prose + code context)
   - **Code examples:** Embedded as code + AI summary (optimized for code semantics)

4. **Specialized features for code:**
   - Language detection and validation
   - AI-generated example names
   - Code-specific metadata
   - Quality filtering (prose detection, diagram filtering)

5. **Smart chunking preserves code:**
   - Chunks break at code block boundaries (` ``` `)
   - Code blocks stay intact within document chunks
   - Users get context around code when searching documents

6. **Flexibility:**
   - Can re-extract code without re-crawling entire site
   - Can disable code extraction but keep document chunks
   - Can search documents-only, code-only, or both

### Search Behavior

When users search the knowledge base:

```python
# Search documents only (default)
results = search(query="how to use fastapi", search_code_examples=False)
# Returns: Text chunks explaining FastAPI concepts

# Search code examples only
results = search(query="fastapi route example", search_code_examples=True)
# Returns: Actual code blocks with @app.get() decorators

# Search both (when enabled)
results = search(query="fastapi tutorial", search_both=True)
# Returns: Mixed results from both tables
```

## Complete Extraction Flow

Here's a step-by-step example of the complete process:

### Example: Crawling FastAPI Documentation

**1. Crawl Page**
```
URL: https://fastapi.tiangolo.com/tutorial/first-steps/
```

**2. Detect Framework**
```python
# System detects: Docusaurus + Prism.js
wait_selector = ".markdown, .theme-doc-markdown, article"
```

**3. Extract HTML Code Block**
```html
<div class="codeBlockContainer">
  <pre class="prism-code language-python">
    <code>
      <span class="token keyword">from</span>
      <span class="token">fastapi</span>
      <span class="token keyword">import</span>
      <span class="token">FastAPI</span>
      ...
    </code>
  </pre>
</div>
```

**4. Clean Code**
```python
# Before cleaning:
"<span class=\"token keyword\">from</span><span class=\"token\">fastapi</span>"

# After cleaning:
"from fastapi import FastAPI"
```

**5. Validate Quality**
```python
✓ Length: 342 characters (>250 minimum)
✓ Code indicators: 8 found (function, import, =, (), return, {}, :, def)
✓ Language indicators: 3 found (from, import, def)
✓ Prose ratio: 0.05 (<0.15 threshold)
✓ Structure: 12 non-empty lines
```

**6. Check for Duplicates**
```python
# Found similar block with 0.87 similarity (Python 3.9 syntax)
# Selected current block (has Python 3.10+ syntax, longer)
```

**7. Generate AI Summary**
```python
# LLM Request
{
  "model": "gpt-4o-mini",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant..."
    },
    {
      "role": "user",
      "content": "<context_before>...</context_before><code_example>...</code_example>"
    }
  ]
}

# Response
{
  "example_name": "Create Basic FastAPI App",
  "summary": "Demonstrates how to create a minimal FastAPI application with a single GET endpoint. Shows the basic structure including importing FastAPI, creating an app instance, and defining a route with the @app.get() decorator."
}
```

**8. Create Embedding**
```python
# Combined text for embedding
combined = """from fastapi import FastAPI

app = FastAPI()

@app.get("/")
def read_root():
    return {"Hello": "World"}

Summary: Demonstrates how to create a minimal FastAPI application..."""

# Generate embedding (1536 dimensions)
embedding = await create_embeddings_batch([combined])
```

**9. Store in Database**
```python
{
  "url": "https://fastapi.tiangolo.com/tutorial/first-steps/",
  "chunk_number": 0,
  "content": "from fastapi import FastAPI\n\napp = FastAPI()...",
  "summary": "Demonstrates how to create a minimal FastAPI application...",
  "metadata": {
    "language": "python",
    "char_count": 342,
    "word_count": 48,
    "example_name": "Create Basic FastAPI App",
    "title": "Create Basic FastAPI App",
    "source_id": "fastapi.tiangolo.com",
    "chunk_index": 0
  },
  "source_id": "fastapi.tiangolo.com",
  "embedding_1536": [0.123, -0.456, 0.789, ...],
  "llm_chat_model": "gpt-4o-mini",
  "embedding_model": "text-embedding-3-small",
  "embedding_dimension": 1536
}
```

**10. Enable Semantic Search**

User can now search:
- "how to create a fastapi endpoint"
- "basic fastapi hello world"
- "fastapi route decorator example"

The system will find this code example through semantic similarity matching.

## Performance Optimizations

### Concurrent Processing

- **HTML extraction:** Processes multiple patterns in parallel
- **Code summaries:** Concurrent with rate limiting (default: 3 workers)
- **Embeddings:** Batch processing with configurable batch size
- **Storage:** Batch inserts (default: 20 records per batch)

### Progress Reporting

The system reports detailed progress at each phase:

```python
# Phase 1: Extraction (0-20%)
{
    "status": "code_extraction",
    "progress": 15,
    "log": "Extracted code from 3/20 documents (12 code blocks found)",
    "completed_documents": 3,
    "total_documents": 20,
    "code_blocks_found": 12
}

# Phase 2: Summarization (20-90%)
{
    "status": "code_extraction",
    "progress": 55,
    "log": "Generated 7/12 code summaries",
    "completed_summaries": 7,
    "total_summaries": 12
}

# Phase 3: Storage (90-100%)
{
    "status": "code_extraction",
    "progress": 95,
    "log": "Stored batch 1/1 of code examples",
    "batch_number": 1,
    "total_batches": 1,
    "examples_stored": 12
}
```

### Caching

- Settings are cached to avoid repeated database lookups
- Language patterns are compiled once and reused
- HTML entity replacements use pre-built mapping

## Error Handling

The system follows Archon's beta development guidelines:

### Fail Fast Scenarios

- **Missing crawler instance:** Immediate error
- **Invalid configuration:** Raises exception
- **Corrupted data:** Skips with detailed error log

### Complete with Logging

- **Individual extraction failures:** Logs error, continues to next document
- **Summary generation failures:** Uses fallback summary, continues
- **Embedding failures:** Logs error, continues to next batch
- **Storage failures:** Retries with exponential backoff, then individual inserts

### Error Messages

All errors include:
- Operation being attempted
- URL or document identifier
- Specific error details
- Stack trace (via `exc_info=True`)

**Example Error Log:**

```
ERROR: Failed to extract code from document
  URL: https://example.com/docs/api
  Error: TimeoutError after 30 seconds
  Attempt: 2/3
  Stack trace: ...
```

## Related Files

### Core Implementation

- **`python/src/server/services/crawling/code_extraction_service.py`**
  - Main extraction logic
  - Quality validation
  - HTML/markdown/text/PDF extraction strategies

- **`python/src/server/services/storage/code_storage_service.py`**
  - Markdown code block extraction
  - AI summary generation
  - Deduplication logic
  - Embedding generation and storage

### Supporting Services

- **`python/src/server/services/embeddings/embedding_service.py`**
  - Embedding generation
  - Batch processing

- **`python/src/server/services/embeddings/contextual_embedding_service.py`**
  - Contextual embedding enrichment
  - Situating context generation

- **`python/src/server/services/llm_provider_service.py`**
  - Unified LLM client
  - Provider management (OpenAI, Anthropic, etc.)

### Integration Points

- **`python/src/server/services/crawling/orchestrator.py`**
  - Orchestrates crawling and code extraction
  - Progress tracking across all phases

- **`python/src/server/services/storage/storage_services.py`**
  - Document upload handling
  - Code extraction trigger for uploaded files

### Database

- **`migration/complete_setup.sql`**
  - `archon_code_examples` table schema
  - Indexes for semantic search
  - Vector search functions

## Testing Code Extraction

To test code extraction with different settings:

```python
# In Python REPL or test file
from python.src.server.services.crawling.code_extraction_service import CodeExtractionService
from python.src.server.config.supabase_config import get_supabase_client

# Initialize
client = get_supabase_client()
service = CodeExtractionService(client)

# Test HTML extraction
html_content = """
<div class="language-python">
  <pre><code>def hello():
    print("World")
</code></pre>
</div>
"""

code_blocks = await service._extract_html_code_blocks(html_content)
print(f"Found {len(code_blocks)} code blocks")

# Test markdown extraction
from python.src.server.services.storage.code_storage_service import extract_code_blocks

md_content = """
Here's an example:

```python
def hello():
    print("World")
```
"""

blocks = extract_code_blocks(md_content, min_length=50)
print(f"Found {len(blocks)} markdown code blocks")
```

## Best Practices

### For Documentation Sites

1. **Use standard syntax highlighters** (Prism.js, highlight.js, Shiki)
2. **Include language identifiers** in code blocks
3. **Provide context** around code examples (explanatory text)
4. **Keep examples focused** (200-500 lines ideal)
5. **Use semantic HTML** (`<pre><code>` structure)

### For Code Authors

1. **Add descriptive comments** near code examples
2. **Use clear variable names** for better AI summarization
3. **Structure examples** with clear beginning/end
4. **Avoid very long examples** (>5000 characters)
5. **Include language tags** in markdown fences

### For Configuration

1. **Start with defaults** - they work well for most cases
2. **Increase `MIN_CODE_BLOCK_LENGTH`** if getting too many snippets
3. **Decrease `MIN_CODE_INDICATORS`** for configuration files (JSON, YAML)
4. **Enable `USE_CONTEXTUAL_EMBEDDINGS`** for better semantic search
5. **Adjust `CODE_SUMMARY_MAX_WORKERS`** based on API rate limits

## Troubleshooting

### No Code Examples Extracted

**Possible causes:**
1. Code blocks are too short (< `MIN_CODE_BLOCK_LENGTH`)
2. Content appears as prose (high prose ratio)
3. HTML pattern not recognized
4. Code lacks required indicators

**Solutions:**
- Check logs for validation failures
- Lower `MIN_CODE_BLOCK_LENGTH` temporarily
- Disable `ENABLE_PROSE_FILTERING` for testing
- Add custom HTML pattern if needed

### Extracting Non-Code Content

**Possible causes:**
1. `MIN_CODE_INDICATORS` too low
2. Prose filtering disabled
3. Diagram filtering disabled

**Solutions:**
- Increase `MIN_CODE_INDICATORS` to 4 or 5
- Enable `ENABLE_PROSE_FILTERING`
- Enable `ENABLE_DIAGRAM_FILTERING`
- Check logs to see what passed validation

### Too Many Duplicate Examples

**Possible causes:**
1. Similar examples from different pages
2. Similarity threshold too high

**Solutions:**
- System already deduplicates at 85% similarity
- Duplication across pages is intentional (different context)
- Lower similarity threshold in code (requires code change)

### AI Summaries Not Generating

**Possible causes:**
1. `ENABLE_CODE_SUMMARIES` is false
2. LLM API key not configured
3. Rate limiting issues

**Solutions:**
- Check `ENABLE_CODE_SUMMARIES` setting
- Verify LLM provider credentials
- Increase `CODE_SUMMARY_MAX_WORKERS` delay
- Check logs for API errors

## Future Enhancements

Potential improvements for code extraction:

1. **Machine Learning Classification**
   - Train model to classify code vs. prose
   - Better language detection

2. **Code Quality Scoring**
   - Rank examples by completeness
   - Prefer executable examples

3. **Code Execution Validation**
   - Test if code actually runs
   - Verify imports are valid

4. **Interactive Example Detection**
   - Identify REPL/playground examples
   - Extract input/output pairs

5. **Code Relationship Mapping**
   - Link related examples
   - Track dependencies between code blocks

6. **Custom Extraction Rules**
   - User-defined HTML patterns
   - Site-specific extraction logic
   - Per-source configuration

---

**Document Version:** 1.0  
**Last Updated:** October 2025  
**Related Documentation:**
- [Single Page Crawling Strategy](SINGLE_PAGE_CRAWLING.md)
- [Architecture Overview](ARCHITECTURE.md)

