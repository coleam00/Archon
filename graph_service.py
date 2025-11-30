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

        write_to_log(f"Final response for thread {request.thread_id}: {response}")
        return {"response": response}
        
    except Exception as e:
        print(f"Exception invoking Archon for thread {request.thread_id}: {str(e)}")
        write_to_log(f"Error processing message for thread {request.thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    import os
    port = int(os.environ.get("GRAPH_SERVICE_PORT", "8100"))
    host = os.environ.get("GRAPH_SERVICE_HOST", "0.0.0.0")
    uvicorn.run(app, host=host, port=port)
