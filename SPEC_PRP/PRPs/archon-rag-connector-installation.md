# Archon RAG Connector - Installation & Usage Guide

## Quick Start

### Prerequisites

1. **Archon Server** running on `http://localhost:8181` (or your custom URL)
2. **Open WebUI** v0.6+ installed and running
3. Access to Open WebUI's admin interface

### Installation Steps

1. **Copy the Tool Code**
   - Open `archon-rag-connector-tool.py` 
   - Copy the entire Python code

2. **Install in Open WebUI**
   - Navigate to Open WebUI interface
   - Go to **Workspace** → **Tools**
   - Click **"+ Create New Tool"**
   - Paste the copied code
   - Give it a name: "Archon RAG Connector"
   - Add description: "Query Archon knowledge base for relevant information"
   - Click **Save**

3. **Configure Settings**
   - After saving, click on the tool to open settings
   - Configure the Valves (settings):
     - `ARCHON_BASE_URL`: Your Archon server URL (default: `http://localhost:8181`)
     - `ARCHON_TIMEOUT_MS`: Request timeout in milliseconds (default: 15000)
     - `ARCHON_MAX_RESULTS`: Maximum results per query (default: 5)
     - `ARCHON_DEFAULT_SOURCE`: Optional default source filter
     - `ARCHON_API_KEY`: API key if your Archon requires authentication
     - `ENABLE_STREAMING`: Enable real-time result streaming (default: true)
     - `ENABLE_CACHING`: Cache results for repeated queries (default: true)

4. **Enable for Models**
   - In the tool settings, select which models can use this tool:
     - ✅ Enable for GPT-4o (recommended - supports function calling)
     - ✅ Enable for Claude models
     - ✅ Enable for other models as needed
   - Or enable globally for all models

## Usage

### Automatic Function Calling

Once installed and enabled, the AI model will automatically use the tool when appropriate:

```
User: "What does our documentation say about authentication?"
AI: [Automatically calls archon_rag_query] 
     Here's what I found about authentication...
     [Citations and results displayed]
```

### Manual Tool Invocation

You can also explicitly request the tool:

```
User: "Use archon_rag_query to find information about user permissions"
```

### Available Functions

1. **archon_rag_query** - Main RAG search
   ```
   Parameters:
   - query: Your search question
   - source: Optional source ID filter
   - match_count: Number of results (1-20)
   ```

2. **get_available_sources** - List all knowledge sources
   ```
   No parameters required
   Returns list of available sources with IDs
   ```

3. **archon_code_search** - Search for code examples
   ```
   Parameters:
   - query: Code-related search
   - language: Optional language filter
   - limit: Maximum examples to return
   ```

## Docker Configuration

If running Open WebUI and Archon in Docker:

### Same Docker Network

```yaml
# docker-compose.yml
services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:latest
    environment:
      - ARCHON_BASE_URL=http://archon-server:8181
    networks:
      - archon-network

  archon-server:
    image: archon:latest
    networks:
      - archon-network

networks:
  archon-network:
    driver: bridge
```

### Different Networks/Hosts

Use host networking or explicit IPs:
- From Open WebUI container: `http://host.docker.internal:8181`
- Or use the host's IP address

## Testing the Integration

### 1. Test Connection

In Open WebUI chat:
```
User: "Use get_available_sources to list all sources"
```

Expected: List of available sources from Archon

### 2. Test Query

```
User: "What information do we have about [your topic]?"
```

Expected: AI automatically uses the tool and returns citations

### 3. Test Specific Source

```
User: "Search for [topic] in source [source_id]"
```

Expected: Filtered results from specific source

## Troubleshooting

### Connection Issues

**Error:** "Cannot connect to Archon"
- Verify Archon is running: `curl http://localhost:8181/health`
- Check Docker networking if using containers
- Verify firewall/security group settings

**Error:** "Timeout"
- Increase `ARCHON_TIMEOUT_MS` in tool settings
- Check Archon server performance
- Reduce `match_count` for faster responses

### No Results

**Error:** "No results found"
- Verify documents are indexed in Archon
- Use `get_available_sources()` to check available sources
- Try broader search terms
- Remove source filters

### Authentication Issues

**Error:** "Unauthorized"
- Add `ARCHON_API_KEY` in tool settings
- Verify API key is correct
- Check Archon authentication configuration

## Advanced Configuration

### Environment Variables

Set these in your Open WebUI Docker container:

```bash
ARCHON_BASE_URL=http://archon-server:8181
ARCHON_TIMEOUT_MS=30000
ARCHON_MAX_RESULTS=10
ARCHON_API_KEY=your-api-key-here
```

### Caching Configuration

Adjust cache behavior:
- `ENABLE_CACHING`: Turn on/off result caching
- `CACHE_TTL_SECONDS`: How long to cache results (default: 300)

### Streaming Configuration

For better UX with long results:
- `ENABLE_STREAMING`: Enable progressive result display
- Results stream in real-time with status updates

## Performance Tips

1. **Use Source Filters**: Query specific sources for faster results
2. **Optimize Match Count**: Lower counts = faster responses
3. **Enable Caching**: Reduces load for repeated queries
4. **Configure Timeouts**: Balance between reliability and speed

## Security Considerations

1. **API Keys**: Store securely, never commit to version control
2. **Network Security**: Use HTTPS in production
3. **Access Control**: Limit tool to authorized users/models
4. **Data Privacy**: Be aware of what data is being queried

## Support

- **Archon Issues**: Check Archon logs and documentation
- **Open WebUI Issues**: Check Open WebUI settings and logs
- **Tool Issues**: Review tool configuration and this guide

## Version Compatibility

- **Open WebUI**: v0.6+
- **Archon**: v2.0+
- **Python**: Uses Open WebUI's built-in Python environment

## Next Steps

1. Test with different query types
2. Configure for your specific use case
3. Monitor performance and adjust settings
4. Consider adding custom sources to Archon