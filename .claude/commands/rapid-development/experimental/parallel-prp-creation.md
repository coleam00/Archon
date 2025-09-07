---
name: parallel-prp-creation
description: Create multiple PRP variations in parallel for comparative analysis and implementation strategy validation
arguments:
  - name: prp_name
    description: The base name for the PRP (e.g., "user-authentication")
  - name: implementation_details
    description: Core feature requirements and context
  - name: number_of_parallel_prps
    description: Number of parallel PRP variations to create (recommended 2-5)
---

# Parallel PRP Creation - Multiple Implementation Strategies

Generate **ARGS** parallel PRP variations for comparative analysis and implementation approach validation. This command leverages multiple AI agents working simultaneously to create different implementation strategies for the same feature, enabling selection of the optimal approach.

## Overview

This workflow creates **NUMBER_OF_PARALLEL_PRPs** independent PRP variations:

- Each agent researches the same feature from different architectural perspectives
- Each agent creates a complete PRP with distinct implementation approaches
- All agents work concurrently for maximum efficiency
- Results enable comparative analysis and strategy selection

## Execution Parameters

PRP_NAME: $ARGUMENTS[0]
IMPLEMENTATION_DETAILS: $ARGUMENTS[1]
NUMBER_OF_PARALLEL_PRPs: $ARGUMENTS[2]

## Parallel Agent Coordination

**CRITICAL**: Execute all agents simultaneously using multiple Task tool calls in a single response. Do not wait for one agent to complete before starting the next.

## Agent Assignment Strategy

Each agent approaches the same feature with different focus areas:

### Agent Specialization Matrix

```yaml
Agent 1: Performance-Optimized Approach
  Focus: Scalability, caching, optimization
  Architecture: High-performance patterns
  Validation: Load testing, performance metrics

Agent 2: Security-First Approach
  Focus: Security, validation, authentication
  Architecture: Defense-in-depth patterns
  Validation: Security testing, penetration testing

Agent 3: Maintainability-Focused Approach
  Focus: Clean code, modularity, testing
  Architecture: SOLID principles, design patterns
  Validation: Unit testing, code quality

Agent 4: Rapid-Development Approach
  Focus: Quick implementation, minimal complexity
  Architecture: Simplified patterns, frameworks
  Validation: Integration testing, functionality

Agent 5: Enterprise-Grade Approach
  Focus: Robustness, monitoring, observability
  Architecture: Enterprise patterns, microservices
  Validation: End-to-end testing, monitoring
```

## Parallel Execution Commands

Execute these agents concurrently:

```
Use the Task tool to run these ${NUMBER_OF_PARALLEL_PRPs} agents in PARALLEL for feature: ${PRP_NAME}

Implementation Details: ${IMPLEMENTATION_DETAILS}
```

### Agent 1: Performance-Optimized Implementation

```
Task: Performance-Optimized PRP Creation
Prompt: Create a comprehensive PRP for "${PRP_NAME}" with focus on PERFORMANCE AND SCALABILITY.

Feature Details: ${IMPLEMENTATION_DETAILS}

Your approach should emphasize:
- High-performance architecture patterns
- Caching strategies and optimization techniques
- Database optimization and indexing
- Async/await patterns and concurrency
- Memory management and resource efficiency
- Load balancing and horizontal scaling considerations

Research Phase:
1. Analyze existing codebase for performance patterns
2. Research high-performance libraries and frameworks
3. Identify bottlenecks and optimization opportunities
4. Study caching layers and data access patterns
5. Review performance monitoring and metrics

PRP Creation:
- Use PRPs/templates/prp_base.md as foundation
- Focus implementation blueprint on performance patterns
- Include specific performance validation gates
- Add load testing and benchmarking requirements
- Reference existing high-performance code examples

Output Files:
1. Save PRP as: PRPs/${PRP_NAME}-1.md
2. Save comprehensive results as: RESULTS_${PRP_NAME}-1.md

Include in results:
- Performance analysis of current codebase
- Specific optimization opportunities identified
- Implementation approach summary
- Performance validation strategy
- Expected performance improvements

Do NOT run any servers, builds, or executables. Focus on research and PRP creation only.
```

### Agent 2: Security-First Implementation

```
Task: Security-First PRP Creation
Prompt: Create a comprehensive PRP for "${PRP_NAME}" with focus on SECURITY AND DATA PROTECTION.

Feature Details: ${IMPLEMENTATION_DETAILS}

Your approach should emphasize:
- Security-by-design architecture patterns
- Authentication and authorization strategies
- Input validation and sanitization
- Data encryption and protection
- Security monitoring and logging
- Vulnerability assessment and mitigation

Research Phase:
1. Analyze existing security patterns in codebase
2. Research security frameworks and best practices
3. Identify potential attack vectors and vulnerabilities
4. Study authentication and authorization mechanisms
5. Review security testing and validation approaches

PRP Creation:
- Use PRPs/templates/prp_base.md as foundation
- Focus implementation blueprint on security patterns
- Include comprehensive security validation gates
- Add penetration testing and security scan requirements
- Reference existing security implementations

Output Files:
1. Save PRP as: PRPs/${PRP_NAME}-2.md
2. Save comprehensive results as: RESULTS_${PRP_NAME}-2.md

Include in results:
- Security analysis of current implementation
- Identified security risks and mitigations
- Implementation approach summary
- Security validation strategy
- Compliance considerations

Do NOT run any servers, builds, or executables. Focus on research and PRP creation only.
```

### Agent 3: Maintainability-Focused Implementation

```
Task: Maintainability-Focused PRP Creation
Prompt: Create a comprehensive PRP for "${PRP_NAME}" with focus on CODE QUALITY AND MAINTAINABILITY.

Feature Details: ${IMPLEMENTATION_DETAILS}

Your approach should emphasize:
- Clean code principles and SOLID design
- Comprehensive testing strategies (unit, integration, E2E)
- Modular architecture and separation of concerns
- Documentation and code readability
- Refactoring and technical debt prevention
- Type safety and static analysis

Research Phase:
1. Analyze existing code quality patterns in codebase
2. Research testing frameworks and quality tools
3. Identify areas for improved modularity
4. Study documentation and commenting standards
5. Review refactoring opportunities and patterns

PRP Creation:
- Use PRPs/templates/prp_base.md as foundation
- Focus implementation blueprint on clean code patterns
- Include comprehensive testing validation gates
- Add code quality metrics and static analysis
- Reference existing well-structured code examples

Output Files:
1. Save PRP as: PRPs/${PRP_NAME}-3.md
2. Save comprehensive results as: RESULTS_${PRP_NAME}-3.md

Include in results:
- Code quality analysis of current codebase
- Identified technical debt and improvement opportunities
- Implementation approach summary
- Testing and quality validation strategy
- Maintainability metrics and targets

Do NOT run any servers, builds, or executables. Focus on research and PRP creation only.
```

### Agent 4: Rapid-Development Implementation

```
Task: Rapid-Development PRP Creation
Prompt: Create a comprehensive PRP for "${PRP_NAME}" with focus on SPEED OF IMPLEMENTATION.

Feature Details: ${IMPLEMENTATION_DETAILS}

Your approach should emphasize:
- Minimal viable implementation patterns
- Framework utilization and code generation
- Simplified architecture and reduced complexity
- Quick wins and iterative development
- Leveraging existing libraries and components
- Fast feedback loops and validation

Research Phase:
1. Analyze existing codebase for reusable components
2. Research rapid development frameworks and tools
3. Identify opportunities for code reuse and simplification
4. Study existing patterns that can be quickly adapted
5. Review integration testing for fast validation

PRP Creation:
- Use PRPs/templates/prp_base.md as foundation
- Focus implementation blueprint on rapid delivery patterns
- Include streamlined validation gates for quick feedback
- Add integration testing for core functionality
- Reference existing components that can be leveraged

Output Files:
1. Save PRP as: PRPs/${PRP_NAME}-4.md
2. Save comprehensive results as: RESULTS_${PRP_NAME}-4.md

Include in results:
- Analysis of reusable components in codebase
- Identified shortcuts and simplification opportunities
- Implementation approach summary
- Rapid validation strategy
- Time estimates and delivery milestones

Do NOT run any servers, builds, or executables. Focus on research and PRP creation only.
```

### Agent 5: Enterprise-Grade Implementation

```
Task: Enterprise-Grade PRP Creation
Prompt: Create a comprehensive PRP for "${PRP_NAME}" with focus on ENTERPRISE ROBUSTNESS.

Feature Details: ${IMPLEMENTATION_DETAILS}

Your approach should emphasize:
- Enterprise architecture patterns and scalability
- Comprehensive monitoring and observability
- Error handling and resilience patterns
- Configuration management and deployment
- Documentation and operational procedures
- Compliance and audit requirements

Research Phase:
1. Analyze existing enterprise patterns in codebase
2. Research enterprise frameworks and monitoring tools
3. Identify requirements for production deployment
4. Study error handling and recovery mechanisms
5. Review operational and maintenance procedures

PRP Creation:
- Use PRPs/templates/prp_base.md as foundation
- Focus implementation blueprint on enterprise patterns
- Include comprehensive operational validation gates
- Add monitoring, logging, and alerting requirements
- Reference existing enterprise-grade implementations

Output Files:
1. Save PRP as: PRPs/${PRP_NAME}-5.md
2. Save comprehensive results as: RESULTS_${PRP_NAME}-5.md

Include in results:
- Enterprise readiness analysis of current codebase
- Identified operational and monitoring requirements
- Implementation approach summary
- Production validation strategy
- Operational procedures and documentation

Do NOT run any servers, builds, or executables. Focus on research and PRP creation only.
```

## Agent Execution Rules

### Research Guidelines

Each agent must independently:

1. **Codebase Analysis**
   - Use Glob, Grep, and Read tools extensively
   - Identify relevant existing patterns and code examples
   - Analyze project structure and architectural decisions
   - Find similar implementations to reference

2. **External Research**
   - Use WebSearch for framework documentation
   - Research best practices and implementation patterns
   - Find relevant examples and case studies
   - Identify potential libraries and tools

3. **Context Documentation**
   - Read PRPs/ai_docs/ for project-specific documentation
   - Analyze configuration files and setup patterns
   - Identify environment and dependency requirements
   - Document existing conventions and standards

### PRP Creation Requirements

Each agent must create a complete PRP including:

```yaml
## Goal
[Specific implementation goal with focus area emphasis]

## Why
- Business value aligned with approach focus
- Integration considerations for chosen strategy
- Trade-offs and benefits of selected approach

## What
[Feature requirements tailored to implementation strategy]

## All Needed Context
### Documentation & References
- url: [Framework docs specific to approach]
- file: [Relevant existing code examples]
- docfile: [Project documentation from ai_docs/]

### Implementation Patterns
[Specific patterns for chosen approach]

### Known Gotchas
[Approach-specific challenges and solutions]

## Implementation Blueprint
### Data Models and Structure
[Models optimized for chosen approach]

### Task List
[Ordered tasks specific to implementation strategy]

### Pseudocode
[Implementation approach with strategy-specific details]

### Integration Points
[Integration strategy for chosen approach]

## Validation Loop
### Level 1: Syntax & Style
[Standard validation commands]

### Level 2: Unit Tests
[Testing strategy aligned with approach]

### Level 3: Integration Tests
[Validation specific to implementation strategy]

## Final Validation Checklist
[Comprehensive quality gates for chosen approach]
```

### Results Documentation

Each agent must create a comprehensive results file containing:

```markdown
# ${PRP_NAME} Implementation Results - Agent ${N}

## Approach Summary

**Focus**: [Performance/Security/Maintainability/Rapid/Enterprise]
**Strategy**: [Brief description of chosen implementation strategy]

## Research Findings

### Codebase Analysis

- Existing patterns identified: [list with file paths]
- Reusable components found: [list with descriptions]
- Architectural insights: [key findings]

### External Research

- Frameworks/libraries recommended: [list with justifications]
- Best practices identified: [key insights]
- Implementation examples found: [relevant sources]

### Documentation Review

- Project-specific constraints: [from ai_docs analysis]
- Configuration requirements: [environment setup needs]
- Integration considerations: [existing system compatibility]

## Implementation Strategy

### Core Approach

[Detailed explanation of implementation strategy]

### Key Differentiators

[What makes this approach unique compared to alternatives]

### Trade-offs

**Advantages**: [benefits of this approach]
**Disadvantages**: [limitations and challenges]
**Complexity**: [implementation complexity assessment]

## Validation Strategy

### Testing Approach

[Specific testing strategy for this implementation]

### Quality Gates

[Validation checkpoints and success criteria]

### Success Metrics

[How to measure implementation success]

## Recommendations

### Implementation Priority

[Recommended implementation order and dependencies]

### Risk Mitigation

[Identified risks and mitigation strategies]

### Next Steps

[Immediate actions required to proceed]

## Comparative Analysis

### Strengths vs Other Approaches

[Why choose this approach over alternatives]

### Ideal Use Cases

[When this approach is most suitable]

### Performance Expectations

[Expected outcomes and benchmarks]
```

## Coordination Protocol

### Execution Management

1. **Parallel Launch**: All agents start simultaneously
2. **Independent Operation**: No inter-agent communication
3. **Consistent Base**: All use same prp_base.md template
4. **Unique Focus**: Each agent maintains distinct strategic approach
5. **Complete Output**: Each produces both PRP and results files

### Quality Assurance

Each agent must ensure:

- [ ] Complete research across codebase, external sources, and documentation
- [ ] PRP follows base template structure exactly
- [ ] Implementation strategy is clearly differentiated
- [ ] Validation gates are executable and specific
- [ ] Results file provides comprehensive analysis
- [ ] No code execution or server startup attempts

### Time Management

- **Research Phase**: 10-15 minutes per agent
- **PRP Creation**: 15-20 minutes per agent
- **Results Documentation**: 5-10 minutes per agent
- **Total Parallel Time**: 30-45 minutes (all agents concurrent)

## Expected Outputs

Upon completion, you will have:

```
PRPs/
├── ${PRP_NAME}-1.md    # Performance-optimized approach
├── ${PRP_NAME}-2.md    # Security-first approach
├── ${PRP_NAME}-3.md    # Maintainability-focused approach
├── ${PRP_NAME}-4.md    # Rapid-development approach
├── ${PRP_NAME}-5.md    # Enterprise-grade approach

Root Directory/
├── RESULTS_${PRP_NAME}-1.md    # Performance approach analysis
├── RESULTS_${PRP_NAME}-2.md    # Security approach analysis
├── RESULTS_${PRP_NAME}-3.md    # Maintainability approach analysis
├── RESULTS_${PRP_NAME}-4.md    # Rapid development approach analysis
├── RESULTS_${PRP_NAME}-5.md    # Enterprise approach analysis
```

## Comparative Analysis Framework

After all agents complete, synthesize results by comparing:

### Implementation Complexity

- Lines of code estimates
- Development time projections
- Dependency requirements
- Configuration complexity

### Performance Characteristics

- Expected response times
- Resource utilization
- Scalability limitations
- Optimization potential

### Maintenance Burden

- Code complexity metrics
- Testing requirements
- Documentation needs
- Long-term sustainability

### Risk Assessment

- Technical risks
- Security vulnerabilities
- Performance bottlenecks
- Integration challenges

## Selection Criteria

Choose optimal approach based on:

1. **Project Requirements**: Match approach to actual needs
2. **Team Capabilities**: Align with team expertise and resources
3. **Timeline Constraints**: Balance quality with delivery speed
4. **Maintenance Goals**: Consider long-term sustainability
5. **Performance Needs**: Match optimization level to requirements

## Success Metrics

Evaluate parallel PRP creation success by:

- **Coverage Completeness**: All approaches thoroughly researched
- **Strategic Differentiation**: Each PRP offers unique implementation strategy
- **Context Richness**: Comprehensive codebase and external research
- **Validation Clarity**: Executable and specific quality gates
- **Decision Support**: Clear trade-offs enable informed selection

## Emergency Protocols

If agents encounter issues:

1. **Research Roadblocks**: Skip to available similar examples
2. **Context Limitations**: Focus on most relevant existing patterns
3. **Time Constraints**: Prioritize core implementation over edge cases
4. **Resource Conflicts**: Ensure agents work independently
5. **Quality Issues**: Maintain minimum PRP completeness standards

This parallel approach maximizes the probability of identifying the optimal implementation strategy by exploring multiple architectural approaches simultaneously, enabling data-driven selection of the best approach for your specific requirements.
