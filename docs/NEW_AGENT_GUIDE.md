# Guide to Creating a New Agent in Archon

This guide provides step-by-step instructions for adding a new agent type to the Archon framework. Following these steps will allow you to create a specialized agent that can access its own documentation source and provide tailored responses.

## Table of Contents

1. [Overview of Agent Architecture](#overview-of-agent-architecture)
2. [Step 1: Create Agent Implementation](#step-1-create-agent-implementation)
3. [Step 2: Create Documentation Crawler](#step-2-create-documentation-crawler)
4. [Step 3: Update Archon Graph](#step-3-update-archon-graph)
5. [Step 4: Update the UI](#step-4-update-the-ui)
6. [Step 5: Testing Your Agent](#step-5-testing-your-agent)
7. [Troubleshooting](#troubleshooting)

## Overview of Agent Architecture

The Archon framework supports multiple specialized agents that can access different documentation sources through a Supabase vector database. Each agent consists of:

1. **Agent Implementation** - Core functionality and tools (e.g., `example_coder.py`)
2. **Documentation Crawler** - A script that processes and embeds documentation (e.g., `crawl_example_docs.py`)
3. **Integration with ArchonGraph** - For workflow and state management

The system differentiates between agents using the `agent_type` field in the agent state and a source filter in the Supabase database.

## Step 1: Create Agent Implementation

Start by creating a new file `archon/your_agent_coder.py` based on the template in `docs/agent_template/example_coder.py`:

1. Define dependencies:
```python
@dataclass
class YourAgentDeps:
    supabase: Client
    openai_client: AsyncOpenAI
    reasoner_output: str
```

2. Initialize the agent:
```python
your_agent_coder = Agent[YourAgentDeps]()
```

3. Implement standard tools:
   - `retrieve_relevant_documentation()` - For semantic search
   - `list_documentation_pages()` - To list all documentation pages
   - `get_page_content()` - To fetch a specific page

4. Set source filter to a unique value (e.g., "your_agent_docs")

## Step 2: Create Documentation Crawler

Create `archon/crawl_your_agent_docs.py` based on the template in `docs/agent_template/crawl_example_docs.py`:

1. Implement functions to:
<!-- currently using requests but need to start using crawl4ai see https://pypi.org/project/Crawl4AI/ and use crawl4ai_example_docs.py -->
   - Fetch documentation from the appropriate source  
   - Process and chunk content
   - Generate embeddings
   - Store in Supabase with the correct source filter

2. Expose key functions that will be used by the UI:
   - `start_crawl_with_requests()` - To trigger crawling
   - `clear_existing_records()` - To remove old records

## Step 3: Update Archon Graph

Modify `archon/archon_graph.py` to include your new agent:

1. Import your agent:
```python
from archon.your_agent_coder import your_agent_coder, YourAgentDeps, list_documentation_pages_helper as your_agent_list_docs
```

2. Update `define_scope_with_reasoner()` to include your agent:
```python
elif agent_type == "Your Agent Name":
    # Get Your Agent documentation pages
    documentation_pages = await your_agent_list_docs(supabase)
    source_filter = "your_agent_docs"
```

3. Update `coder_agent()` to use your agent:
```python
elif agent_type == "Your Agent Name":
    # Initialize Your Agent
    deps = YourAgentDeps(
        supabase=supabase,
        openai_client=openai_client,
        reasoner_output=state.get("scope", "")
    )
    # Run Your Agent
    result = await your_agent_coder.arun(
        user_message,
        deps=deps,
        stream_handler=stream_handler
    )
```

## Step 4: Update the UI

Modify `streamlit_ui.py` to include your new agent:

1. Update agent options:
```python
agent_options = ["", "Pydantic AI Agent", "Supabase Agent", "Your Agent Name"]
```

2. Update the documentation tab to include your agent's crawler:
```python
from archon.crawl_your_agent_docs import start_crawl_with_requests as start_your_agent_crawl, clear_existing_records as clear_your_agent_records

# In documentation_tab function:
if docs_tab == "Your Agent Docs":
    # UI for managing your agent's documentation
```

## Step 5: Testing Your Agent

1. Crawl your documentation source first:
   - Go to the Documentation tab
   - Select your agent's documentation tab
   - Click "Crawl" to populate the database

2. Test basic functionality:
   - Go to the Chat tab
   - Select your agent from the dropdown
   - Ask a question about your agent's specialty

3. Verify logs to ensure:
   - The correct agent type is selected
   - The correct source filter is applied to database queries
   - Documentation retrieval works as expected

## Troubleshooting

### Common Issues

1. **Documentation not appearing**:
   - Check that the crawler completed successfully
   - Verify that documents were saved with the correct source filter
   - Check for errors in the logs during the crawl process

2. **Agent not using the right documentation**:
   - Verify that `source_filter` is correctly set in `define_scope_with_reasoner()`
   - Check that filter is correctly applied in `retrieve_relevant_documentation()`

3. **Agent not appearing in UI**:
   - Ensure the agent name is added to `agent_options` in `streamlit_ui.py`

### Debug Logs

For detailed troubleshooting, enable enhanced logging in your agent implementation:

```python
# In your_agent_coder.py
print(f"[YOUR_AGENT QUERY] Searching for documentation with filter: {{\"source\": \"your_agent_docs\"}}")
print(f"[YOUR_AGENT RESULT] Found {len(result.data if result.data else [])} matching documents")
``` 