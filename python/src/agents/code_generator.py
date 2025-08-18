
from pydantic_ai import Agent
from typing import Dict, List

class CodeGenerationAgent:
    def __init__(self):
        self.planner = Agent('openai:gpt-4')
        self.coder = Agent('openai:gpt-4')
        self.reviewer = Agent('openai:gpt-4')
    
    async def generate_application(self, description: str, tech_stack: List[str]) -> Dict:
        # 1. Planning phase
        plan = await self.planner.run(
            f"Create detailed development plan for: {description}",
            context={"tech_stack": tech_stack}
        )
        
        # 2. Code generation phase
        code_files = {}
        for component in plan['components']:
            code_files[component['file']] = await self.coder.run(
                f"Generate {component['type']} code",
                context={"plan": plan, "component": component}
            )
        
        # 3. Review phase
        review = await self.reviewer.run(
            "Review generated code for best practices",
            context={"code_files": code_files}
        )
        
        return {"files": code_files, "review": review, "plan": plan}

# Integration endpoint in server.py
@app.post("/api/generate-app")
async def generate_application(request: GenerateAppRequest):
    agent = CodeGenerationAgent()
    result = await agent.generate_application(
        request.description, 
        request.tech_stack
    )
    return result
