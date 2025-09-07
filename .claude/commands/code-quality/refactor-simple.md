Quick refactoring check for Python code focusing on:
- Vertical slice boundaries
- Function complexity
- Type safety with Pydantic v2
- Single responsibility

Scan for:
1. Functions >20 lines that need decomposition
2. long files that need decomposition
3. Missing Pydantic models for I/O
4. Cross-feature imports violating vertical slices
5. Classes with multiple responsibilities
6. Missing type hints

Desired architecture:
- Vertical slice boundaries
- Single responsibility
- Type safety with Pydantic v2 

For each issue found, provide:
- Location
- Why it's a problem
- Specific fix with code example
- Specific place where the fix should be implemented
- Priority (high/medium/low)

Focus on actionable items that can be fixed in <1 hour each.

save a refactor_plan.md in the PRPs/ai_docs folder, ensure you dont overwrite any existing files