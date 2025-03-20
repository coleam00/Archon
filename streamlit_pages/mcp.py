import streamlit as st
import platform
import json
import os

def get_paths():
    # Get the absolute path to the current directory
    base_path = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
    
    # Determine the correct python path based on the OS
    if platform.system() == "Windows":
        python_path = os.path.join(base_path, 'venv', 'Scripts', 'python.exe')
    else:  # macOS or Linux
        python_path = os.path.join(base_path, 'venv', 'bin', 'python')
    
    server_script_path = os.path.join(base_path, 'mcp', 'mcp_server.py')

    return python_path, server_script_path

def generate_mcp_config(ide_type, python_path, server_script_path):
    """
    Generate MCP configuration for the selected IDE type.
    """    
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
                    "--add-host=host.docker.internal:host-gateway",
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
        return f"{python_path} {server_script_path}", f"docker run -i --rm --add-host=host.docker.internal:host-gateway -e GRAPH_SERVICE_URL=http://host.docker.internal:8100 archon-mcp:latest"
    elif ide_type == "Cline/Roo Code":
        return json.dumps(python_config, indent=2), json.dumps(docker_config, indent=2)
    elif ide_type == "Claude Code":
        return f"Not Required", "Not Required"
    else:
        return "Unknown IDE type selected", "Unknown IDE type selected"

def mcp_tab():
    """Display the MCP configuration interface"""
    st.header("MCP Configuration")
    st.write("Select your AI IDE to get the appropriate MCP configuration:")
    
    # IDE selection with side-by-side buttons
    col1, col2, col3, col4 = st.columns(4)
    
    with col1:
        windsurf_button = st.button("Windsurf", use_container_width=True, key="windsurf_button")
    with col2:
        cursor_button = st.button("Cursor", use_container_width=True, key="cursor_button")
    with col3:
        cline_button = st.button("Cline/Roo Code", use_container_width=True, key="cline_button")
    with col4:
        claude_button = st.button("Claude Code", use_container_width=True, key="claude_button")
    
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
    elif claude_button:
        st.session_state.selected_ide = "Claude Code"
    
    # Display configuration if an IDE is selected
    if st.session_state.selected_ide:
        selected_ide = st.session_state.selected_ide
        st.subheader(f"MCP Configuration for {selected_ide}")
        python_path, server_script_path = get_paths()
        python_config, docker_config = generate_mcp_config(selected_ide, python_path, server_script_path)
        
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
        elif selected_ide == "Claude Code":
            st.markdown(f"""
            #### How to use in Claude Code:
            1. Deploy and run Archon in Docker
            2. In the Archon UI, start the MCP service.
            3. Open a terminal and navigate to your work folder.
            4. Execute the command: 
            
            \tFor Docker: `claude mcp add Archon docker run -i --rm -e GRAPH_SERVICE_URL=http://host.docker.internal:8100 archon-mcp:latest `   
            \tFor Python: `claude mcp add Archon {python_path} {server_script_path}`
            
            5. Start Claude Code with the command `claude`. When Claude Code starts, at the bottom of the welcome section will be a listing of connected MCP Services, Archon should be listed with a status of _connected_.
            6. You can now use the Archon MCP service in your Claude Code projects
                        
            (NOTE: If you close the terminal, or start a session in a new terminal, you will need to re-add the MCP service.)
            """)