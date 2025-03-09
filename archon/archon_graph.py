from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai import Agent, RunContext
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver
from typing import TypedDict, Annotated, List, Any
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
from archon.pydantic_ai_coder import pydantic_ai_coder, PydanticAIDeps, list_documentation_pages_helper as pydantic_docs_helper
from archon.supabase_coder import supabase_coder, SupabaseDeps, list_documentation_pages_helper as supabase_docs_helper
from utils.utils import get_env_var

# Load environment variables
load_dotenv()

# Configure logfire to suppress warnings (optional)
logfire.configure(send_to_logfire='never')

base_url = get_env_var('BASE_URL') or 'https://api.openai.com/v1'
api_key = get_env_var('LLM_API_KEY') or 'no-llm-api-key-provided'

is_ollama = "localhost" in base_url.lower()
is_anthropic = "anthropic" in base_url.lower()
is_openai = "openai" in base_url.lower()

reasoner_llm_model_name = get_env_var('REASONER_MODEL') or 'o3-mini'
reasoner_llm_model = AnthropicModel(reasoner_llm_model_name, api_key=api_key) if is_anthropic else OpenAIModel(reasoner_llm_model_name, base_url=base_url, api_key=api_key)

pydantic_reasoner = Agent(  
    reasoner_llm_model,
    system_prompt='You are an expert at coding AI agents with Pydantic AI and defining the scope for doing so. Provide concise, focused responses that prioritize essential information.',  
)

supabase_reasoner = Agent(  
    reasoner_llm_model,
    system_prompt='You are an expert at building applications with Supabase and defining the scope for doing so. Provide concise, focused responses that prioritize essential information.',  
)

primary_llm_model_name = get_env_var('PRIMARY_MODEL') or 'gpt-4o-mini'
primary_llm_model = AnthropicModel(primary_llm_model_name, api_key=api_key) if is_anthropic else OpenAIModel(primary_llm_model_name, base_url=base_url, api_key=api_key)

router_agent = Agent(  
    primary_llm_model,
    system_prompt='Your job is to route the user message either to the end of the conversation or to continue coding the application or agent.',  
)

end_conversation_agent = Agent(  
    primary_llm_model,
    system_prompt='Your job is to end a conversation for creating an application or agent by giving brief instructions for how to execute it and then saying a nice goodbye to the user.',  
)

openai_client=None

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

# Define state schema
class AgentState(TypedDict):
    latest_user_message: str
    messages: Annotated[List[bytes], lambda x, y: x + y]
    scope: str
    agent_type: str = "Pydantic AI Agent"  # Default to Pydantic AI Agent if not specified

# Scope Definition Node with Reasoner LLM
async def define_scope_with_reasoner(state: AgentState):
    # Check if the message is related to Supabase or vector search
    user_message = state['latest_user_message'].lower()
    supabase_keywords = [
        'supabase', 'vector search', 'vector database', 'pgvector', 
        'similarity search', 'embedding', 'websocket', 'realtime', 
        'postgres', 'postgresql', 'sql', 'database', 'auth', 'storage'
    ]
    
    # Check if any of the keywords are in the user message
    is_supabase_related = any(keyword in user_message for keyword in supabase_keywords)
    
    # Set the agent type based on the message content
    if is_supabase_related:
        # Force the agent type to be Supabase Agent
        state['agent_type'] = "Supabase Agent"
        print(f"\n====================================================")
        print(f"[AGENT SELECTION] Using Supabase Agent based on query content")
        print(f"[AGENT SELECTION] Keywords found: {[k for k in supabase_keywords if k in user_message]}")
        print(f"====================================================\n")
    else:
        # Force the agent type to be Pydantic AI Agent
        state['agent_type'] = "Pydantic AI Agent"  # Default
        print(f"\n====================================================")
        print(f"[AGENT SELECTION] Using default Pydantic AI Agent (no Supabase keywords found)")
        print(f"====================================================\n")
    
    # Get the agent type from the state
    agent_type = state.get('agent_type', 'Pydantic AI Agent')
    
    # Enhanced logging
    print(f"\n====================================================")
    print(f"[AGENT VERIFICATION] Agent type is set to: {agent_type}")
    print(f"====================================================\n")
    
    # First, get the documentation pages so the reasoner can decide which ones are necessary
    documentation_pages = []
    
    if agent_type == "Pydantic AI Agent":
        # Get Pydantic AI documentation pages
        print(f"[DOCUMENTATION] Retrieving Pydantic AI documentation pages")
        documentation_pages = await pydantic_docs_helper(supabase)
        source_filter = "pydantic_ai_docs"
        print(f"[DOCUMENTATION] Using source filter: {source_filter}")
    else:  # Supabase Agent
        # Get Supabase documentation pages
        print(f"[DOCUMENTATION] Retrieving Supabase documentation pages")
        documentation_pages = await supabase_docs_helper(supabase)
        source_filter = "supabase_docs"
        print(f"[DOCUMENTATION] Using source filter: {source_filter}")
        
    documentation_pages_str = "\n".join(documentation_pages)
    print(f"[DOCUMENTATION] Retrieved {len(documentation_pages)} documentation pages")

    # Select the appropriate reasoner based on agent type
    reasoner = pydantic_reasoner if agent_type == "Pydantic AI Agent" else supabase_reasoner
    print(f"[REASONER] Using {'Pydantic' if agent_type == 'Pydantic AI Agent' else 'Supabase'} reasoner")

    # Customize prompt based on agent type
    if agent_type == "Pydantic AI Agent":
        prompt = f"""
        User AI Agent Request: {state['latest_user_message']}
        
        Create detailed scope document for the AI agent including:
        - Architecture diagram
        - Core components
        - External dependencies
        - Testing strategy

        Also based on these Pydantic AI documentation pages available:

        {documentation_pages_str}

        Include a list of documentation pages that are relevant to creating this agent for the user in the scope document.
        """
    else:  # Supabase Agent
        prompt = f"""
        User Supabase Application Request: {state['latest_user_message']}
        
        Create detailed scope document for the Supabase application including:
        - Architecture diagram
        - Database schema design
        - API endpoints
        - Authentication flow
        - Frontend components (if applicable)
        - External dependencies
        - Testing strategy

        Also based on these Supabase documentation pages available:

        {documentation_pages_str}

        Include a list of documentation pages that are relevant to creating this application for the user in the scope document.
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
    # Get the agent type from the state
    agent_type = state.get('agent_type', 'Pydantic AI Agent')
    
    # Enhanced logging for debugging
    print(f"\n====================================================")
    print(f"[CODER SELECTION] Using coder for agent type: {agent_type}")
    print(f"====================================================\n")
    
    # Get the message history into the format for Pydantic AI
    message_history: list[ModelMessage] = []
    for message_row in state['messages']:
        message_history.extend(ModelMessagesTypeAdapter.validate_json(message_row))

    # Explicitly check agent type to ensure correct coder is used
    is_supabase_agent = agent_type == "Supabase Agent"
    
    if not is_supabase_agent:  # Pydantic AI Agent
        # Prepare dependencies for Pydantic AI coder
        deps = PydanticAIDeps(
            supabase=supabase,
            openai_client=openai_client,
            reasoner_output=state['scope']
        )
        
        print(f"[CODER EXECUTION] Running Pydantic AI coder with message: {state['latest_user_message'][:50]}...")
        
        # Run the Pydantic AI coder agent
        if not is_openai:
            writer = get_stream_writer()
            result = await pydantic_ai_coder.run(state['latest_user_message'], deps=deps, message_history=message_history)
            writer(result.data)
        else:
            async with pydantic_ai_coder.run_stream(
                state['latest_user_message'],
                deps=deps,
                message_history=message_history
            ) as result:
                # Stream partial text as it arrives
                async for chunk in result.stream_text(delta=True):
                    writer(chunk)
    else:  # Supabase Agent
        # Prepare dependencies for Supabase coder
        deps = SupabaseDeps(
            supabase=supabase,
            openai_client=openai_client,
            reasoner_output=state['scope']
        )
        
        print(f"[CODER EXECUTION] Running Supabase coder with message: {state['latest_user_message'][:50]}...")
        
        # Run the Supabase coder agent
        if not is_openai:
            writer = get_stream_writer()
            result = await supabase_coder.run(state['latest_user_message'], deps=deps, message_history=message_history)
            writer(result.data)
        else:
            async with supabase_coder.run_stream(
                state['latest_user_message'],
                deps=deps,
                message_history=message_history
            ) as result:
                # Stream partial text as it arrives
                async for chunk in result.stream_text(delta=True):
                    writer(chunk)

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
    # Get the latest user message
    user_message = state['latest_user_message'].lower()
    
    # Check if the message is related to Supabase or vector search
    supabase_keywords = [
        'supabase', 'vector search', 'vector database', 'pgvector', 
        'similarity search', 'embedding', 'websocket', 'realtime', 
        'postgres', 'postgresql', 'sql', 'database', 'auth', 'storage'
    ]
    
    # Check if any of the keywords are in the user message
    is_supabase_related = any(keyword in user_message for keyword in supabase_keywords)
    
    # Set the agent type based on the message content
    if is_supabase_related:
        # Force the agent type to be Supabase Agent
        state['agent_type'] = "Supabase Agent"
        print(f"\n====================================================")
        print(f"[AGENT SELECTION] Switching to Supabase Agent based on query content")
        print(f"[AGENT SELECTION] Keywords found: {[k for k in supabase_keywords if k in user_message]}")
        print(f"====================================================\n")
    else:
        # Force the agent type to be Pydantic AI Agent
        state['agent_type'] = "Pydantic AI Agent"
        print(f"\n====================================================")
        print(f"[AGENT SELECTION] Using Pydantic AI Agent (no Supabase keywords found)")
        print(f"====================================================\n")
    
    # Get the agent type from the state
    agent_type = state.get('agent_type', 'Pydantic AI Agent')
    
    # Verify the agent type is set correctly
    print(f"[AGENT VERIFICATION] Agent type is set to: {agent_type}")
    
    # Customize prompt based on agent type
    if agent_type == "Pydantic AI Agent":
        prompt = f"""
        The user has sent a message: 
        
        {state['latest_user_message']}

        If the user wants to end the conversation about creating a Pydantic AI agent, respond with just the text "finish_conversation".
        If the user wants to continue coding the Pydantic AI agent, respond with just the text "coder_agent".
        """
    else:  # Supabase Agent
        prompt = f"""
        The user has sent a message: 
        
        {state['latest_user_message']}

        If the user wants to end the conversation about creating a Supabase application, respond with just the text "finish_conversation".
        If the user wants to continue coding the Supabase application, respond with just the text "coder_agent".
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
        result = await end_conversation_agent.run(state['latest_user_message'], message_history=message_history)
        writer(result.data)   
    else: 
        async with end_conversation_agent.run_stream(
            state['latest_user_message'],
            message_history=message_history
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