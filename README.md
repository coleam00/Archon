# Archon - AI Agent Builder

<img src="public/Archon.png" alt="Archon Logo" />

<div align="center" style="margin-top: 20px;margin-bottom: 30px">

<h3>🚀 **CURRENT VERSION** 🚀</h3>

**[ V4 - Massive Streamlit UI Overhaul ]**
*Comprehensive dashboard interface for managing Archon with Streamlit*

</div>

> **🔄 IMPORTANT UPDATE (March 13th)**: The environment variables system has been completely overhauled to be more intuitive with separate sections for LLM and Embedding providers. You will need to reset your environment variables in the UI. The new system makes it much easier to switch between different providers and manage profiles as well!

Archon is the world's first **"Agenteer"**, an AI agent designed to autonomously build, refine, and optimize other AI agents. 

It serves both as a practical tool for developers and as an educational framework demonstrating the evolution of agentic systems.
Archon will be developed in iterations, starting with just a simple Pydantic AI agent that can build other Pydantic AI agents,
all the way to a full agentic workflow using LangGraph that can build other AI agents with any framework.
Through its iterative development, Archon showcases the power of planning, feedback loops, and domain-specific knowledge in creating robust AI agents.

## Important Links

- The current version of Archon is V4 as mentioned above - see [V4 Documentation](iterations/v4-streamlit-ui-overhaul/README.md) for details.

- I **just** created the [Archon community](https://thinktank.ottomator.ai/c/archon/30) forum over in the oTTomator Think Tank! Please post any questions you have there!

- [GitHub Kanban board](https://github.com/users/coleam00/projects/1) for feature implementation and bug squashing.

## Vision

Archon demonstrates three key principles in modern AI development:

1. **Agentic Reasoning**: Planning, iterative feedback, and self-evaluation overcome the limitations of purely reactive systems
2. **Domain Knowledge Integration**: Seamless embedding of frameworks like Pydantic AI and LangGraph within autonomous workflows
3. **Scalable Architecture**: Modular design supporting maintainability, cost optimization, and ethical AI practices

## Getting Started with V4 (current version)

Since V4 is the current version of Archon, all the code for V4 is in both the main directory and `archon/iterations/v4-streamlit-ui-overhaul` directory.

### Prerequisites
- Docker (optional but preferred)
- Python 3.11+
- Supabase account (for vector database)
- OpenAI/Anthropic/OpenRouter API key or Ollama for local LLMs (note that only OpenAI supports streaming in the Streamlit UI currently)

### Installation

#### Option 1: Docker (Recommended)
1. Clone the repository:
```bash
git clone https://github.com/coleam00/archon.git
cd archon
```

2. Run the Docker setup script:
```bash
# This will build both containers and start Archon
python run_docker.py
```

3. Access the Streamlit UI at http://localhost:8501.

> **Note:** `run_docker.py` will automatically:
> - Build the MCP server container
> - Build the main Archon container
> - Run Archon with the appropriate port mappings
> - Use environment variables from `.env` file if it exists

#### Option 2: Local Python Installation
1. Clone the repository:
```bash
git clone https://github.com/coleam00/archon.git
cd archon
```

2. Install dependencies:
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```

3. Start the Streamlit UI:
```bash
streamlit run streamlit_ui.py
```

4. Access the Streamlit UI at http://localhost:8501.

### Updating Archon

#### Option 1: Docker
To get the latest updates for Archon when using Docker:

```bash
# Pull the latest changes from the repository (from within the archon directory)
git pull

# Rebuild and restart the containers with the latest changes
python run_docker.py
```

The `run_docker.py` script will automatically:
- Detect and remove any existing Archon containers (whether running or stopped)
- Rebuild the containers with the latest code
- Start fresh containers with the updated version

#### Option 2: Local Python Installation
To get the latest updates for Archon when using local Python installation:

```bash
# Pull the latest changes from the repository (from within the archon directory)
git pull

# Install any new dependencies
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt

# Restart the Streamlit UI
# (If you're already running it, stop with Ctrl+C first)
streamlit run streamlit_ui.py
```

This ensures you're always running the most recent version of Archon with all the latest features and bug fixes.

### Setup Process

After installation, follow the guided setup process in the Intro section of the Streamlit UI:
- **Environment**: Configure your API keys and model settings - all stored in `workbench/env_vars.json`
- **Database**: Set up your Supabase vector database
- **Documentation**: Crawl and index the Pydantic AI documentation
- **Agent Service**: Start the agent service for generating agents
- **Chat**: Interact with Archon to create AI agents
- **MCP** (optional): Configure integration with AI IDEs

The Streamlit interface will guide you through each step with clear instructions and interactive elements.
There are a good amount of steps for the setup but it goes quick!

### Troubleshooting

If you encounter any errors when using Archon, please first check the logs in the "Agent Service" tab.
Logs specifically for MCP are also logged to `workbench/logs.txt` (file is automatically created) so please
check there. The goal is for you to have a clear error message before creating a bug here in the GitHub repo

## Project Evolution

### V1: Single-Agent Foundation
- Basic RAG-powered agent using Pydantic AI
- Supabase vector database for documentation storage
- Simple code generation without validation
- [Learn more about V1](iterations/v1-single-agent/README.md)

### V2: Agentic Workflow (LangGraph)
- Multi-agent system with planning and execution separation
- Reasoning LLM (O3-mini/R1) for architecture planning
- LangGraph for workflow orchestration
- Support for local LLMs via Ollama
- [Learn more about V2](iterations/v2-agentic-workflow/README.md)

### V3: MCP Support
- Integration with AI IDEs like Windsurf and Cursor
- Automated file creation and dependency management
- FastAPI service for agent generation
- Improved project structure and organization
- [Learn more about V3](iterations/v3-mcp-support/README.md)

### V4: Current - Streamlit UI Overhaul
- Docker support
- Comprehensive Streamlit interface for managing all aspects of Archon
- Guided setup process with interactive tabs
- Environment variable management through the UI
- Database setup and documentation crawling simplified
- Agent service control and monitoring
- MCP configuration through the UI
- [Learn more about V4](iterations/v4-streamlit-ui-overhaul/README.md)

### Future Iterations
- V5: Multi-Agent Coding Workflow - Specialized agents for different parts of the agent creation process
- V6: Tool Library and Example Integration - Pre-built external tool and agent examples incorporation
- V7: LangGraph Documentation - Allow Archon to build Pydantic AI AND LangGraph agents
- V8: Self-Feedback Loop - Automated validation and error correction
- V9: Self Agent Execution - Testing and iterating on agents in an isolated environment
- V10: Multi-Framework Support - Framework-agnostic agent generation
- V11: Autonomous Framework Learning - Self-updating framework adapters
- V12: Advanced RAG Techniques - Enhanced retrieval and incorporation of framework documentation
- V13: MCP Agent Marketplace - Integrating Archon agents as MCP servers and publishing to marketplaces

### Future Integrations
- LangSmith
- MCP marketplace
- Other frameworks besides Pydantic AI
- Other vector databases besides Supabase
- [Local AI package](https://github.com/coleam00/local-ai-packaged) for the agent environment

## Architecture

### Core Files
- `streamlit_ui.py`: Comprehensive web interface for managing all aspects of Archon
- `graph_service.py`: FastAPI service that handles the agentic workflow
- `run_docker.py`: Script to build and run Archon Docker containers
- `Dockerfile`: Container definition for the main Archon application

### MCP Integration
- `mcp/`: Model Context Protocol server implementation
  - `mcp_server.py`: MCP server script for AI IDE integration
  - `Dockerfile`: Container definition for the MCP server

### Archon Package
- `archon/`: Core agent and workflow implementation
  - `archon_graph.py`: LangGraph workflow definition and agent coordination
  - `pydantic_ai_coder.py`: Main coding agent with RAG capabilities
  - `crawl_pydantic_ai_docs.py`: Documentation crawler and processor

### Utilities
- `utils/`: Utility functions and database setup
  - `utils.py`: Shared utility functions
  - `site_pages.sql`: Database setup commands

### Workbench
- `workbench/`: Created at runtime, files specific to your environment
  - `env_vars.json`: Environment variables defined in the UI are stored here (included in .gitignore, file is created automatically)
  - `logs.txt`: Low level logs for all Archon processes go here
  - `scope.md`: The detailed scope document created by the reasoner model at the start of each Archon execution

## Deployment Options
- **Docker Containers**: Run Archon in isolated containers with all dependencies included
  - Main container: Runs the Streamlit UI and graph service
  - MCP container: Provides MCP server functionality for AI IDEs
- **Local Python**: Run directly on your system with a Python virtual environment

### Docker Architecture
The Docker implementation consists of two containers:
1. **Main Archon Container**:
   - Runs the Streamlit UI on port 8501
   - Hosts the Graph Service on port 8100
   - Built from the root Dockerfile
   - Handles all agent functionality and user interactions

2. **MCP Container**:
   - Implements the Model Context Protocol for AI IDE integration
   - Built from the mcp/Dockerfile
   - Communicates with the main container's Graph Service
   - Provides a standardized interface for AI IDEs like Windsurf, Cursor, Cline, and Roo Code

When running with Docker, the `run_docker.py` script automates building and starting both containers with the proper configuration.

## Database Setup

The Supabase database uses the following schema:

```sql
CREATE TABLE site_pages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    url TEXT,
    chunk_number INTEGER,
    title TEXT,
    summary TEXT,
    content TEXT,
    metadata JSONB,
    embedding VECTOR(1536) -- Adjust dimensions as necessary (i.e. 768 for nomic-embed-text)
);
```

The Streamlit UI provides an interface to set up this database structure automatically.

## Contributing

We welcome contributions! Whether you're fixing bugs, adding features, or improving documentation, please feel free to submit a Pull Request.

## License

[MIT License](LICENSE)

---

For version-specific details:
- [V1 Documentation](iterations/v1-single-agent/README.md)
- [V2 Documentation](iterations/v2-agentic-workflow/README.md)
- [V3 Documentation](iterations/v3-mcp-support/README.md)
- [V4 Documentation](iterations/v4-streamlit-ui-overhaul/README.md)
