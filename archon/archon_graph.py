from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai import Agent, RunContext
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver
from typing import TypedDict, Annotated, List, Any
from openai import AsyncOpenAI, AsyncAzureOpenAI
from langgraph.config import get_stream_writer
from langgraph.types import interrupt
from dotenv import load_dotenv
from openai import AsyncOpenAI
from supabase import Client
import logfire
import os
import sys

# Import the message classes from Pydantic AI
from pydantic_ai.messages import (
    ModelMessage,
    ModelMessagesTypeAdapter
)

# Add the parent directory to Python path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from archon.pydantic_ai_coder import pydantic_ai_coder, PydanticAIDeps, list_documentation_pages_helper
from utils.utils import get_env_var, get_clients

# Load environment variables
load_dotenv()

# Configure logfire to suppress warnings (optional)
logfire.configure(send_to_logfire='never')

provider = get_env_var('LLM_PROVIDER') or 'OpenAI'
base_url = get_env_var('BASE_URL') or 'https://api.openai.com/v1'
api_key = get_env_var('LLM_API_KEY') or 'no-llm-api-key-provided'
api_version = get_env_var('LLM_API_VERSION') or ''
# Reasoning Model
reasoning_provider = get_env_var('Reasoning_LLM_PROVIDER') or 'OpenAI'
reasoning_base_url = get_env_var('Reasoning_BASE_URL') or 'https://api.openai.com/v1'
reasoning_api_key = get_env_var('Reasoning_LLM_API_KEY') or 'no-llm-api-key-provided'
reasoning_api_version = get_env_var('Reasoning_LLM_API_VERSION') or ''

is_anthropic = provider == "Anthropic"
is_openai = provider == "OpenAI"
is_azure_openai = provider == "AzureOpenAI"
is_ollama= provider == "Ollama"
is_open_router= provider == "OpenRouter"

is_reasoning_anthropic = reasoning_provider == "Anthropic"
is_reasoning_openai = reasoning_provider == "OpenAI"
is_reasoning_azure_openai = reasoning_provider == "AzureOpenAI"
is_reasoning_ollama= reasoning_provider == "Ollama"
is_reasoning_open_router= reasoning_provider == "OpenRouter"

reasoner_llm_model_name = get_env_var('REASONER_MODEL') or 'o3-mini'
if is_reasoning_azure_openai:
    reasoning_llm_client=AsyncAzureOpenAI(api_key=reasoning_api_key, azure_endpoint=reasoning_base_url, api_version=reasoning_api_version)
elif is_reasoning_openai:
    reasoning_llm_client=AsyncOpenAI(base_url=reasoning_base_url, api_key=reasoning_api_key)
elif is_reasoning_anthropic:
    reasoning_llm_client = AsyncOpenAI(base_url=reasoning_base_url, api_key=reasoning_api_key)
elif is_reasoning_open_router:
    reasoning_llm_client=AsyncOpenAI(base_url=reasoning_base_url, api_key=reasoning_api_key)
elif is_reasoning_ollama:
    reasoning_llm_client=AsyncOpenAI(base_url=reasoning_base_url, api_key=reasoning_api_key)


reasoner = Agent(  
    OpenAIModel(reasoner_llm_model_name, openai_client=reasoning_llm_client),
    system_prompt='You are an expert at coding AI agents with Pydantic AI and defining the scope for doing so.',  
)

primary_llm_model_name = get_env_var('PRIMARY_MODEL') or 'gpt-4o-mini'
if is_azure_openai:
    llm_client=AsyncAzureOpenAI(api_key=api_key, azure_endpoint=base_url, api_version=api_version)
elif is_openai:
    llm_client=AsyncOpenAI(base_url=base_url, api_key=api_key)
elif is_anthropic:
    llm_client = AsyncOpenAI(base_url=base_url, api_key=api_key)
elif is_open_router:
    llm_client=AsyncOpenAI(base_url=base_url, api_key=api_key)
elif is_ollama:
    llm_client=AsyncOpenAI(base_url=base_url, api_key=api_key)

router_agent = Agent(  
    OpenAIModel(primary_llm_model_name, openai_client=llm_client),
    system_prompt='Your job is to route the user message either to the end of the conversation or to continue coding the AI agent.',  
)

end_conversation_agent = Agent(  
    OpenAIModel(primary_llm_model_name, openai_client=llm_client),
    system_prompt='Your job is to end a conversation for creating an AI agent by giving instructions for how to execute the agent and they saying a nice goodbye to the user.',  
)

# Initialize clients
embedding_client, supabase = get_clients()

# Define state schema
class AgentState(TypedDict):
    latest_user_message: str
    messages: Annotated[List[bytes], lambda x, y: x + y]
    scope: str

# Scope Definition Node with Reasoner LLM
async def define_scope_with_reasoner(state: AgentState):
    # First, get the documentation pages so the reasoner can decide which ones are necessary
    documentation_pages = await list_documentation_pages_helper(supabase)
    documentation_pages_str = "\n".join(documentation_pages)

    # Then, use the reasoner to define the scope
    prompt = f"""
    User AI Agent Request: {state['latest_user_message']}
    
    Create detailed scope document for the AI agent including:
    - Architecture diagram
    - Core components
    - External dependencies
    - Testing strategy

    Also based on these documentation pages available:

    {documentation_pages_str}

    Include a list of documentation pages that are relevant to creating this agent for the user in the scope document.
    """

    result = await reasoner.run(prompt)
    scope = result.data

    # Get the directory one level up from the current file
    current_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(current_dir)
    scope_path = os.path.join(parent_dir, "workbench", "scope.md")
    os.makedirs(os.path.join(parent_dir, "workbench"), exist_ok=True)

    with open(scope_path, "w", encoding="utf-8") as f:
        f.write(scope)
    
    return {"scope": scope}

# Coding Node with Feedback Handling
async def coder_agent(state: AgentState, writer):    
    # Prepare dependencies
    deps = PydanticAIDeps(
        supabase=supabase,
        embedding_client=embedding_client,
        reasoner_output=state['scope']
    )

    # Get the message history into the format for Pydantic AI
    message_history: list[ModelMessage] = []
    for message_row in state['messages']:
        message_history.extend(ModelMessagesTypeAdapter.validate_json(message_row))

    # Run the agent in a stream
    if not is_openai:
        writer = get_stream_writer()
        result = await pydantic_ai_coder.run(state['latest_user_message'], deps=deps, message_history= message_history)
        writer(result.data)
    else:
        async with pydantic_ai_coder.run_stream(
            state['latest_user_message'],
            deps=deps,
            message_history= message_history
        ) as result:
            # Stream partial text as it arrives
            async for chunk in result.stream_text(delta=True):
                writer(chunk)

    # print(ModelMessagesTypeAdapter.validate_json(result.new_messages_json()))

    return {"messages": [result.new_messages_json()]}

# Interrupt the graph to get the user's next message
def get_next_user_message(state: AgentState):
    value = interrupt({})

    # Set the user's latest message for the LLM to continue the conversation
    return {
        "latest_user_message": value
    }

# Determine if the user is finished creating their AI agent or not
async def route_user_message(state: AgentState):
    prompt = f"""
    The user has sent a message: 
    
    {state['latest_user_message']}

    If the user wants to end the conversation, respond with just the text "finish_conversation".
    If the user wants to continue coding the AI agent, respond with just the text "coder_agent".
    """

    result = await router_agent.run(prompt)
    
    if result.data == "finish_conversation": return "finish_conversation"
    return "coder_agent"

# End of conversation agent to give instructions for executing the agent
async def finish_conversation(state: AgentState, writer):    
    # Get the message history into the format for Pydantic AI
    message_history: list[ModelMessage] = []
    for message_row in state['messages']:
        message_history.extend(ModelMessagesTypeAdapter.validate_json(message_row))

    # Run the agent in a stream
    if not is_openai:
        writer = get_stream_writer()
        result = await end_conversation_agent.run(state['latest_user_message'], message_history= message_history)
        writer(result.data)   
    else: 
        async with end_conversation_agent.run_stream(
            state['latest_user_message'],
            message_history= message_history
        ) as result:
            # Stream partial text as it arrives
            async for chunk in result.stream_text(delta=True):
                writer(chunk)

    return {"messages": [result.new_messages_json()]}        

# Build workflow
builder = StateGraph(AgentState)

# Add nodes
builder.add_node("define_scope_with_reasoner", define_scope_with_reasoner)
builder.add_node("coder_agent", coder_agent)
builder.add_node("get_next_user_message", get_next_user_message)
builder.add_node("finish_conversation", finish_conversation)

# Set edges
builder.add_edge(START, "define_scope_with_reasoner")
builder.add_edge("define_scope_with_reasoner", "coder_agent")
builder.add_edge("coder_agent", "get_next_user_message")
builder.add_conditional_edges(
    "get_next_user_message",
    route_user_message,
    {"coder_agent": "coder_agent", "finish_conversation": "finish_conversation"}
)
builder.add_edge("finish_conversation", END)

# Configure persistence
memory = MemorySaver()
agentic_flow = builder.compile(checkpointer=memory)