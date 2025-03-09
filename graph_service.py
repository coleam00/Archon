from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any
from archon.archon_graph import agentic_flow
from langgraph.types import Command
from utils.utils import write_to_log
    
app = FastAPI()

class InvokeRequest(BaseModel):
    message: str
    thread_id: str
    is_first_message: bool = False
    config: Optional[Dict[str, Any]] = None

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok"}    

@app.post("/invoke")
async def invoke_agent(request: InvokeRequest):
    """Process a message through the agentic flow and return the complete response.

    The agent streams the response but this API endpoint waits for the full output
    before returning so it's a synchronous operation for MCP.
    Another endpoint will be made later to fully stream the response from the API.
    
    Args:
        request: The InvokeRequest containing message and thread info
        
    Returns:
        dict: Contains the complete response from the agent
    """
    try:
        config = request.config or {
            "configurable": {
                "thread_id": request.thread_id
            }
        }

        # Maximum response size to prevent cut-offs in MCP
        MAX_RESPONSE_SIZE = 15000  # Characters

        # Simple string concatenation like in the original
        response = ""
        if request.is_first_message:
            write_to_log(f"Processing first message for thread {request.thread_id}")
            async for msg in agentic_flow.astream(
                {"latest_user_message": request.message}, 
                config,
                stream_mode="custom"
            ):
                response += str(msg)
        else:
            write_to_log(f"Processing continuation for thread {request.thread_id}")
            async for msg in agentic_flow.astream(
                Command(resume=request.message),
                config,
                stream_mode="custom"
            ):
                response += str(msg)

        # Log only a preview of the response to avoid huge logs
        response_length = len(response)
        preview = response[:100] + "..." if response_length > 100 else response
        write_to_log(f"Response size: {response_length} chars. Preview: {preview}")
        
        # Check if response is too large and truncate if necessary
        if response_length > MAX_RESPONSE_SIZE:
            truncated_response = response[:MAX_RESPONSE_SIZE]
            truncated_response += "\n\n[Response truncated due to size limitations. Please ask for continuation.]"
            write_to_log(f"Response truncated (original size: {response_length})")
            return {"response": truncated_response}
        
        return {"response": response}
        
    except Exception as e:
        write_to_log(f"Error processing message for thread {request.thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8100)
