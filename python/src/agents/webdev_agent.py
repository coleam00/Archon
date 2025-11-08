"""
WebDeveloperAgent - AI Software Developer for Web Applications

This agent acts as a software developer assistant for web applications, providing:
- Code review and analysis
- Code generation for frontend and backend
- Debugging assistance
- Architecture planning
- Best practices guidance
- Refactoring suggestions

It specializes in:
- Frontend: React, TypeScript, TailwindCSS
- Backend: Python, FastAPI
- Database: PostgreSQL, Supabase
- Testing: Pytest, Vitest
"""

import logging
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field
from pydantic_ai import Agent, RunContext

from .base_agent import ArchonDependencies, BaseAgent

logger = logging.getLogger(__name__)


@dataclass
class WebDevDependencies(ArchonDependencies):
    """Dependencies for web development operations."""

    project_id: str | None = None
    file_path: str | None = None
    language: str | None = None  # "python", "typescript", "react", etc.
    framework: str | None = None  # "fastapi", "react", etc.
    progress_callback: Any | None = None


class WebDevResult(BaseModel):
    """Structured output for web development tasks."""

    task_type: str = Field(
        description="Type of task: code_review, code_generation, debugging, architecture, refactoring"
    )
    language: str | None = Field(description="Programming language involved")
    analysis: str = Field(description="Analysis or explanation of the task")
    code_snippet: str | None = Field(description="Generated or modified code snippet")
    suggestions: list[str] = Field(description="List of suggestions or improvements")
    issues_found: list[str] = Field(description="List of issues or problems identified")
    best_practices: list[str] = Field(description="Best practices recommendations")
    next_steps: list[str] = Field(description="Recommended next steps")
    success: bool = Field(description="Whether the task was successful")
    message: str = Field(description="Summary message")


class WebDeveloperAgent(BaseAgent[WebDevDependencies, str]):
    """
    AI Software Developer agent for web applications.

    Capabilities:
    - Review code for quality, security, and performance
    - Generate React components, API endpoints, database schemas
    - Debug errors and suggest fixes
    - Plan features and architecture
    - Provide refactoring suggestions
    - Answer web development questions
    """

    def __init__(self, model: str | None = None, **kwargs):
        if model is None:
            model = os.getenv("WEBDEV_AGENT_MODEL", "openai:gpt-4o")

        super().__init__(
            model=model, name="WebDeveloperAgent", retries=3, enable_rate_limiting=True, **kwargs
        )

    def _create_agent(self, **kwargs) -> Agent:
        """Create the PydanticAI agent with tools and prompts."""

        agent = Agent(
            model=self.model,
            deps_type=WebDevDependencies,
            system_prompt="""You are an expert Software Developer specializing in web applications. You have deep knowledge of:

**Frontend Development:**
- React 18+ with TypeScript
- Modern React patterns (hooks, context, custom hooks)
- TailwindCSS for styling
- Vite for build tooling
- Vitest for testing
- State management (Context API, Zustand, etc.)
- Performance optimization
- Accessibility (WCAG guidelines)

**Backend Development:**
- Python 3.12+
- FastAPI framework
- RESTful API design
- WebSocket/Socket.IO for real-time features
- Async/await patterns
- Pydantic for data validation
- SQLAlchemy and raw SQL
- Authentication and authorization

**Database & Data:**
- PostgreSQL
- Supabase (PostgreSQL + Auth + Storage)
- Database design and normalization
- Query optimization
- Vector databases (pgvector)

**Development Practices:**
- Clean code principles
- SOLID principles
- Design patterns
- Testing strategies (unit, integration, e2e)
- Error handling
- Security best practices (OWASP Top 10)
- Performance optimization
- Code review

**Your Approach:**
1. **Understand the context** - Ask clarifying questions if needed
2. **Analyze thoroughly** - Consider edge cases, security, performance
3. **Provide clear solutions** - Write clean, well-documented code
4. **Explain your reasoning** - Help the user learn, not just fix
5. **Suggest improvements** - Go beyond the immediate problem
6. **Follow best practices** - Always recommend industry standards

**Response Style:**
- Be concise but comprehensive
- Use code examples to illustrate points
- Cite specific line numbers when reviewing code
- Prioritize security and performance
- Suggest incremental improvements
- Consider maintainability and scalability

**Common Tasks:**
- "Review this code" → Analyze for issues, suggest improvements
- "Generate a component for X" → Create React component with TypeScript
- "Create an API endpoint for Y" → Generate FastAPI route with validation
- "Debug this error: ..." → Analyze error and suggest fixes
- "Plan feature Z" → Provide architecture and implementation steps
- "How do I implement X?" → Provide guidance and code examples""",
            **kwargs,
        )

        # Register dynamic system prompt for context
        @agent.system_prompt
        async def add_dev_context(ctx: RunContext[WebDevDependencies]) -> str:
            context_parts = [
                "**Current Development Context:**",
                f"- Timestamp: {datetime.now().isoformat()}",
            ]

            if ctx.deps.project_id:
                context_parts.append(f"- Project ID: {ctx.deps.project_id}")
            if ctx.deps.file_path:
                context_parts.append(f"- File: {ctx.deps.file_path}")
            if ctx.deps.language:
                context_parts.append(f"- Language: {ctx.deps.language}")
            if ctx.deps.framework:
                context_parts.append(f"- Framework: {ctx.deps.framework}")

            context_parts.append("\n**Tech Stack:**")
            context_parts.append("- Frontend: React 18 + TypeScript + TailwindCSS + Vite")
            context_parts.append("- Backend: Python 3.12 + FastAPI")
            context_parts.append("- Database: Supabase (PostgreSQL + pgvector)")
            context_parts.append("- Real-time: Socket.IO")
            context_parts.append("- Testing: Pytest (backend), Vitest (frontend)")

            return "\n".join(context_parts)

        # Register tools for web development
        @agent.tool
        async def analyze_code(ctx: RunContext[WebDevDependencies], code: str, focus: str = "general") -> str:
            """
            Analyze code for issues, patterns, and improvements.

            Args:
                code: The code to analyze
                focus: What to focus on - "security", "performance", "style", "general"
            """
            analysis = ["### Code Analysis"]

            # Detect language from code
            language = ctx.deps.language or self._detect_language(code)
            analysis.append(f"\n**Language:** {language}")
            analysis.append(f"**Focus:** {focus.title()}\n")

            # Security analysis
            if focus in ["security", "general"]:
                analysis.append("**Security Considerations:**")
                security_issues = []

                if language == "python":
                    if "eval(" in code or "exec(" in code:
                        security_issues.append("⚠️ Avoid eval()/exec() - code injection risk")
                    if "pickle.loads" in code:
                        security_issues.append("⚠️ Avoid pickle.loads() - arbitrary code execution risk")
                    if ".format(" in code and "{" in code:
                        security_issues.append("🔍 Check format strings for injection vulnerabilities")
                    if "password" in code.lower() and "=" in code:
                        security_issues.append("⚠️ Ensure passwords are hashed, never stored plain")

                if language in ["typescript", "javascript", "react"]:
                    if "dangerouslySetInnerHTML" in code:
                        security_issues.append("⚠️ XSS risk with dangerouslySetInnerHTML - sanitize input")
                    if "localStorage" in code or "sessionStorage" in code:
                        security_issues.append("🔍 Don't store sensitive data in localStorage")
                    if "eval(" in code:
                        security_issues.append("⚠️ Avoid eval() - code injection risk")

                if security_issues:
                    analysis.extend([f"  - {issue}" for issue in security_issues])
                else:
                    analysis.append("  ✅ No obvious security issues detected")

            # Performance analysis
            if focus in ["performance", "general"]:
                analysis.append("\n**Performance Considerations:**")
                perf_notes = []

                if language in ["typescript", "javascript", "react"]:
                    if "useState" in code and "useEffect" in code:
                        perf_notes.append("🔍 Consider useMemo/useCallback for expensive computations")
                    if "map(" in code and "filter(" in code and "map(" in code[code.index("filter("):]:
                        perf_notes.append("💡 Consider combining map/filter operations for better performance")
                    if code.count(".map(") > 2:
                        perf_notes.append("🔍 Multiple map() calls - consider data transformation optimization")

                if language == "python":
                    if "for " in code and "append(" in code:
                        perf_notes.append("💡 Consider list comprehension instead of for+append")
                    if "+ str(" in code or '+ "' in code:
                        perf_notes.append("💡 Use f-strings for better performance and readability")

                if perf_notes:
                    analysis.extend([f"  - {note}" for note in perf_notes])
                else:
                    analysis.append("  ✅ No obvious performance issues detected")

            # Style and best practices
            if focus in ["style", "general"]:
                analysis.append("\n**Code Style & Best Practices:**")
                style_notes = []

                if language == "python":
                    if "except:" in code or "except Exception:" in code:
                        style_notes.append("💡 Use specific exception types instead of bare except")
                    if code.count("\n") > 50:
                        style_notes.append("🔍 Consider breaking this into smaller functions")
                    if "# TODO" in code or "# FIXME" in code:
                        style_notes.append("📝 Address TODO/FIXME comments")

                if language in ["typescript", "react"]:
                    if "any" in code:
                        style_notes.append("💡 Avoid 'any' type - use proper TypeScript types")
                    if "console.log" in code:
                        style_notes.append("🔍 Remove console.log statements before production")

                if style_notes:
                    analysis.extend([f"  - {note}" for note in style_notes])
                else:
                    analysis.append("  ✅ Code follows good practices")

            analysis.append("\n**Overall:** Code analysis complete. Review suggestions above.")
            return "\n".join(analysis)

        @agent.tool
        async def generate_react_component(
            ctx: RunContext[WebDevDependencies],
            component_name: str,
            description: str,
            props: str = "",
        ) -> str:
            """
            Generate a React component with TypeScript.

            Args:
                component_name: Name of the component (PascalCase)
                description: What the component should do
                props: Optional props description
            """
            # Ensure PascalCase
            component_name = component_name.replace(" ", "").replace("-", "").replace("_", "")
            component_name = component_name[0].upper() + component_name[1:]

            # Generate props interface
            props_interface = ""
            if props:
                props_interface = f"""interface {component_name}Props {{
  // {props}
}}

"""

            # Generate component
            component_code = f'''import React from 'react';

{props_interface}export const {component_name}: React.FC{f"<{component_name}Props>" if props else ""} = ({"{ /* props */ }" if props else ""}) => {{
  // {description}

  return (
    <div className="p-4">
      <h2 className="text-xl font-semibold">{component_name}</h2>
      <p className="text-gray-600">Component implementation goes here</p>
    </div>
  );
}};

export default {component_name};
'''

            return f"```typescript\n{component_code}\n```"

        @agent.tool
        async def generate_fastapi_endpoint(
            ctx: RunContext[WebDevDependencies],
            endpoint_path: str,
            method: str,
            description: str,
            request_model: str = "",
            response_model: str = "",
        ) -> str:
            """
            Generate a FastAPI endpoint.

            Args:
                endpoint_path: API path like "/api/users"
                method: HTTP method - GET, POST, PUT, DELETE
                description: What the endpoint does
                request_model: Optional request body description
                response_model: Optional response description
            """
            method = method.upper()

            # Generate models if needed
            models = ""
            if request_model:
                models += f'''
class {self._to_pascal_case(endpoint_path.split("/")[-1])}Request(BaseModel):
    """Request model for {description}"""
    # {request_model}
    pass

'''

            if response_model:
                models += f'''
class {self._to_pascal_case(endpoint_path.split("/")[-1])}Response(BaseModel):
    """Response model for {description}"""
    # {response_model}
    success: bool
    data: dict | None = None

'''

            # Generate route
            params = ""
            if method == "POST" and request_model:
                params = f"request: {self._to_pascal_case(endpoint_path.split('/')[-1])}Request"
            elif method in ["PUT", "PATCH"] and request_model:
                params = f"id: str, request: {self._to_pascal_case(endpoint_path.split('/')[-1])}Request"
            elif method in ["GET", "DELETE"] and "{" in endpoint_path:
                params = "id: str"

            response_type = ""
            if response_model:
                response_type = f", response_model={self._to_pascal_case(endpoint_path.split('/')[-1])}Response"

            route_code = f'''from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api", tags=["{endpoint_path.split("/")[2] if len(endpoint_path.split("/")) > 2 else "api"}"])
{models}
@router.{method.lower()}("{endpoint_path}"{response_type})
async def {self._to_snake_case(endpoint_path.split("/")[-1])}({params}):
    """
    {description}
    """
    try:
        # TODO: Implement endpoint logic

        return {{"success": True, "message": "Operation completed successfully"}}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
'''

            return f"```python\n{route_code}\n```"

        @agent.tool
        async def debug_error(
            ctx: RunContext[WebDevDependencies],
            error_message: str,
            stack_trace: str = "",
            context: str = "",
        ) -> str:
            """
            Analyze an error and provide debugging guidance.

            Args:
                error_message: The error message
                stack_trace: Optional stack trace
                context: Optional context about what was happening
            """
            debug_report = ["### Error Analysis\n"]

            # Analyze error type
            error_type = "Unknown Error"
            if "TypeError" in error_message:
                error_type = "Type Error"
            elif "ValueError" in error_message:
                error_type = "Value Error"
            elif "KeyError" in error_message:
                error_type = "Key Error"
            elif "AttributeError" in error_message:
                error_type = "Attribute Error"
            elif "ImportError" in error_message or "ModuleNotFoundError" in error_message:
                error_type = "Import Error"
            elif "SyntaxError" in error_message:
                error_type = "Syntax Error"
            elif "ReferenceError" in error_message:
                error_type = "Reference Error (JavaScript)"
            elif "undefined is not" in error_message:
                error_type = "Undefined Error (JavaScript)"
            elif "Cannot read property" in error_message:
                error_type = "Null/Undefined Access Error"

            debug_report.append(f"**Error Type:** {error_type}")
            debug_report.append(f"**Error Message:** {error_message}\n")

            if context:
                debug_report.append(f"**Context:** {context}\n")

            # Provide specific guidance based on error type
            debug_report.append("**Likely Causes:**")

            if "TypeError" in error_message:
                debug_report.append("- Incorrect data type passed to a function")
                debug_report.append("- Attempting to call undefined/null as a function")
                debug_report.append("- Missing required arguments")

            elif "KeyError" in error_message:
                debug_report.append("- Accessing a dictionary key that doesn't exist")
                debug_report.append("- Missing data in API response")
                debug_report.append("- Configuration key not found")

            elif "AttributeError" in error_message:
                debug_report.append("- Object doesn't have the attribute you're accessing")
                debug_report.append("- Variable is None when you expected an object")
                debug_report.append("- Import issue or circular dependency")

            elif "Cannot read property" in error_message or "undefined is not" in error_message:
                debug_report.append("- Variable is undefined or null")
                debug_report.append("- Async data not loaded yet")
                debug_report.append("- Missing optional chaining (?.) operator")

            # Provide solutions
            debug_report.append("\n**Suggested Fixes:**")

            if "undefined" in error_message.lower() or "null" in error_message.lower():
                debug_report.append("1. Add null/undefined checks before accessing properties")
                debug_report.append("2. Use optional chaining: `object?.property`")
                debug_report.append("3. Provide default values: `const value = data ?? defaultValue`")

            elif "KeyError" in error_message:
                debug_report.append("1. Use `.get()` with default: `dict.get('key', default_value)`")
                debug_report.append("2. Check key existence: `if 'key' in dict:`")
                debug_report.append("3. Validate API responses before accessing")

            elif "Import" in error_message:
                debug_report.append("1. Check if package is installed: `pip list` or `npm list`")
                debug_report.append("2. Verify import path is correct")
                debug_report.append("3. Check for circular imports")
                debug_report.append("4. Ensure virtual environment is activated (Python)")

            # Stack trace analysis
            if stack_trace:
                debug_report.append("\n**Stack Trace Analysis:**")
                debug_report.append("The error occurred in the following call stack:")
                debug_report.append(f"```\n{stack_trace[:500]}\n```")

            debug_report.append("\n**Next Steps:**")
            debug_report.append("1. Add logging/console statements to track data flow")
            debug_report.append("2. Check variable types and values at error point")
            debug_report.append("3. Review recent code changes that might have caused this")
            debug_report.append("4. Add error handling to gracefully handle this case")

            return "\n".join(debug_report)

        @agent.tool
        async def plan_feature(
            ctx: RunContext[WebDevDependencies],
            feature_name: str,
            requirements: str,
        ) -> str:
            """
            Plan the implementation of a feature.

            Args:
                feature_name: Name of the feature
                requirements: What the feature should do
            """
            plan = [f"# Implementation Plan: {feature_name}\n"]

            plan.append("## Overview")
            plan.append(f"{requirements}\n")

            plan.append("## Architecture")
            plan.append("### Frontend Components")
            plan.append(f"- `{feature_name}Page.tsx` - Main page component")
            plan.append(f"- `{feature_name}Form.tsx` - Form component for user input")
            plan.append(f"- `{feature_name}List.tsx` - Display list of items")
            plan.append(f"- `{feature_name}Card.tsx` - Individual item display")
            plan.append("")

            plan.append("### Backend API")
            plan.append(f"- `GET /api/{feature_name.lower()}` - List items")
            plan.append(f"- `POST /api/{feature_name.lower()}` - Create new item")
            plan.append(f"- `GET /api/{feature_name.lower()}/{{id}}` - Get single item")
            plan.append(f"- `PUT /api/{feature_name.lower()}/{{id}}` - Update item")
            plan.append(f"- `DELETE /api/{feature_name.lower()}/{{id}}` - Delete item")
            plan.append("")

            plan.append("### Database")
            plan.append(f"- Table: `{feature_name.lower()}`")
            plan.append("  - id (UUID, primary key)")
            plan.append("  - created_at (timestamp)")
            plan.append("  - updated_at (timestamp)")
            plan.append("  - Additional fields based on requirements")
            plan.append("")

            plan.append("## Implementation Steps")
            plan.append("1. **Database Schema** - Create migration for new table")
            plan.append("2. **Backend Models** - Define Pydantic models for request/response")
            plan.append("3. **API Endpoints** - Implement CRUD operations")
            plan.append("4. **API Tests** - Write unit tests for endpoints")
            plan.append("5. **Frontend Types** - Define TypeScript interfaces")
            plan.append("6. **API Client** - Create service layer for API calls")
            plan.append("7. **Components** - Build React components")
            plan.append("8. **Routing** - Add routes to router")
            plan.append("9. **Integration Testing** - Test end-to-end flow")
            plan.append("10. **Documentation** - Update API docs and README")
            plan.append("")

            plan.append("## Testing Strategy")
            plan.append("- **Unit Tests:** Test individual functions and components")
            plan.append("- **Integration Tests:** Test API endpoints with database")
            plan.append("- **E2E Tests:** Test complete user workflows")
            plan.append("- **Manual Testing:** Verify UI/UX and edge cases")
            plan.append("")

            plan.append("## Considerations")
            plan.append("- **Security:** Input validation, authentication, authorization")
            plan.append("- **Performance:** Pagination, caching, query optimization")
            plan.append("- **Error Handling:** User-friendly error messages")
            plan.append("- **Accessibility:** WCAG compliance, keyboard navigation")
            plan.append("- **Mobile:** Responsive design")

            return "\n".join(plan)

        @agent.tool
        async def suggest_refactoring(
            ctx: RunContext[WebDevDependencies],
            code: str,
            goal: str = "improve maintainability",
        ) -> str:
            """
            Suggest refactoring improvements.

            Args:
                code: Code to refactor
                goal: What to optimize for - "maintainability", "performance", "testability"
            """
            suggestions = [f"### Refactoring Suggestions ({goal})\n"]

            language = ctx.deps.language or self._detect_language(code)

            if "maintainability" in goal.lower():
                suggestions.append("**Maintainability Improvements:**")
                suggestions.append("- Extract magic numbers into named constants")
                suggestions.append("- Split large functions into smaller, focused functions")
                suggestions.append("- Add descriptive variable names")
                suggestions.append("- Add comments for complex logic")
                suggestions.append("- Use early returns to reduce nesting")

            if "performance" in goal.lower():
                suggestions.append("\n**Performance Improvements:**")
                if language == "python":
                    suggestions.append("- Use generators for large datasets")
                    suggestions.append("- Cache expensive computations")
                    suggestions.append("- Use set operations instead of list iterations")
                    suggestions.append("- Consider async/await for I/O operations")
                elif language in ["typescript", "javascript", "react"]:
                    suggestions.append("- Use React.memo for expensive components")
                    suggestions.append("- Implement useMemo/useCallback for expensive calculations")
                    suggestions.append("- Lazy load components with React.lazy")
                    suggestions.append("- Debounce/throttle frequent operations")

            if "testability" in goal.lower():
                suggestions.append("\n**Testability Improvements:**")
                suggestions.append("- Inject dependencies instead of hard-coding")
                suggestions.append("- Separate business logic from UI/framework code")
                suggestions.append("- Make functions pure when possible")
                suggestions.append("- Add clear input/output contracts")
                suggestions.append("- Reduce global state dependencies")

            suggestions.append("\n**General Refactoring Principles:**")
            suggestions.append("- Single Responsibility Principle - each function does one thing")
            suggestions.append("- DRY (Don't Repeat Yourself) - extract common patterns")
            suggestions.append("- KISS (Keep It Simple, Stupid) - simplest solution that works")
            suggestions.append("- YAGNI (You Aren't Gonna Need It) - don't over-engineer")

            return "\n".join(suggestions)

        @agent.tool
        async def generate_database_schema(
            ctx: RunContext[WebDevDependencies],
            table_name: str,
            description: str,
            fields: str,
        ) -> str:
            """
            Generate a database schema/migration.

            Args:
                table_name: Name of the table
                description: What the table stores
                fields: Description of fields needed
            """
            # Convert to snake_case
            table_name = self._to_snake_case(table_name)

            sql = [f"-- {description}"]
            sql.append(f"CREATE TABLE IF NOT EXISTS {table_name} (")
            sql.append("    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),")
            sql.append("")
            sql.append(f"    -- {fields}")
            sql.append("    -- Add your fields here based on requirements")
            sql.append("")
            sql.append("    -- Metadata")
            sql.append("    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,")
            sql.append("    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,")
            sql.append("    created_by UUID REFERENCES auth.users(id),")
            sql.append("    updated_by UUID REFERENCES auth.users(id)")
            sql.append(");")
            sql.append("")
            sql.append(f"-- Indexes for {table_name}")
            sql.append(f"CREATE INDEX IF NOT EXISTS idx_{table_name}_created_at ON {table_name}(created_at);")
            sql.append(f"CREATE INDEX IF NOT EXISTS idx_{table_name}_updated_at ON {table_name}(updated_at);")
            sql.append("")
            sql.append(f"-- Enable Row Level Security for {table_name}")
            sql.append(f"ALTER TABLE {table_name} ENABLE ROW LEVEL SECURITY;")
            sql.append("")
            sql.append("-- RLS Policy: Users can view their own records")
            sql.append(f"CREATE POLICY select_{table_name}_policy ON {table_name}")
            sql.append("    FOR SELECT")
            sql.append("    USING (auth.uid() = created_by);")
            sql.append("")
            sql.append("-- RLS Policy: Users can insert their own records")
            sql.append(f"CREATE POLICY insert_{table_name}_policy ON {table_name}")
            sql.append("    FOR INSERT")
            sql.append("    WITH CHECK (auth.uid() = created_by);")

            return "```sql\n" + "\n".join(sql) + "\n```"

        return agent

    def _detect_language(self, code: str) -> str:
        """Detect programming language from code."""
        if "import React" in code or "const " in code and "=>" in code:
            return "react"
        elif "from fastapi" in code or "async def" in code:
            return "python"
        elif "def " in code or "import " in code:
            return "python"
        elif "interface " in code or "type " in code:
            return "typescript"
        elif "function " in code or "const " in code:
            return "javascript"
        elif "CREATE TABLE" in code or "SELECT " in code:
            return "sql"
        else:
            return "unknown"

    def _to_pascal_case(self, text: str) -> str:
        """Convert text to PascalCase."""
        words = text.replace("_", " ").replace("-", " ").split()
        return "".join(word.capitalize() for word in words)

    def _to_snake_case(self, text: str) -> str:
        """Convert text to snake_case."""
        import re

        # Insert underscore before uppercase letters
        text = re.sub(r"(?<!^)(?=[A-Z])", "_", text)
        return text.replace("-", "_").replace(" ", "_").lower()

    def get_system_prompt(self) -> str:
        """Get the base system prompt for this agent."""
        return "Expert Software Developer for Web Applications - React, TypeScript, Python, FastAPI"

    async def run_conversation(
        self,
        user_message: str,
        project_id: str | None = None,
        file_path: str | None = None,
        language: str | None = None,
        framework: str | None = None,
        user_id: str | None = None,
        progress_callback: Any | None = None,
    ) -> str:
        """
        Run the agent for web development assistance.

        Args:
            user_message: The user's request or question
            project_id: Optional project ID for context
            file_path: Optional file path being worked on
            language: Optional language hint
            framework: Optional framework hint
            user_id: ID of the user making the request
            progress_callback: Optional callback for progress updates

        Returns:
            Agent response as string
        """
        deps = WebDevDependencies(
            project_id=project_id,
            file_path=file_path,
            language=language,
            framework=framework,
            user_id=user_id,
            progress_callback=progress_callback,
        )

        try:
            result = await self.run(user_message, deps)
            self.logger.info("Web development task completed successfully")
            return result
        except Exception as e:
            self.logger.error(f"Web development task failed: {str(e)}")
            return f"I encountered an error while processing your request: {str(e)}"
