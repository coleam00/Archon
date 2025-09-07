# Create BASE PRP with Parallel Research

## Feature: $ARGUMENTS

Generate a comprehensive PRP using parallel research agents for maximum context gathering efficiency and depth. This command leverages multiple AI agents working simultaneously to research different aspects of the feature, ensuring comprehensive context is passed to enable self-validation and iterative refinement.

## Parallel Research Phase

**IMPORTANT**: Execute the following 4 research agents simultaneously using multiple Agent tool calls in a single response to maximize research efficiency.

### Research Agent Coordination

Launch these agents concurrently - do not wait for one to complete before starting the next:

#### Agent 1: Codebase Pattern Analysis
```
Task: Codebase Context Research
Prompt: Analyze the codebase for patterns relevant to "$ARGUMENTS". Research and identify:
- Similar features/patterns already implemented in the codebase
- Files that contain relevant examples or patterns to reference
- Existing conventions, architectural patterns, and code styles to follow
- Test patterns and validation approaches used in similar features
- Integration points and dependencies to consider
- File structure and organization patterns to mirror

Focus on codebase exploration only - do not write code. Use Glob, Grep, and Read tools extensively. Return a comprehensive analysis of existing patterns with specific file paths and code examples to reference in the PRP.
```

#### Agent 2: External Technical Research
```
Task: External Technical Research
Prompt: Research external technical resources for "$ARGUMENTS". Investigate:
- Library documentation and API references (include specific URLs)
- Implementation examples from GitHub, StackOverflow, and technical blogs
- Best practices and architectural patterns for similar features
- Common pitfalls, gotchas, and solutions
- Performance considerations and optimization techniques
- Security considerations and vulnerability patterns

Focus purely on research - do not write code. Use web search extensively. Return comprehensive technical research with specific URLs, code examples, and implementation guidance.
```

#### Agent 3: Testing & Validation Strategy
```
Task: Testing Strategy Research
Prompt: Research testing and validation approaches for "$ARGUMENTS". Analyze:
- Test patterns used in the current codebase
- Unit testing strategies and frameworks
- Integration testing approaches
- Validation gates and quality checks
- Error handling and edge case patterns
- Performance testing considerations

Research only - no test implementation. Use codebase analysis and web search. Return detailed testing strategy with specific patterns to follow and validation commands to include in the PRP.
```

#### Agent 4: Documentation & Context Research
```
Task: Documentation Context Research
Prompt: Research documentation and context resources for "$ARGUMENTS". Gather:
- Check PRPs/ai_docs/ for relevant documentation files
- Configuration examples and setup patterns
- Environment and dependency requirements
- Known issues and workarounds documented
- Related feature documentation and examples
- User guides and implementation notes

Research focus only. Use Read tool to examine ai_docs directory. Return documentation context with specific file references and configuration examples to include in the PRP.
```

## Research Synthesis & PRP Generation

Once all agents complete their research, synthesize the findings and generate a comprehensive PRP using the base template structure:

### PRP Template Integration

Using PRPs/templates/prp_base.md as the foundation, integrate the research findings:

#### Critical Context Integration
From the research agents, include:
- **Codebase Patterns**: Specific file paths and code examples from Agent 1
- **Technical Documentation**: URLs and specific sections from Agent 2
- **Testing Strategies**: Validation approaches and patterns from Agent 3
- **Project Documentation**: Relevant ai_docs and configuration from Agent 4

#### Implementation Blueprint Enhancement
- Start with pseudocode informed by existing patterns
- Reference real files and patterns discovered in research
- Include error handling strategies from similar implementations
- List tasks in order of completion based on codebase analysis

#### Context-Rich Validation Gates
```bash
# Syntax/Style (from codebase analysis)
uv run ruff check . --fix
uv run mypy .

# Unit Tests (following existing patterns)
uv run pytest tests/ -v

# Integration Tests (if applicable)
[specific commands found in codebase]
```

### PRP Generation Process

1. **Context Assembly**: Combine all research findings into comprehensive context
2. **Goal Definition**: Clear, specific end state based on research insights
3. **Implementation Strategy**: Step-by-step approach using discovered patterns
4. **Validation Framework**: Executable tests and quality gates
5. **Integration Planning**: Connection points with existing systems

### Required PRP Sections

Generate a complete PRP including:

```yaml
## Goal
[Specific, measurable outcome based on research]

## Why
- Business value and user impact
- Integration with existing features (from codebase analysis)
- Problems this solves and for whom

## What
[User-visible behavior and technical requirements]

## All Needed Context
### Documentation & References
- url: [Specific URLs from external research]
- file: [Specific file paths from codebase analysis]
- docfile: [Relevant PRPs/ai_docs/ files]

### Current Codebase Context
[Tree structure and relevant files]

### Implementation Patterns
[Specific patterns to follow from codebase analysis]

### Known Gotchas
[Library quirks and caveats from research]

## Implementation Blueprint
### Data Models and Structure
[Type-safe models following existing patterns]

### Task List
[Ordered tasks based on dependency analysis]

### Pseudocode
[Implementation approach with critical details]

### Integration Points
[Database, config, routes based on existing patterns]

## Validation Loop
### Level 1: Syntax & Style
[Commands specific to this codebase]

### Level 2: Unit Tests
[Test patterns from codebase analysis]

### Level 3: Integration Tests
[End-to-end validation approach]

## Final Validation Checklist
[Comprehensive quality gates]
```

## Quality Assurance

Before finalizing the PRP, ensure:

### Research Quality
- [ ] All 4 research agents completed successfully
- [ ] Codebase patterns thoroughly analyzed
- [ ] External documentation properly referenced
- [ ] Testing strategies aligned with existing patterns
- [ ] Documentation context comprehensive

### PRP Quality
- [ ] All necessary context included from research
- [ ] Validation gates are executable and specific
- [ ] References existing patterns and conventions
- [ ] Clear implementation path with dependencies
- [ ] Error handling documented with examples
- [ ] Integration points clearly defined

### Context Completeness
- [ ] Specific file paths and examples included
- [ ] URLs with relevant sections specified
- [ ] Library versions and dependencies noted
- [ ] Configuration examples provided
- [ ] Known issues and workarounds documented

## Output

Save the comprehensive PRP as: `PRPs/{feature-name}-parallel.md`

## Success Metrics

Score the PRP on a scale of 1-10 for:
- **Context Richness**: How much relevant context is included
- **Implementation Clarity**: How clear the implementation path is
- **Validation Completeness**: How comprehensive the testing strategy is
- **One-Pass Success Probability**: Confidence level for successful implementation

Target: 8+ on all metrics through parallel research depth

## Time Efficiency

This parallel approach reduces PRP creation time by:
- **4x faster research**: Parallel agents vs sequential
- **Better context**: Multiple perspectives simultaneously
- **Reduced iterations**: Comprehensive upfront research
- **Higher success rate**: More thorough preparation

Remember: The goal is one-pass implementation success through comprehensive parallel research and context gathering.