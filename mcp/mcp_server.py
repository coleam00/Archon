from mcp.server.fastmcp import FastMCP
from datetime import datetime
from dotenv import load_dotenv
from typing import Dict, List
import threading
import requests
import asyncio
import uuid
import sys
import os

# Load environment variables from .env file
load_dotenv()

# Initialize FastMCP server with ERROR logging level
mcp = FastMCP("archon", log_level="ERROR")

# Store active threads
active_threads: Dict[str, List[str]] = {}

# FastAPI service URL
GRAPH_SERVICE_URL = os.getenv("GRAPH_SERVICE_URL", "http://localhost:8100")

def write_to_log(message: str):
    """Write a message to the logs.txt file in the workbench directory.
    
    Args:
        message: The message to log
    """
    # Get the directory one level up from the current file
    current_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(current_dir)
    workbench_dir = os.path.join(parent_dir, "workbench")
    log_path = os.path.join(workbench_dir, "logs.txt")
    os.makedirs(workbench_dir, exist_ok=True)

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_entry = f"[{timestamp}] {message}\n"

    with open(log_path, "a", encoding="utf-8") as f:
        f.write(log_entry)

@mcp.tool()
async def create_thread() -> str:
    """Create a new conversation thread for Archon.
    Always call this tool before invoking Archon for the first time in a conversation.
    (if you don't already have a thread ID)
    
    Returns:
        str: A unique thread ID for the conversation
    """
    thread_id = str(uuid.uuid4())
    active_threads[thread_id] = []
    write_to_log(f"Created new thread: {thread_id}")
    return thread_id


def _make_request(thread_id: str, user_input: str, config: dict) -> str:
    """Make synchronous request to graph service"""
    response = requests.post(
        f"{GRAPH_SERVICE_URL}/invoke",
        json={
            "message": user_input,
            "thread_id": thread_id,
            "is_first_message": not active_threads[thread_id],
            "config": config
    }
    )
    response.raise_for_status()
    return response.json()


@mcp.tool()
async def run_agent(thread_id: str, user_input: str) -> str:
    """Run the Archon agent with user input.
    Only use this tool after you have called create_thread in this conversation to get a unique thread ID.
    If you already created a thread ID in this conversation, do not create another one. Reuse the same ID.
    After you receive the code from Archon, always implement it into the codebase unless asked not to.
    
    Args:
        thread_id: The conversation thread ID
        user_input: The user's message to process
    
    Returns:
        str: The agent's response which generally includes the code for the agent
    """
    if thread_id not in active_threads:
        write_to_log(f"Error: Thread not found - {thread_id}")
        raise ValueError("Thread not found")

    write_to_log(f"Processing message for thread {thread_id}: {user_input}")

    config = {
        "configurable": {
            "thread_id": thread_id
        }
    }
    
    try:
        result = await asyncio.to_thread(_make_request, thread_id, user_input, config)
        active_threads[thread_id].append(user_input)
        return result['response']
        
    except Exception as e:
        raise


if __name__ == "__main__":
    write_to_log("Starting MCP server")
    
    # Run MCP server
    mcp.run(transport='stdio')

