# Open WebUI + Continue.dev Integration Setup Guide

_Complete step-by-step implementation guide for IDE-based Archon RAG access_
_Updated: 2025-09-06_

## Overview

This guide provides complete instructions for integrating Open WebUI with Continue.dev to access the Archon RAG knowledge base directly from your IDE. You'll be able to query your knowledge base, get code examples, and access documentation without leaving your development environment.

## Prerequisites

### System Requirements
- Open WebUI running locally (typically http://localhost:3000)
- Archon RAG system operational (http://localhost:8181)
- VS Code or compatible IDE
- Administrative access to Open WebUI
- Node.js and npm (for potential troubleshooting)

### Version Compatibility
- **Continue.dev**: v0.8.55 or earlier (recommended for best compatibility)
- **Open WebUI**: v0.3.35 or later
- **VS Code**: Latest stable version

## Integration Method 1: Direct API Connection (Quick Setup)

This method provides basic integration between Continue.dev and Open WebUI without custom tools.

### Step 1: Generate Open WebUI API Key

1. Open your Open WebUI instance (http://localhost:3000)
2. Navigate to **Settings** → **Account**
3. Scroll down to **API Keys** section
4. Click **Create new secret key**
5. Copy the generated key (format: `sk-xxxxxx`)
6. Store securely - this key won't be shown again

### Step 2: Install Continue.dev Extension

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "Continue - Ship faster with continuous AI"
4. Click **Install**
5. Restart VS Code if prompted

### Step 3: Configure Continue.dev

1. Press `Ctrl+Shift+P` to open command palette
2. Type "Continue: Open configuration file"
3. Replace the contents with this configuration:

```yaml
name: Open WebUI Integration
version: 1.0.0
schema: v1
models:
  # Main chat model through Open WebUI
  - name: Local Assistant
    provider: openai
    model: llama3.1:latest  # Replace with your actual model name
    apiBase: http://localhost:3000/api
    apiKey: sk-your-open-webui-api-key-here  # Replace with your key
    roles:
      - chat
      - edit
    defaultCompletionOptions:
      temperature: 0.7
      maxTokens: 4096
      contextLength: 8192
    systemMessage: |
      You are a helpful coding assistant with access to a local knowledge base.
      Provide clear, concise answers and include code examples when relevant.
      
  # Optional: Dedicated autocomplete model
  - name: Code Autocomplete
    provider: openai
    model: codellama:7b-code  # Use smaller model for autocomplete
    apiBase: http://localhost:3000/api
    apiKey: sk-your-open-webui-api-key-here
    roles:
      - autocomplete
    defaultCompletionOptions:
      temperature: 0.2
      maxTokens: 500
    autocompleteOptions:
      debounceDelay: 500
      maxPromptTokens: 1024
      prefixPercentage: 0.85

# Context providers (what information to include in queries)
contextProviders:
  - name: code
    params:
      includeTypes: [".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java", ".cpp", ".c", ".h"]
  - name: diff
  - name: terminal
  - name: problems
  - name: folder
    params:
      maxDepth: 3

# Slash commands for quick actions
slashCommands:
  - name: edit
    description: Edit code using AI
  - name: comment
    description: Add comments to code
  - name: share
    description: Share code snippet
  - name: cmd
    description: Generate terminal commands
```

### Step 4: Test Basic Integration

1. Open a code file in VS Code
2. Press `Ctrl+I` or click the Continue icon in the sidebar
3. Type a test message: "Hello, can you help me with Python code?"
4. Verify that you get a response from your local model through Open WebUI

## Integration Method 2: Custom Tool Integration (Recommended)

This method provides full access to the Archon RAG system through a custom Open WebUI tool.

### Step 1: Create Archon RAG Tool in Open WebUI

1. Open Open WebUI admin panel (http://localhost:3000)
2. Navigate to **Workspace** → **Tools**
3. Click **Create New Tool**
4. Paste this complete tool code:

```python
import requests
import json
import asyncio
import os
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field

class Tools:
    """
    Archon RAG Connector for Open WebUI - IDE Integration
    Provides seamless access to Archon knowledge base from Continue.dev
    """

    class Valves(BaseModel):
        """Configuration settings for Archon RAG connector"""
        ARCHON_BASE_URL: str = Field(
            default=os.getenv("ARCHON_BASE_URL", "http://localhost:8181"),
            description="Base URL for Archon server"
        )
        ARCHON_TIMEOUT_MS: int = Field(
            default=int(os.getenv("ARCHON_TIMEOUT_MS", "15000")),
            description="Request timeout in milliseconds"
        )
        ARCHON_MAX_RESULTS: int = Field(
            default=int(os.getenv("ARCHON_MAX_RESULTS", "5")),
            description="Maximum number of RAG results to return (1-20)"
        )
        ARCHON_API_KEY: str = Field(
            default=os.getenv("ARCHON_API_KEY", ""),
            description="API key for Archon authentication (if required)"
        )
        ENABLE_CODE_FOCUS: bool = Field(
            default=True,
            description="Enable code-focused result formatting for IDE use"
        )
        ENABLE_CITATIONS: bool = Field(
            default=True,
            description="Include source citations in responses"
        )

    def __init__(self):
        """Initialize the Archon RAG connector"""
        self.valves = self.Valves()
        self.citation = True
        self._cache = {}

    async def on_valves_updated(self):
        """Called when tool configuration is updated"""
        print("Archon RAG IDE Connector configuration updated")
        self._cache.clear()

    def get_headers(self) -> Dict[str, str]:
        """Get HTTP headers for Archon API requests"""
        headers = {"Content-Type": "application/json"}
        if self.valves.ARCHON_API_KEY:
            headers["Authorization"] = f"Bearer {self.valves.ARCHON_API_KEY}"
        return headers

    async def search_knowledge_base(
        self,
        query: str,
        source: Optional[str] = None,
        match_count: Optional[int] = None,
        __user__: Optional[dict] = None,
        __event_emitter__: Optional[callable] = None
    ) -> str:
        """
        Search Archon knowledge base for code examples, documentation, and technical information
        
        Perfect for IDE use - finds relevant code snippets, documentation, and examples
        
        Args:
            query (str): Search query - describe what you're looking for
            source (str, optional): Specific source to search (use get_sources to see available)
            match_count (int, optional): Number of results (1-20, default from settings)
            
        Returns:
            str: Formatted results with code examples and documentation
        """
        try:
            # Validate inputs
            if not query or not query.strip():
                return "❌ **Error**: Please provide a search query"

            final_source = source or None
            final_match_count = match_count or self.valves.ARCHON_MAX_RESULTS
            final_match_count = max(1, min(20, final_match_count))

            # Check cache for IDE performance
            cache_key = f"search:{query[:50]}:{final_source}:{final_match_count}"
            if cache_key in self._cache:
                if __event_emitter__:
                    await __event_emitter__({
                        "type": "status",
                        "data": {"description": "Retrieved from cache", "done": True}
                    })
                return f"🔄 **(Cached Result)**\n\n{self._cache[cache_key]}"

            # Start search
            if __event_emitter__:
                await __event_emitter__({
                    "type": "status",
                    "data": {
                        "description": f"Searching knowledge base for: {query[:50]}...",
                        "done": False
                    }
                })

            # Prepare request
            request_body = {
                "query": query,
                "match_count": final_match_count
            }
            if final_source:
                request_body["source"] = final_source

            # Make API request
            timeout = self.valves.ARCHON_TIMEOUT_MS / 1000.0
            response = requests.post(
                f"{self.valves.ARCHON_BASE_URL}/api/rag/query",
                json=request_body,
                headers=self.get_headers(),
                timeout=timeout
            )

            if not response.ok:
                error_detail = "Unknown error"
                try:
                    error_data = response.json()
                    error_detail = error_data.get("detail", error_data.get("error", f"HTTP {response.status_code}"))
                except:
                    error_detail = f"HTTP {response.status_code}"

                return f"❌ **Search Error**: {error_detail}\n\n**Debug Info:**\n- Archon URL: `{self.valves.ARCHON_BASE_URL}`\n- Source: `{final_source or 'all sources'}`\n- Timeout: {timeout}s"

            data = response.json()
            results = data.get("results", [])

            if not results:
                return f"📭 **No Results Found**\n\nNo information found for: **\"{query}\"**\n\n**Suggestions:**\n- Try different keywords\n- Broaden your search terms\n- Check if relevant documents are indexed\n- Use `get_sources` to see available knowledge sources"

            # Format results for IDE use
            formatted_result = self.format_ide_results(results, query, final_source)

            # Cache result (limit cache size)
            if len(self._cache) > 10:
                oldest_key = next(iter(self._cache))
                del self._cache[oldest_key]
            self._cache[cache_key] = formatted_result

            if __event_emitter__:
                await __event_emitter__({
                    "type": "status",
                    "data": {
                        "description": f"Found {len(results)} relevant results",
                        "done": True
                    }
                })

            return formatted_result

        except requests.exceptions.Timeout:
            return f"⏱️ **Timeout**: Archon didn't respond within {self.valves.ARCHON_TIMEOUT_MS/1000}s\n\n**Solutions:**\n- Check Archon server performance\n- Increase timeout in tool settings\n- Reduce match_count parameter"

        except requests.exceptions.ConnectionError:
            return f"🔌 **Connection Error**: Cannot reach Archon server\n\n**Check:**\n- Archon server is running at `{self.valves.ARCHON_BASE_URL}`\n- Network connectivity\n- Firewall settings"

        except Exception as e:
            return f"💥 **Error**: {str(e)}\n\n**Actions:**\n- Verify tool configuration\n- Check Archon server status\n- Review server logs for details"

    async def get_code_examples(
        self,
        query: str,
        language: Optional[str] = None,
        match_count: Optional[int] = None,
        __user__: Optional[dict] = None,
        __event_emitter__: Optional[callable] = None
    ) -> str:
        """
        Search specifically for code examples and snippets
        
        Args:
            query (str): What kind of code examples you need
            language (str, optional): Programming language filter (python, javascript, etc.)
            match_count (int, optional): Number of examples to return
            
        Returns:
            str: Code examples with explanations and usage context
        """
        try:
            if __event_emitter__:
                await __event_emitter__({
                    "type": "status",
                    "data": {
                        "description": f"Searching for {language or 'code'} examples...",
                        "done": False
                    }
                })

            # Enhance query for code search
            enhanced_query = query
            if language:
                enhanced_query = f"{language} {query}"

            # Use Archon's code examples endpoint if available
            request_body = {
                "query": enhanced_query,
                "match_count": match_count or self.valves.ARCHON_MAX_RESULTS
            }

            response = requests.post(
                f"{self.valves.ARCHON_BASE_URL}/api/rag/code-examples",
                json=request_body,
                headers=self.get_headers(),
                timeout=self.valves.ARCHON_TIMEOUT_MS / 1000.0
            )

            if not response.ok:
                # Fallback to regular search with code focus
                return await self.search_knowledge_base(
                    f"code example {enhanced_query}",
                    match_count=match_count,
                    __user__=__user__,
                    __event_emitter__=__event_emitter__
                )

            data = response.json()
            results = data.get("results", [])

            if not results:
                return f"📭 **No Code Examples Found**\n\nNo {language or 'code'} examples found for: **\"{query}\"**\n\n**Try:**\n- More specific function/method names\n- Different programming language\n- Broader search terms"

            # Format code examples specifically
            formatted = f"# 💻 Code Examples: {query}\n"
            if language:
                formatted += f"**Language:** {language}\n"
            formatted += f"**Found:** {len(results)} example(s)\n\n"

            for i, result in enumerate(results, 1):
                content = result.get("content", "").strip()
                metadata = result.get("metadata", {})
                url = metadata.get("url", "")
                score = result.get("similarity", 0)
                
                formatted += f"## Example {i} (Relevance: {score:.1%})\n\n"
                
                if url:
                    formatted += f"**Source:** [{url}]({url})\n\n"
                
                # Extract code blocks if present
                if "```" in content:
                    formatted += f"{content}\n\n"
                else:
                    formatted += f"```{language or ''}\n{content}\n```\n\n"
                
                formatted += "---\n\n"

            return formatted

        except Exception as e:
            return f"💥 **Error getting code examples**: {str(e)}"

    async def get_sources(
        self,
        __user__: Optional[dict] = None,
        __event_emitter__: Optional[callable] = None
    ) -> str:
        """
        Get list of available knowledge sources in Archon
        
        Returns:
            str: Available sources that can be used with the source parameter
        """
        try:
            if __event_emitter__:
                await __event_emitter__({
                    "type": "status",
                    "data": {"description": "Fetching available sources...", "done": False}
                })

            response = requests.get(
                f"{self.valves.ARCHON_BASE_URL}/api/rag/sources",
                headers=self.get_headers(),
                timeout=self.valves.ARCHON_TIMEOUT_MS / 1000.0
            )

            if not response.ok:
                return f"❌ Error fetching sources: HTTP {response.status_code}"

            data = response.json()
            sources = data.get("sources", [])

            if not sources:
                return "📭 No sources available in Archon knowledge base"

            result = "# 📚 Available Knowledge Sources\n\n"
            for source in sources:
                source_id = source.get("source_id", "Unknown")
                title = source.get("title", source_id)
                doc_count = source.get("document_count", "Unknown")

                result += f"- **{title}** (`{source_id}`)\n"
                if doc_count != "Unknown":
                    result += f"  - Documents: {doc_count}\n"
                result += "\n"

            result += "\n💡 **Usage:**\n"
            result += "- Use source IDs in search: `search_knowledge_base('your query', source='source_id')`\n"
            result += "- Search all sources by omitting the source parameter\n"

            return result

        except Exception as e:
            return f"💥 Error fetching sources: {str(e)}"

    def format_ide_results(self, results: List[dict], query: str, source: Optional[str] = None) -> str:
        """Format results optimally for IDE consumption"""
        
        header = f"# 🔍 Knowledge Base Search Results\n\n"
        header += f"**Query:** \"{query}\"\n"
        if source:
            header += f"**Source:** `{source}`\n"
        header += f"**Results:** {len(results)}\n\n---\n\n"

        formatted_results = []
        for i, result in enumerate(results, 1):
            content = result.get("content", "").strip()
            metadata = result.get("metadata", {})
            url = metadata.get("url", metadata.get("source_url", ""))
            score = result.get("similarity", 0)
            source_id = metadata.get("source_id", "Unknown Source")

            # Format for IDE readability
            result_text = f"## [{i}] {source_id}"
            if score:
                result_text += f" (Relevance: {score:.1%})"
            result_text += "\n\n"

            if self.valves.ENABLE_CITATIONS and url:
                result_text += f"**🔗 Source:** [{url}]({url})\n\n"

            # Format content based on type
            if self.valves.ENABLE_CODE_FOCUS and ("def " in content or "function " in content or "class " in content):
                # Code-focused formatting
                result_text += "**📝 Code:**\n"
                if "```" not in content:
                    # Try to detect language and wrap
                    lang = self.detect_language(content)
                    result_text += f"```{lang}\n{content}\n```\n\n"
                else:
                    result_text += f"{content}\n\n"
            else:
                # Documentation/text formatting
                result_text += "**📝 Content:**\n"
                # Truncate very long content for IDE readability
                if len(content) > 600:
                    truncated = content[:600] + "..."
                    result_text += f"> {truncated}\n\n"
                    result_text += f"*[Content truncated - see source for full text]*\n\n"
                else:
                    result_text += f"> {content}\n\n"

            # Add metadata if useful
            if metadata.get("title") and metadata["title"] != source_id:
                result_text += f"**Title:** {metadata['title']}\n\n"

            result_text += "---\n\n"
            formatted_results.append(result_text)

        # Add helpful footer for IDE users
        footer = "## 💡 IDE Integration Tips\n\n"
        footer += "- **Follow-up questions**: Ask about specific code examples or concepts\n"
        footer += "- **Code refinement**: \"Show me more examples like result [1]\"\n"
        footer += "- **Implementation help**: \"How would I implement this in my project?\"\n"
        footer += "- **Related concepts**: \"What related patterns should I know?\"\n\n"

        return header + "".join(formatted_results) + footer

    def detect_language(self, content: str) -> str:
        """Simple language detection for code formatting"""
        content_lower = content.lower()
        
        if "def " in content or "import " in content or "print(" in content:
            return "python"
        elif "function " in content or "const " in content or "let " in content:
            return "javascript"
        elif "public class" in content or "private " in content:
            return "java"
        elif "#include" in content or "int main" in content:
            return "cpp"
        elif "package " in content or "func " in content:
            return "go"
        else:
            return ""
```

5. Set the tool name to: **"Archon RAG IDE Connector"**
6. Set the description to: **"Search knowledge base for code examples and documentation directly from your IDE"**
7. Click **Save Tool**

### Step 2: Configure Tool Settings

1. Go to **Workspace** → **Tools** → **Archon RAG IDE Connector** → **Settings** (gear icon)
2. Configure the following values:
   - **ARCHON_BASE_URL**: `http://localhost:8181` (or your Archon server URL)
   - **ARCHON_TIMEOUT_MS**: `15000`
   - **ARCHON_MAX_RESULTS**: `5`
   - **ARCHON_API_KEY**: Leave empty unless Archon requires authentication
   - **ENABLE_CODE_FOCUS**: `true`
   - **ENABLE_CITATIONS**: `true`
3. Click **Save Configuration**

### Step 3: Enable Tool for Models

1. Go to **Workspace** → **Models**
2. Find your main model (e.g., llama3.1:latest)
3. Click the **Tools** icon next to the model
4. Enable **Archon RAG IDE Connector**
5. Click **Save**

### Step 4: Update Continue.dev Configuration

Replace your Continue.dev config.yaml with this enhanced version:

```yaml
name: Open WebUI + Archon RAG Integration
version: 1.0.0
schema: v1
models:
  # Main chat model with RAG capabilities
  - name: IDE Assistant with RAG
    provider: openai
    model: llama3.1:latest  # Replace with your model
    apiBase: http://localhost:3000/api
    apiKey: sk-your-open-webui-api-key-here
    roles:
      - chat
      - edit
    capabilities:
      - tool_use  # Enable function calling
    defaultCompletionOptions:
      temperature: 0.3  # Lower temperature for more focused responses
      maxTokens: 8192
      contextLength: 16384
    systemMessage: |
      You are an expert coding assistant with access to a comprehensive knowledge base through the Archon RAG system.
      
      When users ask about:
      - Code examples or implementations
      - Documentation or explanations
      - Best practices or patterns
      - Troubleshooting help
      
      ALWAYS use the available tools to search the knowledge base first:
      - Use 'search_knowledge_base' for general queries
      - Use 'get_code_examples' for specific code examples
      - Use 'get_sources' to see what knowledge sources are available
      
      Format responses to be helpful for IDE users:
      - Include runnable code examples
      - Provide clear explanations
      - Reference source materials when available
      - Suggest related concepts or patterns
      
      Always cite your sources and indicate when information comes from the knowledge base vs. your general training.

  # Optional: Dedicated autocomplete model
  - name: Fast Autocomplete
    provider: openai
    model: codellama:7b-code
    apiBase: http://localhost:3000/api
    apiKey: sk-your-open-webui-api-key-here
    roles:
      - autocomplete
    defaultCompletionOptions:
      temperature: 0.1
      maxTokens: 200
    autocompleteOptions:
      debounceDelay: 300
      maxPromptTokens: 1000

# Enhanced context providers for better code understanding
contextProviders:
  - name: code
    params:
      includeTypes: [".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java", ".cpp", ".c", ".h", ".md", ".json", ".yaml", ".yml"]
      maxFileSize: 100000
  - name: diff
  - name: terminal
    params:
      maxLines: 100
  - name: problems
  - name: folder
    params:
      maxDepth: 2
      includeHidden: false
  - name: codebase
    params:
      nRetrieve: 25
      useEmbeddings: true

# Custom slash commands for RAG operations
slashCommands:
  - name: search
    description: "Search knowledge base for information"
  - name: examples
    description: "Find code examples for a concept"
  - name: docs
    description: "Look up documentation"
  - name: explain
    description: "Explain code or concepts using knowledge base"

# IDE-optimized rules
rules:
  - "Always search the knowledge base before providing code examples"
  - "Include source citations when referencing knowledge base results" 
  - "Format code examples to be immediately usable in the current project context"
  - "When multiple solutions exist, present the most relevant one first based on the current codebase"
  - "Provide brief explanations focused on practical implementation"
```

### Step 5: Test Integration

1. **Basic Tool Test**: In Open WebUI web interface:
   - Send message: "Use the search tool to find Python async examples"
   - Verify the tool is automatically invoked and returns results

2. **IDE Integration Test**: In VS Code:
   - Press `Ctrl+I` to open Continue chat
   - Ask: "Find examples of error handling in Python from our knowledge base"
   - Verify that the assistant uses the RAG tool and returns relevant results

3. **Code Context Test**:
   - Open a Python file in VS Code
   - Select some code and press `Ctrl+I`
   - Ask: "How can I improve this code based on our documented best practices?"

## Advanced Configuration Options

### Environment Variables Setup

Create a `.env` file for your development environment:

```bash
# Archon RAG Configuration
ARCHON_BASE_URL=http://localhost:8181
ARCHON_TIMEOUT_MS=20000
ARCHON_MAX_RESULTS=7
ARCHON_API_KEY=your-archon-api-key-if-needed

# Open WebUI Configuration
OPEN_WEBUI_URL=http://localhost:3000
OPEN_WEBUI_API_KEY=sk-your-generated-api-key

# Continue.dev Configuration
CONTINUE_CONFIG_PATH=~/.continue/config.yaml
```

### Multiple Model Configuration

For different use cases, you can configure multiple models:

```yaml
models:
  # Primary coding assistant
  - name: Main Assistant
    provider: openai
    model: llama3.1:8b-instruct
    apiBase: http://localhost:3000/api
    apiKey: ${OPEN_WEBUI_API_KEY}
    roles: [chat, edit]
    capabilities: [tool_use]
    
  # Fast autocomplete
  - name: Code Completion
    provider: openai
    model: codellama:7b-code
    apiBase: http://localhost:3000/api
    apiKey: ${OPEN_WEBUI_API_KEY}
    roles: [autocomplete]
    
  # Documentation-focused model
  - name: Documentation Helper
    provider: openai
    model: mistral:7b-instruct
    apiBase: http://localhost:3000/api
    apiKey: ${OPEN_WEBUI_API_KEY}
    roles: [chat]
    capabilities: [tool_use]
    systemMessage: |
      You specialize in finding and explaining documentation.
      Always use the knowledge base tools for accurate, up-to-date information.
```

### Custom Context Providers

You can create custom context providers for specific project needs:

```yaml
contextProviders:
  - name: docs
    params:
      directory: "./docs"
      includeTypes: [".md", ".mdx", ".rst"]
  - name: tests
    params:
      directory: "./tests"
      includeTypes: [".py", ".js", ".test.ts"]
  - name: config
    params:
      files: ["package.json", "pyproject.toml", "Cargo.toml", ".env.example"]
```

## Troubleshooting Common Issues

### Issue 1: Tool Not Being Called

**Symptoms**: Assistant doesn't use the RAG tool automatically

**Solutions**:
1. Verify tool is enabled for the model in Open WebUI
2. Check that `capabilities: [tool_use]` is in config.yaml
3. Test tool manually in Open WebUI first
4. Add explicit instructions in systemMessage
5. Try asking: "Use the search tool to find..."

### Issue 2: Poor Results Quality

**Symptoms**: RAG results are irrelevant or low-quality

**Solutions**:
1. Adjust `ARCHON_MAX_RESULTS` (try 3-10)
2. Use more specific search terms
3. Check Archon knowledge base indexing
4. Verify source documents are properly processed
5. Use the `get_sources` tool to see available knowledge

### Issue 3: Connection Timeouts

**Symptoms**: Requests timing out, connection errors

**Solutions**:
1. Increase `ARCHON_TIMEOUT_MS` to 30000 or higher
2. Check Archon server performance and logs
3. Verify network connectivity between services
4. Test with curl commands first
5. Monitor resource usage (CPU, memory)

### Issue 4: Authentication Errors

**Symptoms**: 401/403 errors, authentication failures

**Solutions**:
1. Regenerate Open WebUI API key
2. Verify API key format (should start with `sk-`)
3. Check environment variables are loaded correctly
4. Test API key with curl
5. Ensure user has proper permissions in Open WebUI

### Issue 5: Autocomplete Not Working

**Symptoms**: Code completion broken or inappropriate

**Solutions**:
1. Use Continue.dev v0.8.55 or earlier
2. Configure separate autocomplete model
3. Adjust `autocompleteOptions` in config.yaml
4. Check Open WebUI model supports completion format
5. Monitor token usage and performance

## Performance Optimization

### Caching Strategy

The custom tool includes built-in caching. To optimize:

1. **Cache Size**: Tool caches 10 recent queries
2. **Cache Keys**: Based on query + source + match_count
3. **Manual Cache Clear**: Tool configuration updates clear cache
4. **Performance**: Cached results return instantly

### Response Time Optimization

1. **Reduce Match Count**: Use 3-5 results for faster responses
2. **Source Filtering**: Use specific sources when possible
3. **Concurrent Models**: Use dedicated autocomplete model
4. **Context Limiting**: Limit context provider scope

### Token Usage Optimization

```yaml
defaultCompletionOptions:
  maxTokens: 4096        # Reasonable limit
  contextLength: 8192    # Sufficient for most queries
  temperature: 0.3       # Focused responses
```

## Security Considerations

### API Key Management

1. **Environment Variables**: Store keys in `.env` files
2. **Key Rotation**: Regularly rotate API keys
3. **Access Control**: Limit API key permissions
4. **Monitoring**: Monitor API key usage

### Network Security

1. **Local Only**: Keep services on localhost for development
2. **Firewall Rules**: Configure appropriate firewall rules
3. **TLS/HTTPS**: Use HTTPS in production environments
4. **Access Logs**: Monitor access logs for suspicious activity

### Data Privacy

1. **Local Processing**: All processing happens locally
2. **No External Calls**: No data sent to external services
3. **Audit Trail**: Log queries for security auditing
4. **Data Retention**: Configure appropriate data retention policies

## Maintenance and Updates

### Regular Maintenance Tasks

1. **Update Models**: Keep AI models updated
2. **Clean Cache**: Clear caches periodically
3. **Monitor Performance**: Track response times and accuracy
4. **Review Logs**: Check for errors and issues
5. **Update Dependencies**: Keep tools and extensions updated

### Backup and Recovery

1. **Configuration Backup**: Save config.yaml files
2. **API Keys**: Secure backup of API keys
3. **Knowledge Base**: Backup Archon knowledge base
4. **Tool Code**: Version control custom tools

### Monitoring and Metrics

Track these key metrics:
- Query response time
- Knowledge base hit rate
- Tool invocation frequency
- Error rates and types
- User satisfaction with results

---

## Summary

This setup guide provides three integration approaches:

1. **Quick Setup**: Direct API connection for basic functionality
2. **Recommended Setup**: Custom tool integration for full RAG access
3. **Advanced Setup**: Multiple models and optimized configurations

The custom tool integration method is recommended for production use, providing the best balance of functionality, performance, and user experience. With proper setup, you'll have seamless access to your Archon knowledge base directly from your IDE, enhancing your development workflow significantly.

For ongoing support and updates, refer to the companion research document and community resources.