from __future__ import annotations

import logging
from typing import Literal, TypedDict
from langgraph.types import Command
import os

# Set up HTTP request logging to show database queries
logging.basicConfig(level=logging.INFO)
logging.getLogger("httpx").setLevel(logging.INFO)

import streamlit as st
import logfire
import asyncio
import time
import json
import uuid
import sys
import platform
import subprocess
import threading
import queue
import webbrowser
import importlib
from urllib.parse import urlparse
from openai import AsyncOpenAI
from supabase import Client, create_client
from dotenv import load_dotenv
from utils.utils import get_env_var, save_env_var, write_to_log
from future_enhancements import future_enhancements_tab
from threading import Lock
# Import all Pydantic AI crawler functions in one place
from archon.crawl_pydantic_ai_docs import (
    start_crawl_with_requests as start_pydantic_crawl,
    start_crawl_with_crawl4ai as start_pydantic_crawl4ai,
    clear_existing_records as clear_pydantic_records,
    start_test_crawler as start_pydantic_test_crawler
)
# Import all Supabase crawler functions in one place to avoid conflicts
from archon.crawl_supabase_docs import (
    start_crawl_with_requests, 
    start_crawl_with_crawl4ai, 
    clear_existing_records, 
    start_test_crawler
)

# Import all the message part classes
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    UserPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    RetryPromptPart,
    ModelMessagesTypeAdapter
)

# Add the current directory to Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from archon.archon_graph import agentic_flow

# Load environment variables from .env file
load_dotenv()

# Initialize clients
openai_client = None
base_url = get_env_var('BASE_URL') or 'https://api.openai.com/v1'
api_key = get_env_var('LLM_API_KEY') or 'no-llm-api-key-provided'
is_ollama = "localhost" in base_url.lower()

if is_ollama:
    openai_client = AsyncOpenAI(base_url=base_url,api_key=api_key)
elif get_env_var("OPENAI_API_KEY"):
    openai_client = AsyncOpenAI(api_key=get_env_var("OPENAI_API_KEY"))
else:
    openai_client = None

if get_env_var("SUPABASE_URL"):
    supabase: Client = Client(
            get_env_var("SUPABASE_URL"),
            get_env_var("SUPABASE_SERVICE_KEY")
        )
else:
    supabase = None

# Set page config - must be the first Streamlit command
st.set_page_config(
    page_title="Archon - Agent Builder",
    page_icon="🤖",
    layout="wide",
)

# Set custom theme colors to match Archon logo (green and pink)
# Primary color (green) and secondary color (pink)
st.markdown("""
    <style>
    :root {
        --primary-color: #00CC99;  /* Green */
        --secondary-color: #EB2D8C; /* Pink */
        --text-color: #262730;
    }
    
    /* Style the buttons */
    .stButton > button {
        color: white;
        border: 2px solid var(--primary-color);
        padding: 0.5rem 1rem;
        font-weight: bold;
        transition: all 0.3s ease;
    }
    
    .stButton > button:hover {
        color: white;
        border: 2px solid var(--secondary-color);
    }
    
    /* Override Streamlit's default focus styles that make buttons red */
    .stButton > button:focus, 
    .stButton > button:focus:hover, 
    .stButton > button:active, 
    .stButton > button:active:hover {
        color: white !important;
        border: 2px solid var(--secondary-color) !important;
        box-shadow: none !important;
        outline: none !important;
    }
    
    /* Style headers */
    h1, h2, h3 {
        color: var(--primary-color);
    }
    
    /* Hide spans within h3 elements */
    h1 span, h2 span, h3 span {
        display: none !important;
        visibility: hidden;
        width: 0;
        height: 0;
        opacity: 0;
        position: absolute;
        overflow: hidden;
    }
    
    /* Style code blocks */
    pre {
        border-left: 4px solid var(--primary-color);
    }
    
    /* Style links */
    a {
        color: var(--secondary-color);
    }
    
    /* Style the chat messages */
    .stChatMessage {
        border-left: 4px solid var(--secondary-color);
    }
    
    /* Style the chat input */
    .stChatInput > div {
        border: 2px solid var(--primary-color) !important;
    }
    
    /* Remove red outline on focus */
    .stChatInput > div:focus-within {
        box-shadow: none !important;
        border: 2px solid var(--secondary-color) !important;
        outline: none !important;
    }
    
    /* Remove red outline on all inputs when focused */
    input:focus, textarea:focus, [contenteditable]:focus {
        box-shadow: none !important;
        border-color: var(--secondary-color) !important;
        outline: none !important;
    }

    </style>
""", unsafe_allow_html=True)

# Helper function to create a button that opens a tab in a new window
def create_new_tab_button(label, tab_name, key=None, use_container_width=False):
    """Create a button that opens a specified tab in a new browser window"""
    # Create a unique key if none provided
    if key is None:
        key = f"new_tab_{tab_name.lower().replace(' ', '_')}"
    
    # Get the base URL
    base_url = st.query_params.get("base_url", "")
    if not base_url:
        # If base_url is not in query params, use the default localhost URL
        base_url = "http://localhost:8501"
    
    # Create the URL for the new tab
    new_tab_url = f"{base_url}/?tab={tab_name}"
    
    # Create a button that will open the URL in a new tab when clicked
    if st.button(label, key=key, use_container_width=use_container_width):
        webbrowser.open_new_tab(new_tab_url)

# Function to reload the archon_graph module
def reload_archon_graph():
    """Reload the archon_graph module to apply new environment variables"""
    try:
        # First reload pydantic_ai_coder
        import archon.pydantic_ai_coder
        importlib.reload(archon.pydantic_ai_coder)
        
        # Then reload archon_graph which imports pydantic_ai_coder
        import archon.archon_graph
        importlib.reload(archon.archon_graph)
        
        st.success("Successfully reloaded Archon modules with new environment variables!")
        return True
    except Exception as e:
        st.error(f"Error reloading Archon modules: {str(e)}")
        return False
    
# Configure logfire to suppress warnings (optional)
logfire.configure(send_to_logfire='never')

@st.cache_resource
def get_thread_id():
    return str(uuid.uuid4())

thread_id = get_thread_id()

async def run_agent_with_streaming(user_input: str, agent_type: str = ""):
    """
    Run the agent with streaming text for the user_input prompt,
    while maintaining the entire conversation in `st.session_state.messages`.
    
    Args:
        user_input: The user's input message
        agent_type: The type of agent to use (e.g., "Pydantic AI Agent" or "Supabase Agent")
    """
    # Validate agent type
    if not agent_type:
        yield "Please select an agent type first."
        return
        
    # Enhanced logging for agent initialization
    print(f"\n====================================================")
    print(f"[AGENT INITIALIZATION] Starting agent with type: {agent_type}")
    print(f"[AGENT INITIALIZATION] User input: {user_input[:50]}...")
    print(f"====================================================\n")
    
    config = {
        "configurable": {
            "thread_id": thread_id,
            "agent_type": agent_type  # Pass the agent type to the graph
        }
    }

    # First message from user
    if len(st.session_state.messages) == 1:
        async for msg in agentic_flow.astream(
                {"latest_user_message": user_input, "agent_type": agent_type}, config, stream_mode="custom"
            ):
                yield msg
    # Continue the conversation
    else:
        async for msg in agentic_flow.astream(
            Command(
                resume=user_input,
                update={"agent_type": agent_type}  # Update the agent_type in the state
            ), 
            config, 
            stream_mode="custom"
        ):
            yield msg

def generate_mcp_config(ide_type):
    """
    Generate MCP configuration for the selected IDE type.
    """
    # Get the absolute path to the current directory
    base_path = os.path.abspath(os.path.dirname(__file__))
    
    # Determine the correct python path based on the OS
    if platform.system() == "Windows":
        python_path = os.path.join(base_path, 'venv', 'Scripts', 'python.exe')
    else:  # macOS or Linux
        python_path = os.path.join(base_path, 'venv', 'bin', 'python')
    
    server_script_path = os.path.join(base_path, 'mcp', 'mcp_server.py')
    
    # Create the config dictionary for Python
    python_config = {
        "mcpServers": {
            "archon": {
                "command": python_path,
                "args": [server_script_path]
            }
        }
    }
    
    # Create the config dictionary for Docker
    docker_config = {
        "mcpServers": {
            "archon": {
                "command": "docker",
                "args": [
                    "run",
                    "-i",
                    "--rm",
                    "-e", 
                    "GRAPH_SERVICE_URL",
                    "archon-mcp:latest"
                ],
                "env": {
                    "GRAPH_SERVICE_URL": "http://host.docker.internal:8100"
                }
            }
        }
    }
    
    # Return appropriate configuration based on IDE type
    if ide_type == "Windsurf":
        return json.dumps(python_config, indent=2), json.dumps(docker_config, indent=2)
    elif ide_type == "Cursor":
        return f"{python_path} {server_script_path}", f"docker run -i --rm -e GRAPH_SERVICE_URL=http://host.docker.internal:8100 archon-mcp:latest"
    elif ide_type == "Cline":
        return json.dumps(python_config, indent=2), json.dumps(docker_config, indent=2)  # Assuming Cline uses the same format as Windsurf
    else:
        return "Unknown IDE type selected", "Unknown IDE type selected"

def mcp_tab():
    """Display the MCP configuration interface"""
    st.header("MCP Configuration")
    st.write("Select your AI IDE to get the appropriate MCP configuration:")
    
    # IDE selection with side-by-side buttons
    col1, col2, col3 = st.columns(3)
    
    with col1:
        windsurf_button = st.button("Windsurf", use_container_width=True, key="windsurf_button")
    with col2:
        cursor_button = st.button("Cursor", use_container_width=True, key="cursor_button")
    with col3:
        cline_button = st.button("Cline/Roo Code", use_container_width=True, key="cline_button")
    
    # Initialize session state for selected IDE if not present
    if "selected_ide" not in st.session_state:
        st.session_state.selected_ide = None
    
    # Update selected IDE based on button clicks
    if windsurf_button:
        st.session_state.selected_ide = "Windsurf"
    elif cursor_button:
        st.session_state.selected_ide = "Cursor"
    elif cline_button:
        st.session_state.selected_ide = "Cline/Roo Code"
    
    # Display configuration if an IDE is selected
    if st.session_state.selected_ide:
        selected_ide = st.session_state.selected_ide
        st.subheader(f"MCP Configuration for {selected_ide}")
        python_config, docker_config = generate_mcp_config(selected_ide)
        
        # Configuration type tabs
        config_tab1, config_tab2 = st.tabs(["Docker Configuration", "Python Configuration"])
        
        with config_tab1:
            st.markdown("### Docker Configuration")
            st.code(docker_config, language="json" if selected_ide != "Cursor" else None)
            
            st.markdown("#### Requirements:")
            st.markdown("- Docker installed")
            st.markdown("- Run the setup script to build and start both containers:")
            st.code("python run_docker.py", language="bash")
        
        with config_tab2:
            st.markdown("### Python Configuration")
            st.code(python_config, language="json" if selected_ide != "Cursor" else None)
            
            st.markdown("#### Requirements:")
            st.markdown("- Python 3.11+ installed")
            st.markdown("- Virtual environment created and activated")
            st.markdown("- All dependencies installed via `pip install -r requirements.txt`")
            st.markdown("- Must be running Archon not within a container")           
        
        # Instructions based on IDE type
        st.markdown("---")
        st.markdown("### Setup Instructions")
        
        if selected_ide == "Windsurf":
            st.markdown("""
            #### How to use in Windsurf:
            1. Click on the hammer icon above the chat input
            2. Click on "Configure"
            3. Paste the JSON from your preferred configuration tab above
            4. Click "Refresh" next to "Configure"
            """)
        elif selected_ide == "Cursor":
            st.markdown("""
            #### How to use in Cursor:
            1. Go to Cursor Settings > Features > MCP
            2. Click on "+ Add New MCP Server"
            3. Name: Archon
            4. Type: command (equivalent to stdio)
            5. Command: Paste the command from your preferred configuration tab above
            """)
        elif selected_ide == "Cline/Roo Code":
            st.markdown("""
            #### How to use in Cline or Roo Code:
            1. From the Cline/Roo Code extension, click the "MCP Server" tab
            2. Click the "Edit MCP Settings" button
            3. The MCP settings file should be displayed in a tab in VS Code
            4. Paste the JSON from your preferred configuration tab above
            5. Cline/Roo Code will automatically detect and start the MCP server
            """)

async def chat_tab():
    """Display the chat interface for talking to Archon"""
    # Add agent selection with blank default option
    agent_options = ["", "Pydantic AI Agent", "Supabase Agent"]
    
    # Create a container for the agent selection UI
    agent_selection_container = st.container()
    
    with agent_selection_container:
        # Create columns for the agent selection
        col1, col2 = st.columns([3, 1])
        
        with col1:
            # Add description based on the selected agent
            if "selected_agent" not in st.session_state:
                st.session_state.selected_agent = agent_options[0]  # Start with blank
            
            if not st.session_state.selected_agent:  # Blank/default state
                st.write("👈 Please select an agent type to begin.")
            elif st.session_state.selected_agent == "Pydantic AI Agent":
                st.write("Describe to me an AI agent you want to build and I'll code it for you with Pydantic AI.")
                st.write("Example: Build me an AI agent that can search the web with the Brave API.")
            elif st.session_state.selected_agent == "Supabase Agent":
                st.write("Describe a Supabase application you want to build and I'll code it for you.")
                st.write("Example: Build me a user authentication system with Supabase and Next.js.")
        
        with col2:
            # Add agent selection dropdown
            selected_agent = st.selectbox(
                "Select Agent",
                agent_options,
                index=agent_options.index(st.session_state.selected_agent) if "selected_agent" in st.session_state else 0,
                key="agent_selector",
                format_func=lambda x: "Select an agent type..." if x == "" else x
            )
            
            # Update session state when selection changes
            if "selected_agent" not in st.session_state or st.session_state.selected_agent != selected_agent:
                st.session_state.selected_agent = selected_agent
                # Clear messages when switching agents
                if "messages" in st.session_state:
                    st.session_state.messages = []
                st.rerun()
    
    # Initialize chat history for the selected agent in session state if not present
    agent_key = "messages_" + st.session_state.selected_agent.lower().replace(" ", "_")
    if agent_key not in st.session_state:
        st.session_state[agent_key] = []
    
    # Set the current messages based on the selected agent
    st.session_state.messages = st.session_state[agent_key]

    # Display chat messages from history on app rerun
    for message in st.session_state.messages:
        message_type = message["type"]
        if message_type in ["human", "ai", "system"]:
            with st.chat_message(message_type):
                st.markdown(message["content"])    

    # Initialize user_input to None before conditional
    user_input = None
    
    # Add the chat input at the bottom
    if not st.session_state.selected_agent:
        # Disable chat input if no agent selected
        st.chat_input("Please select an agent type first...", disabled=True)
    else:
        user_input = st.chat_input(f"What do you want to build with {st.session_state.selected_agent}?")

    if user_input:
        # We append a new request to the conversation explicitly
        st.session_state.messages.append({"type": "human", "content": user_input})
        # Also update the agent-specific message history
        st.session_state[agent_key] = st.session_state.messages
        
        # Display user prompt in the UI
        with st.chat_message("user"):
            st.markdown(user_input)

        # Display assistant response in chat message container
        response_content = ""
        with st.chat_message("assistant"):
            message_placeholder = st.empty()  # Placeholder for updating the message
            # Run the async generator to fetch responses
            async for chunk in run_agent_with_streaming(user_input, st.session_state.selected_agent):
                response_content += chunk
                # Update the placeholder with the current response content
                message_placeholder.markdown(response_content)
        
        # Only add the response to chat history if it's not a validation message
        if not response_content.startswith("Please select an agent type first"):
            st.session_state.messages.append({"type": "ai", "content": response_content})
            # Also update the agent-specific message history
            st.session_state[agent_key] = st.session_state.messages

def intro_tab():
    """Display the introduction and setup guide for Archon"""
    # Display the banner image
    st.image("public/Archon.png", use_container_width=True)
    
    # Welcome message
    st.markdown("""
    # Welcome to Archon!
    
    Archon is an AI meta-agent designed to autonomously build, refine, and optimize other AI agents.
    
    It serves both as a practical tool for developers and as an educational framework demonstrating the evolution of agentic systems.
    Archon is developed in iterations, starting with a simple Pydantic AI agent that can build other Pydantic AI agents,
    all the way to a full agentic workflow using LangGraph that can build other AI agents with any framework.
    
    Through its iterative development, Archon showcases the power of planning, feedback loops, and domain-specific knowledge in creating robust AI agents.
    """)
    
    # Setup guide with expandable sections
    st.markdown("## Setup Guide")
    st.markdown("Follow these concise steps to get Archon up and running (IMPORTANT: come back here after each step):")
    
    # Step 1: Environment Configuration
    with st.expander("Step 1: Environment Configuration", expanded=True):
        st.markdown("""
        ### Environment Configuration
        
        First, you need to set up your environment variables:
        
        1. Go to the **Environment** tab
        2. Configure the following essential variables:
           - `BASE_URL`: API endpoint (OpenAI, OpenRouter, or Ollama)
           - `LLM_API_KEY`: Your API key for the LLM service
           - `OPENAI_API_KEY`: Required for embeddings
           - `SUPABASE_URL`: Your Supabase project URL
           - `SUPABASE_SERVICE_KEY`: Your Supabase service key
           - `PRIMARY_MODEL`: Main agent model (e.g., gpt-4o-mini)
           - `REASONER_MODEL`: Planning model (e.g., o3-mini)
        
        These settings determine how Archon connects to external services and which models it uses.
        """)
        # Add a button to navigate to the Environment tab
        create_new_tab_button("Go to Environment Section (New Tab)", "Environment", key="goto_env", use_container_width=True)
    
    # Step 2: Database Setup
    with st.expander("Step 2: Database Setup", expanded=False):
        st.markdown("""
        ### Database Setup
        
        Archon uses Supabase for vector storage and retrieval:
        
        1. Go to the **Database** tab
        2. Select your embedding dimensions (1536 for OpenAI, 768 for nomic-embed-text)
        3. Follow the instructions to create the `site_pages` table
        
        This creates the necessary tables, indexes, and functions for vector similarity search.
        """)
        # Add a button to navigate to the Database tab
        create_new_tab_button("Go to Database Section (New Tab)", "Database", key="goto_db", use_container_width=True)
    
    # Step 3: Documentation Crawling
    with st.expander("Step 3: Documentation Crawling", expanded=False):
        st.markdown("""
        ### Documentation Crawling
        
        Populate the database with framework documentation:
        
        1. Go to the **Documentation** tab
        2. Click on "Crawl Pydantic AI Docs"
        3. Wait for the crawling process to complete
        
        This step downloads and processes documentation, creating embeddings for semantic search.
        """)
        # Add a button to navigate to the Documentation tab
        create_new_tab_button("Go to the Documentation Section (New Tab)", "Documentation", key="goto_docs", use_container_width=True)
    
    # Step 4: Agent Service
    with st.expander("Step 4: Agent Service Setup (for MCP)", expanded=False):
        st.markdown("""
        ### MCP Agent Service Setup
        
        Start the graph service for agent generation:
        
        1. Go to the **Agent Service** tab
        2. Click on "Start Agent Service"
        3. Verify the service is running
        
        The agent service powers the LangGraph workflow for agent creation.
        """)
        # Add a button to navigate to the Agent Service tab
        create_new_tab_button("Go to Agent Service Section (New Tab)", "Agent Service", key="goto_service", use_container_width=True)
    
    # Step 5: MCP Configuration (Optional)
    with st.expander("Step 5: MCP Configuration (Optional)", expanded=False):
        st.markdown("""
        ### MCP Configuration
        
        For integration with AI IDEs:
        
        1. Go to the **MCP** tab
        2. Select your IDE (Windsurf, Cursor, or Cline/Roo Code)
        3. Follow the instructions to configure your IDE
        
        This enables you to use Archon directly from your AI-powered IDE.
        """)
        # Add a button to navigate to the MCP tab
        create_new_tab_button("Go to MCP Section (New Tab)", "MCP", key="goto_mcp", use_container_width=True)
    
    # Step 6: Using Archon
    with st.expander("Step 6: Using Archon", expanded=False):
        st.markdown("""
        ### Using Archon
        
        Once everything is set up:
        
        1. Go to the **Chat** tab
        2. Describe the agent you want to build
        3. Archon will plan and generate the necessary code
        
        You can also use Archon directly from your AI IDE if you've configured MCP.
        """)
        # Add a button to navigate to the Chat tab
        create_new_tab_button("Go to Chat Section (New Tab)", "Chat", key="goto_chat", use_container_width=True)
    
    # Resources
    st.markdown("""
    ## Additional Resources
    
    - [GitHub Repository](https://github.com/coleam00/archon)
    - [Archon Community Forum](https://thinktank.ottomator.ai/c/archon/30)
    - [GitHub Kanban Board](https://github.com/users/coleam00/projects/1)
    """)

def documentation_tab():
    """Display the documentation interface"""
    import time
    import threading
    from datetime import datetime
    st.header("Documentation")
    
    # Create tabs for different documentation sources
    doc_tabs = st.tabs(["Pydantic AI Docs", "Supabase Docs", "Future Sources"])
    
    with doc_tabs[0]:
        st.subheader("Pydantic AI Documentation")
        st.markdown("""
        This section allows you to crawl and index the Pydantic AI documentation.
        The crawler will:
        
        1. Fetch URLs from the Pydantic AI sitemap
        2. Crawl each page and extract content
        3. Split content into chunks
        4. Generate embeddings for each chunk
        5. Store the chunks in the Supabase database
        
        This process may take several minutes depending on the number of pages.
        """)
        
        # Check if the database is configured
        supabase_url = get_env_var("SUPABASE_URL")
        supabase_key = get_env_var("SUPABASE_SERVICE_KEY")
        
        if not supabase_url or not supabase_key:
            st.warning("⚠️ Supabase is not configured. Please set up your environment variables first.")
            create_new_tab_button("Go to Environment Section", "Environment", key="goto_env_from_docs")
        else:
            # Initialize session state for tracking crawl progress
            if "crawl_tracker" not in st.session_state:
                st.session_state.crawl_tracker = None
            
            if "crawl_status" not in st.session_state:
                st.session_state.crawl_status = None
                
            if "last_update_time" not in st.session_state:
                st.session_state.last_update_time = time.time()
            
            # Add a slider for URL limit
            url_limit = st.slider(
                "Maximum URLs to crawl (Pydantic)", 
                min_value=10, 
                max_value=500, 
                value=50, 
                step=10,
                help="Set to control how many URLs to crawl. Higher values will take longer but provide more comprehensive documentation.",
                key="pydantic_url_limit"
            )
            
            # Add a radio button to select the crawler method
            crawler_method = st.radio(
                "Crawler Method (Pydantic)",
                ["Requests (Basic)", "Crawl4AI (Advanced)"],
                help="Select the method to use for crawling. Crawl4AI provides better content extraction but requires the Crawl4AI package.",
                key="pydantic_crawler_method"
            )
            
            # Create columns for the buttons
            col1, col2, col3 = st.columns(3)
            
            with col1:
                # Button to start crawling
                is_crawling = (st.session_state.crawl_tracker and 
                             (st.session_state.crawl_tracker.is_running))
                
                if st.button("Crawl Pydantic AI Docs", key="crawl_pydantic") and not is_crawling:
                    try:
                        # Define a callback function to update the session state
                        def update_progress(status):
                            st.session_state.crawl_status = status
                        
                        # Start the crawling process based on selected method
                        if crawler_method == "Crawl4AI (Advanced)":
                            st.session_state.crawl_tracker = start_pydantic_crawl4ai(
                                update_progress,
                                url_limit=url_limit
                            )
                            st.info("Using Crawl4AI for enhanced content extraction")
                        else:
                            st.session_state.crawl_tracker = start_pydantic_crawl(
                                update_progress,
                                url_limit=url_limit
                            )
                        
                        st.session_state.crawl_status = st.session_state.crawl_tracker.get_status()
                        
                        # Force a rerun to start showing progress
                        st.rerun()
                    except Exception as e:
                        st.error(f"❌ Error starting crawl: {str(e)}")
            
            with col2:
                # Button to clear existing Pydantic AI docs
                if st.button("Clear Pydantic AI Docs", key="clear_pydantic"):
                    with st.spinner("Clearing existing Pydantic AI docs..."):
                        try:
                            # Create a synchronous wrapper function
                            def sync_clear_pydantic_records():
                                import asyncio
                                loop = asyncio.new_event_loop()
                                asyncio.set_event_loop(loop)
                                result = loop.run_until_complete(clear_pydantic_records())
                                loop.close()
                                return result
                            
                            # Run the function in a thread to avoid blocking the UI
                            import threading
                            result = None
                            
                            def run_in_thread():
                                nonlocal result
                                result = sync_clear_pydantic_records()
                            
                            thread = threading.Thread(target=run_in_thread)
                            thread.start()
                            thread.join()  # Wait for completion
                            
                            # Check if there was an error
                            if isinstance(result, dict) and "error" in result:
                                st.error(f"❌ Error clearing Pydantic AI docs: {result['error']}")
                            else:
                                st.success("✅ Successfully cleared existing Pydantic AI docs from the database.")
                                # Force a rerun to update the UI
                                st.rerun()
                        except Exception as e:
                            import traceback
                            traceback.print_exc()
                            st.error(f"❌ Error clearing Pydantic AI docs: {str(e)}")
            
            with col3:
                # Button for test crawl (a single page)
                test_button = st.button("Test Crawl (Single Page)", key="test_pydantic_crawl")
                
                if test_button and not is_crawling:
                    try:
                        # Define a callback function to update the session state
                        def update_test_crawler_progress(status):
                            st.session_state.crawl_status = status
                        
                        # Start the test crawling process in a separate thread
                        st.session_state.crawl_tracker = start_pydantic_test_crawler(update_test_crawler_progress)
                        st.session_state.crawl_status = st.session_state.crawl_tracker.get_status()
                        st.session_state.last_update_time = time.time()
                        
                        # Force a rerun to start showing progress
                        st.rerun()
                    except Exception as e:
                        st.error(f"❌ Error starting test crawl: {str(e)}")
            
            # Display crawling progress if a crawl is in progress or has completed
            if st.session_state.crawl_tracker:
                # Create a container for the progress information
                progress_container = st.container()
                
                with progress_container:
                    # Get the latest status
                    current_time = time.time()
                    # Update status every second
                    if current_time - st.session_state.last_update_time >= 1:
                        st.session_state.crawl_status = st.session_state.crawl_tracker.get_status()
                        st.session_state.last_update_time = current_time
                    
                    status = st.session_state.crawl_status
                    
                    # Display a progress bar
                    if status and status["urls_found"] > 0:
                        progress = status["urls_processed"] / status["urls_found"]
                        st.progress(progress)
                    
                    # Display status metrics
                    col1, col2, col3, col4 = st.columns(4)
                    if status:
                        col1.metric("URLs Found", status["urls_found"])
                        col2.metric("URLs Processed", status["urls_processed"])
                        col3.metric("Successes", status.get("urls_succeeded", 0))
                        col4.metric("Failures", status.get("urls_failed", 0))
                    
                    # Determine crawler state
                    is_running = status.get("is_running", True)
                    has_ended = status.get("end_time") is not None
                    is_stopping = status.get("stop_requested", False)
                    
                    # Display appropriate message
                    if is_stopping:
                        st.warning("⏳ Crawl is stopping... Please wait.")
                    elif not is_running and has_ended:
                        if status.get("urls_succeeded", 0) > 0:
                            st.success(f"✅ Crawl completed! Processed {status.get('urls_processed', 0)} URLs and stored {status.get('chunks_stored', 0)} chunks.")
                        else:
                            st.error("❌ Crawl completed but no documents were processed.")
                    else:
                        if status.get("urls_processed", 0) > 0:
                            st.info(f"⏳ Crawling in progress... ({status.get('urls_processed', 0)}/{status.get('urls_found', 0)} URLs processed)")
                        else:
                            st.info("🔍 Preparing to crawl...")
                    
                    # Create a row of buttons for all possible actions
                    button_cols = st.columns([1, 1, 1])
                    
                    # First column: Check Status button (always visible when crawler is running)
                    with button_cols[0]:
                        if is_running or is_stopping:
                            if st.button("🔄 Check Status", key="check_pydantic_status"):
                                # Manually get the latest status
                                current_status = st.session_state.crawl_tracker.get_status()
                                st.session_state.crawl_status = current_status
                                st.rerun()
                    
                    # Second column: Stop button (only visible when crawler is running)
                    with button_cols[1]:
                        if is_running and not is_stopping:
                            if st.button("⏹️ Stop Crawl", key="stop_pydantic_crawl"):
                                if st.session_state.crawl_tracker:
                                    st.session_state.crawl_tracker.stop()
                                    st.session_state.crawl_status = st.session_state.crawl_tracker.get_status()
                                    st.rerun()
                    
                    # Third column: Clear Status button (only visible when crawler is not running)
                    with button_cols[2]:
                        if not is_running and has_ended:
                            if st.button("🗑️ Clear Status", key="clear_pydantic_status"):
                                # Clear the crawler status
                                st.session_state.crawl_tracker = None
                                st.session_state.crawl_status = None
                                st.rerun()
                    
                    # Display logs
                    if status and status["logs"]:
                        st.subheader("Crawl Logs")
                        log_text = "\n".join(status["logs"][-10:])  # Show last 10 logs
                        st.text_area("Recent Logs", log_text, height=200, disabled=True, key="pydantic_logs")

    with doc_tabs[1]:
        st.subheader("Supabase Documentation")
        st.markdown("""
        This section allows you to crawl and index the Supabase documentation.
        The crawler will:
        1. Fetch documentation pages from the Supabase website
        2. Process the content into chunks
        
        1. Fetch URLs from the Supabase sitemap
        2. Crawl each page and extract content
        3. Split content into chunks
        4. Generate embeddings for each chunk
        5. Store the chunks in the Supabase database
        
        This process may take several minutes depending on the number of pages.
        """)
        
        # Check if the database is configured
        supabase_url = get_env_var("SUPABASE_URL")
        supabase_key = get_env_var("SUPABASE_SERVICE_KEY")
        
        if not supabase_url or not supabase_key:
            st.warning("⚠️ Supabase is not configured. Please set up your environment variables first.")
            create_new_tab_button("Go to Environment Section", "Environment", key="goto_env_from_supabase_docs")
        else:
            # Initialize session state for Supabase crawl if not already done
            if "supabase_crawl_tracker" not in st.session_state:
                st.session_state.supabase_crawl_tracker = None
            if "supabase_crawl_status" not in st.session_state:
                st.session_state.supabase_crawl_status = None
            if "supabase_last_update_time" not in st.session_state:
                st.session_state.supabase_last_update_time = time.time()
            if "supabase_crawl_complete" not in st.session_state:
                st.session_state.supabase_crawl_complete = False
            
            # Create columns for the buttons
            col1, col2, col3 = st.columns(3)
            
            # Add a slider for URL limit
            url_limit = st.slider(
                "Maximum URLs to crawl", 
                min_value=10, 
                max_value=500, 
                value=50, 
                step=10,
                help="Set to control how many URLs to crawl. Higher values will take longer but provide more comprehensive documentation."
            )
            
            # Add a radio button to select the crawler method
            crawler_method = st.radio(
                "Crawler Method",
                ["Requests (Basic)", "Crawl4AI (Advanced)"],
                help="Select the method to use for crawling. Crawl4AI provides better content extraction but requires the Crawl4AI package."
            )
            
            with col1:
                # Button to start crawling
                is_crawling = (st.session_state.supabase_crawl_tracker and 
                             (st.session_state.supabase_crawl_tracker.is_running or 
                              st.session_state.supabase_crawl_tracker.is_stopping))
                
                crawl_button = st.button("Crawl Supabase Docs", key="crawl_supabase")
                
                if crawl_button and not is_crawling:
                    try:
                        # DRASTICALLY SIMPLIFIED APPROACH
                        # Just a basic callback function that stores status without complex threading
                        def update_supabase_progress(status):
                            # Store in session state
                            st.session_state.supabase_crawl_status = status
                            
                            # Also store end time when crawler finishes
                            if status.get("end_time"):
                                st.session_state.supabase_crawl_end_time = status.get("end_time")
                        
                        # Start the crawler based on selected method
                        if crawler_method == "Crawl4AI (Advanced)":
                            st.session_state.supabase_crawl_tracker = start_crawl_with_crawl4ai(
                                update_supabase_progress, 
                                url_limit=url_limit
                            )
                            st.info("Using Crawl4AI for enhanced content extraction")
                        else:
                            st.session_state.supabase_crawl_tracker = start_crawl_with_requests(
                                update_supabase_progress, 
                                url_limit=url_limit
                            )
                        
                        # Store start time
                        st.session_state.supabase_crawl_start_time = time.time()
                        
                        # Force a rerun to show we've started
                        st.rerun()
                        
                    except Exception as e:
                        st.error(f"❌ Error starting Supabase crawl: {str(e)}")
                        print(f"Error with crawler setup: {str(e)}")
            
            with col2:
                # Button to clear existing Supabase docs
                if st.button("Clear Supabase Docs", key="clear_supabase"):
                    with st.spinner("Clearing existing Supabase docs..."):
                        try:
                            # Create a synchronous wrapper function
                            def sync_clear_records():
                                import asyncio
                                loop = asyncio.new_event_loop()
                                asyncio.set_event_loop(loop)
                                result = loop.run_until_complete(clear_existing_records())
                                loop.close()
                                return result
                            
                            # Run the function in a thread to avoid blocking the UI
                            import threading
                            result = None
                            
                            def run_in_thread():
                                nonlocal result
                                result = sync_clear_records()
                            
                            thread = threading.Thread(target=run_in_thread)
                            thread.start()
                            thread.join()  # Wait for completion
                            
                            # Check if there was an error
                            if isinstance(result, dict) and "error" in result:
                                st.error(f"❌ Error clearing Supabase docs: {result['error']}")
                            else:
                                st.success("✅ Successfully cleared existing Supabase docs from the database.")
                                # Force a rerun to update the UI
                                st.rerun()
                        except Exception as e:
                            import traceback
                            traceback.print_exc()
                            st.error(f"❌ Error clearing Supabase docs: {str(e)}")
            
            with col3:
                # Button for test crawl (a single page)
                test_button = st.button("Test Crawl (Single Page)", key="test_supabase_crawl")
                
                if test_button and not is_crawling:
                    try:
                        # Define a callback function to update the session state
                        def update_test_crawler_progress(status):
                            st.session_state.supabase_crawl_status = status
                        
                        # Start the test crawling process in a separate thread
                        st.session_state.supabase_crawl_tracker = start_test_crawler(update_test_crawler_progress)
                        st.session_state.supabase_crawl_status = st.session_state.supabase_crawl_tracker.get_status()
                        st.session_state.supabase_last_update_time = time.time()
                        
                        # Force a rerun to start showing progress
                        st.rerun()
                    except Exception as e:
                        st.error(f"❌ Error starting test crawl: {str(e)}")
            
            # Check if we have a tracker running - SIMPLIFIED VERSION
            if st.session_state.get("supabase_crawl_tracker"):
                
                # Get current status
                status = st.session_state.get("supabase_crawl_status", {})
                
                # Create a simple progress bar
                urls_found = status.get("urls_found", 0) 
                urls_processed = status.get("urls_processed", 0)
                progress_value = urls_processed / max(1, urls_found) if urls_found > 0 else 0
                progress = st.progress(progress_value)
                
                # Display simple stats
                col1, col2, col3, col4 = st.columns(4)
                with col1:
                    st.metric("URLs Found", status.get("urls_found", 0))
                with col2:
                    st.metric("URLs Processed", status.get("urls_processed", 0))
                with col3:
                    st.metric("Successes", status.get("urls_succeeded", 0))
                with col4:
                    st.metric("Failures", status.get("urls_failed", 0))
                
                # Determine crawler state
                is_running = status.get("is_running", True)
                has_ended = status.get("end_time") is not None or st.session_state.get("supabase_crawl_end_time") is not None
                is_stopping = status.get("is_stopping", False)
                
                # Display appropriate message
                if is_stopping:
                    st.warning("⏳ Crawl is stopping... Please wait.")
                elif not is_running and has_ended:
                    if status.get("urls_succeeded", 0) > 0:
                        st.success(f"✅ Crawl completed! Processed {status.get('urls_processed', 0)} URLs and stored {status.get('chunks_stored', 0)} chunks.")
                    else:
                        st.error("❌ Crawl completed but no documents were processed.")
                else:
                    if urls_processed > 0:
                        st.info(f"⏳ Crawling in progress... ({urls_processed}/{urls_found} URLs processed)")
                    else:
                        st.info("🔍 Preparing to crawl...")
                
                # Create a row of buttons for all possible actions
                button_cols = st.columns([1, 1, 1])
                
                # First column: Check Status button (always visible when crawler is running)
                with button_cols[0]:
                    if is_running or is_stopping:
                        if st.button("🔄 Check Status", key="check_supabase_status"):
                            # Manually get the latest status
                            current_status = st.session_state.supabase_crawl_tracker.get_status()
                            st.session_state.supabase_crawl_status = current_status
                            
                            # Check if the crawler has completed
                            if not current_status.get("is_running", True) and current_status.get("end_time") is not None:
                                st.session_state.supabase_crawl_end_time = current_status.get("end_time")
                                
                            # Show success message with the current progress
                            st.success(f"Status updated: {current_status.get('urls_processed', 0)}/{current_status.get('urls_found', 0)} URLs processed")
                            
                            # Force a rerun to show the updated status
                            st.rerun()
                
                # Second column: Stop or Clear button
                with button_cols[1]:
                    # Show either a stop button or clear button
                    if is_running and not is_stopping:
                        if st.button("⚠️ Stop Crawling", key="stop_supabase_crawl"):
                            # Stop the crawler
                            st.session_state.supabase_crawl_tracker.stop()
                            st.info("Stopping the crawl...")
                            st.rerun()
                    elif not is_running or has_ended:
                        if st.button("🗑️ Clear Status", key="clear_supabase_status"):
                            # Remove all crawler state
                            st.session_state.supabase_crawl_tracker = None
                            st.session_state.supabase_crawl_status = None
                            st.session_state.supabase_crawl_start_time = None
                            st.session_state.supabase_crawl_end_time = None
                            st.rerun()
                
                # Show logs in an expander
                with st.expander("📋 Show Crawl Logs", expanded=False):
                    logs = status.get("logs", [])
                    if logs:
                        st.code("\n".join(logs[::-1]))  # Display newest first
                    else:
                        st.text("No logs yet")
                         
                # Note: Removed the auto-refresh to avoid UI issues
                # Users can now manually check status with the "Check Status" button

    with doc_tabs[2]:
        st.subheader("Future Documentation Sources")
        st.markdown("""
        Additional documentation sources will be added in future updates.
        """)

@st.cache_data
def load_sql_template():
    """Load the SQL template file and cache it"""
    with open(os.path.join(os.path.dirname(__file__), "utils", "site_pages.sql"), "r") as f:
        return f.read()

def database_tab():
    """Display the database configuration interface"""
    st.header("Database Configuration")
    st.write("Set up and manage your Supabase database tables for Archon.")
    
    # Check if Supabase is configured
    if not supabase:
        st.error("Supabase is not configured. Please set your Supabase URL and Service Key in the Environment tab.")
        return
    
    # Site Pages Table Setup
    st.subheader("Site Pages Table")
    st.write("This table stores web page content and embeddings for semantic search.")
    
    # Add information about the table
    with st.expander("About the Site Pages Table", expanded=False):
        st.markdown("""
        This table is used to store:
        - Web page content split into chunks
        - Vector embeddings for semantic search
        - Metadata for filtering results
        
        The table includes:
        - URL and chunk number (unique together)
        - Title and summary of the content
        - Full text content
        - Vector embeddings for similarity search
        - Metadata in JSON format
        
        It also creates:
        - A vector similarity search function
        - Appropriate indexes for performance
        - Row-level security policies for Supabase
        """)
    
    # Check if the table already exists
    table_exists = False
    table_has_data = False
    
    try:
        # Try to query the table to see if it exists
        response = supabase.table("site_pages").select("id").limit(1).execute()
        table_exists = True
        
        # Check if the table has data
        count_response = supabase.table("site_pages").select("*", count="exact").execute()
        row_count = count_response.count if hasattr(count_response, 'count') else 0
        table_has_data = row_count > 0
        
        st.success("✅ The site_pages table already exists in your database.")
        if table_has_data:
            st.info(f"The table contains data ({row_count} rows).")
        else:
            st.info("The table exists but contains no data.")
    except Exception as e:
        error_str = str(e)
        if "relation" in error_str and "does not exist" in error_str:
            st.info("The site_pages table does not exist yet. You can create it below.")
        else:
            st.error(f"Error checking table status: {error_str}")
            st.info("Proceeding with the assumption that the table needs to be created.")
        table_exists = False
    
    # Vector dimensions selection
    st.write("### Vector Dimensions")
    st.write("Select the embedding dimensions based on your embedding model:")
    
    vector_dim = st.selectbox(
        "Embedding Dimensions",
        options=[1536, 768, 384, 1024],
        index=0,
        help="Use 1536 for OpenAI embeddings, 768 for nomic-embed-text with Ollama, or select another dimension based on your model."
    )
    
    # Get the SQL with the selected vector dimensions
    sql_template = load_sql_template()
    
    # Replace the vector dimensions in the SQL
    sql = sql_template.replace("vector(1536)", f"vector({vector_dim})")
    
    # Also update the match_site_pages function dimensions
    sql = sql.replace("query_embedding vector(1536)", f"query_embedding vector({vector_dim})")
    
    # Show the SQL
    with st.expander("View SQL", expanded=False):
        st.code(sql, language="sql")
    
    # Create table button
    if not table_exists:
        if st.button("Get Instructions for Creating Site Pages Table"):
            show_manual_sql_instructions(sql)
    else:
        # Option to recreate the table or clear data
        col1, col2 = st.columns(2)
        
        with col1:
            st.warning("⚠️ Recreating will delete all existing data.")
            if st.button("Get Instructions for Recreating Site Pages Table"):
                show_manual_sql_instructions(sql, recreate=True)
        
        with col2:
            if table_has_data:
                st.warning("⚠️ Clear all data but keep structure.")
                if st.button("Clear Table Data"):
                    try:
                        with st.spinner("Clearing table data..."):
                            # Use the Supabase client to delete all rows
                            response = supabase.table("site_pages").delete().neq("id", 0).execute()
                            st.success("✅ Table data cleared successfully!")
                            st.rerun()
                    except Exception as e:
                        st.error(f"Error clearing table data: {str(e)}")
                        # Fall back to manual SQL
                        truncate_sql = "TRUNCATE TABLE site_pages;"
                        st.code(truncate_sql, language="sql")
                        st.info("Execute this SQL in your Supabase SQL Editor to clear the table data.")
                        
                        # Provide a link to the Supabase SQL Editor
                        supabase_url = get_env_var("SUPABASE_URL")
                        if supabase_url:
                            dashboard_url = get_supabase_sql_editor_url(supabase_url)
                            st.markdown(f"[Open Your Supabase SQL Editor with this URL]({dashboard_url})")
                    
def get_supabase_sql_editor_url(supabase_url):
    """Get the URL for the Supabase SQL Editor"""
    try:
        # Extract the project reference from the URL
        # Format is typically: https://<project-ref>.supabase.co
        if '//' in supabase_url:
            parts = supabase_url.split('//')
            if len(parts) > 1:
                domain_parts = parts[1].split('.')
                if len(domain_parts) > 0:
                    project_ref = domain_parts[0]
                    return f"https://supabase.com/dashboard/project/{project_ref}/sql/new"
        
        # Fallback to a generic URL
        return "https://supabase.com/dashboard"
    except Exception:
        return "https://supabase.com/dashboard"

def show_manual_sql_instructions(sql, recreate=False):
    """Show instructions for manually executing SQL in Supabase"""
    st.info("### Manual SQL Execution Instructions")
    
    # Provide a link to the Supabase SQL Editor
    supabase_url = get_env_var("SUPABASE_URL")
    if supabase_url:
        dashboard_url = get_supabase_sql_editor_url(supabase_url)
        st.markdown(f"**Step 1:** [Open Your Supabase SQL Editor with this URL]({dashboard_url})")
    else:
        st.markdown("**Step 1:** Open your Supabase Dashboard and navigate to the SQL Editor")
    
    st.markdown("**Step 2:** Create a new SQL query")
    
    if recreate:
        st.markdown("**Step 3:** Copy and execute the following SQL:")
        drop_sql = "DROP TABLE IF EXISTS site_pages CASCADE;"
        st.code(drop_sql, language="sql")
        
        st.markdown("**Step 4:** Then copy and execute this SQL:")
        st.code(sql, language="sql")
    else:
        st.markdown("**Step 3:** Copy and execute the following SQL:")
        st.code(sql, language="sql")
    
    st.success("After executing the SQL, return to this page and refresh to see the updated table status.")

def agent_service_tab():
    """Display the agent service interface for managing the graph service"""
    st.header("MCP Agent Service")
    st.write("Start, restart, and monitor the Archon agent service for MCP.")
    
    # Initialize session state variables if they don't exist
    if "service_process" not in st.session_state:
        st.session_state.service_process = None
    if "service_running" not in st.session_state:
        st.session_state.service_running = False
    if "service_output" not in st.session_state:
        st.session_state.service_output = []
    if "output_queue" not in st.session_state:
        st.session_state.output_queue = queue.Queue()
    
    # Function to check if the service is running
    def is_service_running():
        if st.session_state.service_process is None:
            return False
        
        # Check if process is still running
        return st.session_state.service_process.poll() is None
    
    # Function to kill any process using port 8100
    def kill_process_on_port(port):
        try:
            if platform.system() == "Windows":
                # Windows: use netstat to find the process using the port
                result = subprocess.run(
                    f'netstat -ano | findstr :{port}',
                    shell=True, 
                    capture_output=True, 
                    text=True
                )
                
                if result.stdout:
                    # Extract the PID from the output
                    for line in result.stdout.splitlines():
                        if f":{port}" in line and "LISTENING" in line:
                            parts = line.strip().split()
                            pid = parts[-1]
                            # Kill the process
                            subprocess.run(f'taskkill /F /PID {pid}', shell=True)
                            st.session_state.output_queue.put(f"[{time.strftime('%H:%M:%S')}] Killed any existing process using port {port} (PID: {pid})\n")
                            return True
            else:
                # Unix-like systems: use lsof to find the process using the port
                result = subprocess.run(
                    f'lsof -i :{port} -t',
                    shell=True, 
                    capture_output=True, 
                    text=True
                )
                
                if result.stdout:
                    # Extract the PID from the output
                    pid = result.stdout.strip()
                    # Kill the process
                    subprocess.run(f'kill -9 {pid}', shell=True)
                    st.session_state.output_queue.put(f"[{time.strftime('%H:%M:%S')}] Killed process using port {port} (PID: {pid})\n")
                    return True
                    
            return False
        except Exception as e:
            st.session_state.output_queue.put(f"[{time.strftime('%H:%M:%S')}] Error killing process on port {port}: {str(e)}\n")
            return False
    
    # Update service status
    st.session_state.service_running = is_service_running()
    
    # Process any new output in the queue
    try:
        while not st.session_state.output_queue.empty():
            line = st.session_state.output_queue.get_nowait()
            if line:
                st.session_state.service_output.append(line)
    except Exception:
        pass
    
    # Create button text based on service status
    button_text = "Restart Agent Service" if st.session_state.service_running else "Start Agent Service"
    
    # Create columns for buttons
    col1, col2 = st.columns([1, 1])
    
    # Start/Restart button
    with col1:
        if st.button(button_text, use_container_width=True):
            # Stop existing process if running
            if st.session_state.service_running:
                try:
                    st.session_state.service_process.terminate()
                    time.sleep(1)  # Give it time to terminate
                    if st.session_state.service_process.poll() is None:
                        # Force kill if still running
                        st.session_state.service_process.kill()
                except Exception as e:
                    st.error(f"Error stopping service: {str(e)}")
            
            # Clear previous output
            st.session_state.service_output = []
            st.session_state.output_queue = queue.Queue()
            
            # Kill any process using port 8100
            kill_process_on_port(8100)
            
            # Start new process
            try:
                # Get the absolute path to the graph service script
                base_path = os.path.abspath(os.path.dirname(__file__))
                graph_service_path = os.path.join(base_path, 'graph_service.py')
                
                # Start the process with output redirection
                process = subprocess.Popen(
                    [sys.executable, graph_service_path],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    bufsize=1,
                    universal_newlines=True
                )
                
                st.session_state.service_process = process
                st.session_state.service_running = True
                
                # Start threads to read output
                def read_output(stream, queue_obj):
                    for line in iter(stream.readline, ''):
                        queue_obj.put(line)
                    stream.close()
                
                # Start threads for stdout and stderr
                threading.Thread(target=read_output, args=(process.stdout, st.session_state.output_queue), daemon=True).start()
                threading.Thread(target=read_output, args=(process.stderr, st.session_state.output_queue), daemon=True).start()
                
                # Add startup message
                st.session_state.output_queue.put(f"[{time.strftime('%H:%M:%S')}] Agent service started\n")
                
                st.success("Agent service started successfully!")
                st.rerun()
                
            except Exception as e:
                st.error(f"Error starting service: {str(e)}")
                st.session_state.output_queue.put(f"[{time.strftime('%H:%M:%S')}] Error: {str(e)}\n")
    
    # Stop button
    with col2:
        stop_button = st.button("Stop Agent Service", disabled=not st.session_state.service_running, use_container_width=True)
        if stop_button and st.session_state.service_running:
            try:
                st.session_state.service_process.terminate()
                time.sleep(1)  # Give it time to terminate
                if st.session_state.service_process.poll() is None:
                    # Force kill if still running
                    st.session_state.service_process.kill()
                
                st.session_state.service_running = False
                st.session_state.output_queue.put(f"[{time.strftime('%H:%M:%S')}] Agent service stopped\n")
                st.success("Agent service stopped successfully!")
                st.rerun()
                
            except Exception as e:
                st.error(f"Error stopping service: {str(e)}")
                st.session_state.output_queue.put(f"[{time.strftime('%H:%M:%S')}] Error stopping: {str(e)}\n")
    
    # Service status indicator
    status_color = "🟢" if st.session_state.service_running else "🔴"
    status_text = "Running" if st.session_state.service_running else "Stopped"
    st.write(f"**Service Status:** {status_color} {status_text}")
    
    # Add auto-refresh option
    auto_refresh = st.checkbox("Auto-refresh output (uncheck this before copying any error message)", value=True)
    
    # Display output in a scrollable container
    st.subheader("Service Output")
    
    # Calculate height based on number of lines, but cap it
    output_height = min(400, max(200, len(st.session_state.service_output) * 20))
    
    # Create a scrollable container for the output
    with st.container():
        # Join all output lines and display in the container
        output_text = "".join(st.session_state.service_output)
        
        # For auto-scrolling, we'll use a different approach
        if auto_refresh and st.session_state.service_running and output_text:
            # We'll reverse the output text so the newest lines appear at the top
            # This way they're always visible without needing to scroll
            lines = output_text.splitlines()
            reversed_lines = lines[::-1]  # Reverse the lines
            output_text = "\n".join(reversed_lines)
            
            # Add a note at the top (which will appear at the bottom of the reversed text)
            note = "--- SHOWING NEWEST LOGS FIRST (AUTO-SCROLL MODE) ---\n\n"
            output_text = note + output_text
        
        # Use a text area for scrollable output
        st.text_area(
            label="Realtime Logs from Archon Service",
            value=output_text,
            height=output_height,
            disabled=True,
            key="output_text_area"  # Use a fixed key to maintain state between refreshes
        )
        
        # Add a toggle for reversed mode
        if auto_refresh and st.session_state.service_running:
            st.caption("Logs are shown newest-first for auto-scrolling. Disable auto-refresh to see logs in chronological order.")
    
    # Add a clear output button
    if st.button("Clear Output"):
        st.session_state.service_output = []
        st.rerun()
    
    # Auto-refresh if enabled and service is running
    if auto_refresh and st.session_state.service_running:
        time.sleep(0.1)  # Small delay to prevent excessive CPU usage
        st.rerun()

def environment_tab():
    """Display the environment variables configuration interface"""
    st.header("Environment Variables")
    st.write("- Configure your environment variables for Archon. These settings will be saved and used for future sessions.")
    st.write("- NOTE: Press 'enter' to save after inputting a variable, otherwise click the 'save' button at the bottom.")
    st.write("- HELP: Hover over the '?' icon on the right for each environment variable for help/examples.")
    st.warning("⚠️ If your agent service for MCP is already running, you'll need to restart it after changing environment variables.")

    # Define environment variables and their descriptions from .env.example
    env_vars = {
        "BASE_URL": {
            "description": "Base URL for the OpenAI instance (default is https://api.openai.com/v1)",
            "help": "OpenAI: https://api.openai.com/v1\n\n\n\nAnthropic: https://api.anthropic.com/v1\n\nOllama (example): http://localhost:11434/v1\n\nOpenRouter: https://openrouter.ai/api/v1",
            "sensitive": False
        },
        "LLM_API_KEY": {
            "description": "API key for your LLM provider",
            "help": "For OpenAI: https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key\n\nFor Anthropic: https://console.anthropic.com/account/keys\n\nFor OpenRouter: https://openrouter.ai/keys\n\nFor Ollama, no need to set this unless you specifically configured an API key",
            "sensitive": True
        },
        "OPENAI_API_KEY": {
            "description": "Your OpenAI API key",
            "help": "Get your Open AI API Key by following these instructions -\n\nhttps://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key\n\nEven if using OpenRouter, you still need to set this for the embedding model.\n\nNo need to set this if using Ollama.",
            "sensitive": True
        },
        "SUPABASE_URL": {
            "description": "URL for your Supabase project",
            "help": "Get your SUPABASE_URL from the API section of your Supabase project settings -\nhttps://supabase.com/dashboard/project/<your project ID>/settings/api",
            "sensitive": False
        },
        "SUPABASE_SERVICE_KEY": {
            "description": "Service key for your Supabase project",
            "help": "Get your SUPABASE_SERVICE_KEY from the API section of your Supabase project settings -\nhttps://supabase.com/dashboard/project/<your project ID>/settings/api\nOn this page it is called the service_role secret.",
            "sensitive": True
        },
        "REASONER_MODEL": {
            "description": "The LLM you want to use for the reasoner",
            "help": "Example: o3-mini\n\nExample: deepseek-r1:7b-8k",
            "sensitive": False
        },
        "PRIMARY_MODEL": {
            "description": "The LLM you want to use for the primary agent/coder",
            "help": "Example: gpt-4o-mini\n\nExample: qwen2.5:14b-instruct-8k",
            "sensitive": False
        },
        "EMBEDDING_MODEL": {
            "description": "Embedding model you want to use",
            "help": "Example for Ollama: nomic-embed-text\n\nExample for OpenAI: text-embedding-3-small",
            "sensitive": False
        }
    }
    
    # Create a form for the environment variables
    with st.form("env_vars_form"):
        updated_values = {}
        
        # Display input fields for each environment variable
        for var_name, var_info in env_vars.items():
            current_value = get_env_var(var_name) or ""
            
            # Display the variable description
            st.subheader(var_name)
            st.write(var_info["description"])
            
            # Display input field (password field for sensitive data)
            if var_info["sensitive"]:
                # If there's already a value, show asterisks in the placeholder
                placeholder = "Set but hidden" if current_value else ""
                new_value = st.text_input(
                    f"Enter {var_name}:", 
                    type="password",
                    help=var_info["help"],
                    key=f"input_{var_name}",
                    placeholder=placeholder
                )
                # Only update if user entered something (to avoid overwriting with empty string)
                if new_value:
                    updated_values[var_name] = new_value
            else:
                new_value = st.text_input(
                    f"Enter {var_name}:", 
                    value=current_value,
                    help=var_info["help"],
                    key=f"input_{var_name}"
                )
                # Always update non-sensitive values (can be empty)
                updated_values[var_name] = new_value
            
            # Add a separator between variables
            st.markdown("---")
        
        # Submit button
        submitted = st.form_submit_button("Save Environment Variables")
        
        if submitted:
            # Save all updated values
            success = True
            for var_name, value in updated_values.items():
                if value:  # Only save non-empty values
                    if not save_env_var(var_name, value):
                        success = False
                        st.error(f"Failed to save {var_name}.")
            
            if success:
                st.success("Environment variables saved successfully!")
                reload_archon_graph()

# Create a module-level lock for thread synchronization
# This will be accessible from all threads
supabase_crawler_lock = Lock()

async def main():
    # Check for tab query parameter
    query_params = st.query_params
    if "tab" in query_params:
        tab_name = query_params["tab"]
        if tab_name in ["Intro", "Chat", "Environment", "Database", "Documentation", "Agent Service", "MCP", "Future Enhancements"]:
            st.session_state.selected_tab = tab_name

    # Add sidebar navigation
    with st.sidebar:
        st.image("public/ArchonLightGrey.png", width=1000)
        
        # Navigation options with vertical buttons
        st.write("### Navigation")
        
        # Initialize session state for selected tab if not present
        if "selected_tab" not in st.session_state:
            st.session_state.selected_tab = "Intro"
        
        # Vertical navigation buttons
        intro_button = st.button("Intro", use_container_width=True, key="intro_button")
        chat_button = st.button("Chat", use_container_width=True, key="chat_button")
        env_button = st.button("Environment", use_container_width=True, key="env_button")
        db_button = st.button("Database", use_container_width=True, key="db_button")
        docs_button = st.button("Documentation", use_container_width=True, key="docs_button")
        service_button = st.button("Agent Service", use_container_width=True, key="service_button")
        mcp_button = st.button("MCP", use_container_width=True, key="mcp_button")
        future_enhancements_button = st.button("Future Enhancements", use_container_width=True, key="future_enhancements_button")
        
        # Update selected tab based on button clicks
        if intro_button:
            st.session_state.selected_tab = "Intro"
        elif chat_button:
            st.session_state.selected_tab = "Chat"
        elif mcp_button:
            st.session_state.selected_tab = "MCP"
        elif env_button:
            st.session_state.selected_tab = "Environment"
        elif service_button:
            st.session_state.selected_tab = "Agent Service"
        elif db_button:
            st.session_state.selected_tab = "Database"
        elif docs_button:
            st.session_state.selected_tab = "Documentation"
        elif future_enhancements_button:
            st.session_state.selected_tab = "Future Enhancements"
    
    # Display the selected tab
    if st.session_state.selected_tab == "Intro":
        st.title("Archon - Introduction")
        intro_tab()
    elif st.session_state.selected_tab == "Chat":
        st.title("Archon - Agent Builder")
        await chat_tab()
    elif st.session_state.selected_tab == "MCP":
        st.title("Archon - MCP Configuration")
        mcp_tab()
    elif st.session_state.selected_tab == "Environment":
        st.title("Archon - Environment Configuration")
        environment_tab()
    elif st.session_state.selected_tab == "Agent Service":
        st.title("Archon - Agent Service")
        agent_service_tab()
    elif st.session_state.selected_tab == "Database":
        st.title("Archon - Database Configuration")
        database_tab()
    elif st.session_state.selected_tab == "Documentation":
        st.title("Archon - Documentation")
        documentation_tab()
    elif st.session_state.selected_tab == "Future Enhancements":
        st.title("Archon - Future Enhancements")
        future_enhancements_tab()

if __name__ == "__main__":
    asyncio.run(main())
