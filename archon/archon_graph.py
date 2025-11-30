from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai import Agent, RunContext
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver
from typing import TypedDict, Annotated, List, Any
from langgraph.config import get_stream_writer
from langgraph.types import interrupt
from dotenv import load_dotenv
from openai import AsyncOpenAI
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
from archon.pydantic_ai_coder import pydantic_ai_coder, PydanticAIDeps
from archon.advisor_agent import advisor_agent, AdvisorDeps
from archon.refiner_agents.prompt_refiner_agent import prompt_refiner_agent
from archon.refiner_agents.tools_refiner_agent import tools_refiner_agent, ToolsRefinerDeps
from archon.refiner_agents.agent_refiner_agent import agent_refiner_agent, AgentRefinerDeps
from archon.agent_tools import list_documentation_pages_tool
from utils.utils import get_env_var
from archon.container import get_repository, get_embedding_service

# Load environment variables
load_dotenv()

# Configure logfire to suppress warnings (optional)
logfire.configure(send_to_logfire='never')

provider = get_env_var('LLM_PROVIDER') or 'OpenAI'
base_url = get_env_var('BASE_URL') or 'https://api.openai.com/v1'
api_key = get_env_var('LLM_API_KEY') or 'no-llm-api-key-provided'

is_anthropic = provider == "Anthropic"
is_openai = provider == "OpenAI"

reasoner_llm_model_name = get_env_var('REASONER_MODEL') or 'o3-mini'
reasoner_llm_model = AnthropicModel(reasoner_llm_model_name, api_key=api_key) if is_anthropic else OpenAIModel(reasoner_llm_model_name, provider=OpenAIProvider(base_url=base_url, api_key=api_key))

reasoner = Agent(  
    reasoner_llm_model,
    system_prompt='You are an expert at coding AI agents with Pydantic AI and defining the scope for doing so.',  
)

primary_llm_model_name = get_env_var('PRIMARY_MODEL') or 'gpt-4o-mini'
primary_llm_model = AnthropicModel(primary_llm_model_name, api_key=api_key) if is_anthropic else OpenAIModel(primary_llm_model_name, provider=OpenAIProvider(base_url=base_url, api_key=api_key))

router_agent = Agent(  
    primary_llm_model,
    system_prompt='Your job is to route the user message either to the end of the conversation or to continue coding the AI agent.',  
)

end_conversation_agent = Agent(  
    primary_llm_model,
    system_prompt='Your job is to end a conversation for creating an AI agent by giving instructions for how to execute the agent and they saying a nice goodbye to the user.',  
)

# Initialize repository and embedding service via container
repository = get_repository()
embedding_service = get_embedding_service()

# Define state schema
class AgentState(TypedDict):
    latest_user_message: str
    messages: Annotated[List[bytes], lambda x, y: x + y]

    scope: str
    advisor_output: str
    file_list: List[str]

    refined_prompt: str
    refined_tools: str
    refined_agent: str

# Scope Definition Node with Reasoner LLM
async def define_scope_with_reasoner(state: AgentState):
    # First, get the documentation pages so the reasoner can decide which ones are necessary
    documentation_pages = await list_documentation_pages_tool(repository=repository)
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

# Advisor agent - create a starting point based on examples and prebuilt tools/MCP servers
async def advisor_with_examples(state: AgentState):
    # Get the directory one level up from the current file (archon_graph.py)
    current_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(current_dir)
    
    # The agent-resources folder is adjacent to the parent folder of archon_graph.py
    agent_resources_dir = os.path.join(parent_dir, "agent-resources")
    
    # Get a list of all files in the agent-resources directory and its subdirectories
    file_list = []
    
    for root, dirs, files in os.walk(agent_resources_dir):
        for file in files:
            # Get the full path to the file
            file_path = os.path.join(root, file)
            # Use the full path instead of relative path
            file_list.append(file_path)
    
    # Then, prompt the advisor with the list of files it can use for examples and tools
    deps = AdvisorDeps(file_list=file_list)
    result = await advisor_agent.run(state['latest_user_message'], deps=deps)
    advisor_output = result.data
    
    return {"file_list": file_list, "advisor_output": advisor_output}

# Coding Node with Feedback Handling
async def coder_agent(state: AgentState, writer):
    # Prepare dependencies
    deps = PydanticAIDeps(
        repository=repository,
        embedding_service=embedding_service,
        reasoner_output=state['scope'],
        advisor_output=state['advisor_output']
    )

    # Get the message history into the format for Pydantic AI
    message_history: list[ModelMessage] = []
    for message_row in state['messages']:
        message_history.extend(ModelMessagesTypeAdapter.validate_json(message_row))

    # The prompt either needs to be the user message (initial agent request or feedback)
    # or the refined prompt/tools/agent if we are in that stage of the agent creation process
    if 'refined_prompt' in state and state['refined_prompt']:
        prompt = f"""
        I need you to refine the agent you created. 
        
        Here is the refined prompt:\n
        {state['refined_prompt']}\n\n

        Here are the refined tools:\n
        {state['refined_tools']}\n

        And finally, here are the changes to the agent definition to make if any:\n
        {state['refined_agent']}\n\n

        Output any changes necessary to the agent code based on these refinements.
        """
    else:
        prompt = state['latest_user_message']

    # Run the agent in a stream
    if not is_openai:
        writer = get_stream_writer()
        result = await pydantic_ai_coder.run(prompt, deps=deps, message_history=message_history)
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

    # print(ModelMessagesTypeAdapter.validate_json(result.new_messages_json()))

    # Add the new conversation history (including tool calls)
    # Reset the refined properties in case they were just used to refine the agent
    return {
        "messages": [result.new_messages_json()],
        "refined_prompt": "",
        "refined_tools": "",
        "refined_agent": ""
    }

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
    If the user wants to continue coding the AI agent and gave feedback, respond with just the text "coder_agent".
    If the user asks specifically to "refine" the agent, respond with just the text "refine".
    """

    result = await router_agent.run(prompt)
    
    if result.data == "finish_conversation": return "finish_conversation"
    if result.data == "refine": return ["refine_prompt", "refine_tools", "refine_agent"]
    return "coder_agent"

# Refines the prompt for the AI agent
async def refine_prompt(state: AgentState):
    # Get the message history into the format for Pydantic AI
    message_history: list[ModelMessage] = []
    for message_row in state['messages']:
        message_history.extend(ModelMessagesTypeAdapter.validate_json(message_row))

    prompt = "Based on the current conversation, refine the prompt for the agent."

    # Run the agent to refine the prompt for the agent being created
    result = await prompt_refiner_agent.run(prompt, message_history=message_history)

    return {"refined_prompt": result.data}

# Refines the tools for the AI agent
async def refine_tools(state: AgentState):
    # Prepare dependencies
    deps = ToolsRefinerDeps(
        repository=repository,
        embedding_service=embedding_service,
        file_list=state['file_list']
    )

    # Get the message history into the format for Pydantic AI
    message_history: list[ModelMessage] = []
    for message_row in state['messages']:
        message_history.extend(ModelMessagesTypeAdapter.validate_json(message_row))

    prompt = "Based on the current conversation, refine the tools for the agent."

    # Run the agent to refine the tools for the agent being created
    result = await tools_refiner_agent.run(prompt, deps=deps, message_history=message_history)

    return {"refined_tools": result.data}

# Refines the defintion for the AI agent
async def refine_agent(state: AgentState):
    # Prepare dependencies
    deps = AgentRefinerDeps(
        repository=repository,
        embedding_service=embedding_service
    )

    # Get the message history into the format for Pydantic AI
    message_history: list[ModelMessage] = []
    for message_row in state['messages']:
        message_history.extend(ModelMessagesTypeAdapter.validate_json(message_row))

    prompt = "Based on the current conversation, refine the agent definition."

    # Run the agent to refine the definition for the agent being created
    result = await agent_refiner_agent.run(prompt, deps=deps, message_history=message_history)

    return {"refined_agent": result.data}

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
builder.add_node("advisor_with_examples", advisor_with_examples)
builder.add_node("coder_agent", coder_agent)
builder.add_node("get_next_user_message", get_next_user_message)
builder.add_node("refine_prompt", refine_prompt)
builder.add_node("refine_tools", refine_tools)
builder.add_node("refine_agent", refine_agent)
builder.add_node("finish_conversation", finish_conversation)

# Set edges
builder.add_edge(START, "define_scope_with_reasoner")
builder.add_edge(START, "advisor_with_examples")
builder.add_edge("define_scope_with_reasoner", "coder_agent")
builder.add_edge("advisor_with_examples", "coder_agent")
builder.add_edge("coder_agent", "get_next_user_message")
builder.add_conditional_edges(
    "get_next_user_message",
    route_user_message,
    ["coder_agent", "finish_conversation", "refine_prompt", "refine_tools", "refine_agent"]
)
builder.add_edge("refine_prompt", "coder_agent")
builder.add_edge("refine_tools", "coder_agent")
builder.add_edge("refine_agent", "coder_agent")
builder.add_edge("finish_conversation", END)

# Configure persistence
memory = MemorySaver()
agentic_flow = builder.compile(checkpointer=memory)