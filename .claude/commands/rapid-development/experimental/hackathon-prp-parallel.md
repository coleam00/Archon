---
command: hackathon-prp-parallel
description: Generate and execute a hackathon implementation using massive parallel agents for maximum speed
arguments:
  - name: challenge
    description: The hackathon challenge or user story to implement
---

# Hackathon PRP Parallel Workflow - Maximum Speed Edition

Execute a massive parallel workflow that leverages multiple AI agents working simultaneously to deliver a complete solution in record time.

## Overview

This workflow deploys 20+ parallel agents:
- 5 agents for spec generation (different perspectives)
- 5 agents for prompt plan creation
- 5 agents for backend implementation
- 5 agents for frontend implementation
- 2 agents for integration and demo prep

All agents work concurrently and report results for synthesis.

## Step 1: Parallel Spec Generation (5 minutes)

Deploy 5 parallel agents to analyze the challenge from different angles:

```
Use the Task tool to run these 5 research agents in PARALLEL for challenge: $ARGUMENTS

Task 1 - Technical Architecture Agent:
"Analyze {{challenge}} and create technical architecture spec:
- System design and components
- Technology choices and justification
- API design patterns
- Database schema design
- Performance considerations
- Security architecture
Save to: PRPs/specs/{{challenge|slugify}}-tech-spec.md"

Task 2 - User Experience Agent:
"Analyze {{challenge}} from UX perspective:
- User journeys and flows
- UI component requirements
- Interaction patterns
- Accessibility requirements
- Error handling UX
- Loading and feedback states
Save to: PRPs/specs/{{challenge|slugify}}-ux-spec.md"

Task 3 - Business Logic Agent:
"Define business rules and logic for {{challenge}}:
- Core business rules
- Validation requirements
- Edge cases and exceptions
- Data integrity rules
- Business process flows
- Integration requirements
Save to: PRPs/specs/{{challenge|slugify}}-business-spec.md"

Task 4 - Testing Strategy Agent:
"Create comprehensive testing strategy:
- Test scenarios and cases
- Performance test requirements
- Security test cases
- Integration test approach
- Demo test scenarios
- Coverage targets
Save to: PRPs/specs/{{challenge|slugify}}-test-spec.md"

Task 5 - Demo Impact Agent:
"Analyze for maximum demo impact:
- Key features to highlight
- Wow factors to implement
- Metrics to showcase
- Story narrative
- Backup plans
- Time allocations
Save to: PRPs/specs/{{challenge|slugify}}-demo-spec.md"

Synthesize all specs into: PRPs/specs/{{challenge|slugify}}-unified-spec.md
```

## Step 2: Parallel Prompt Plan Generation (5 minutes)

While specs are being generated, deploy 5 more agents to create execution plans:

```
Use the Task tool to run these 5 planning agents in PARALLEL:

Task 6 - Backend Plan Agent:
"Create detailed backend implementation prompts:
- Entity creation prompts
- Service layer prompts
- API endpoint prompts
- Testing prompts
- Integration prompts
Include exact code patterns and commands.
Save to: PRPs/plans/{{challenge|slugify}}-backend-plan.md"

Task 7 - Frontend Plan Agent:
"Create detailed frontend implementation prompts:
- Component creation prompts
- State management prompts
- Form handling prompts
- API integration prompts
- Testing prompts
Include exact code patterns.
Save to: PRPs/plans/{{challenge|slugify}}-frontend-plan.md"

Task 8 - Database Plan Agent:
"Create database implementation prompts:
- Schema creation
- Migration scripts
- Seed data
- Indexes and optimization
- Backup procedures
Save to: PRPs/plans/{{challenge|slugify}}-database-plan.md"

Task 9 - DevOps Plan Agent:
"Create deployment and infrastructure prompts:
- Docker configuration
- CI/CD setup
- Environment variables
- Monitoring setup
- Performance optimization
Save to: PRPs/plans/{{challenge|slugify}}-devops-plan.md"

Task 10 - Quality Plan Agent:
"Create quality assurance prompts:
- Linting setup
- Test coverage configuration
- Code review checklist
- Performance benchmarks
- Security scans
Save to: PRPs/plans/{{challenge|slugify}}-quality-plan.md"

Merge all plans into: PRPs/plans/{{challenge|slugify}}-master-plan.md
```

## Step 3: Parallel Implementation Phase (20 minutes)

Deploy massive parallel implementation across backend and frontend:

### Backend Implementation Agents (run simultaneously):

```
Use the Task tool to run these 5 backend agents in PARALLEL:

Task 11 - Entity & Repository Agent:
"In the backend project:
1. Create all JPA entities from spec
2. Add Lombok annotations
3. Create repository interfaces
4. Add custom queries
5. Write entity tests
Follow patterns in existing entities.
Report completion status."

Task 12 - Service Layer Agent:
"In the backend project:
1. Create service interfaces
2. Implement business logic
3. Add transaction management
4. Implement error handling
5. Write comprehensive service tests
Use TDD approach - tests first!
Report completion status."

Task 13 - REST API Agent:
"In the backend project:
1. Create REST controllers
2. Add OpenAPI documentation
3. Implement all endpoints
4. Add request validation
5. Write integration tests
Ensure proper HTTP status codes.
Report completion status."

Task 14 - Security & Auth Agent:
"In the backend project:
1. Add security configuration
2. Implement authentication
3. Add authorization rules
4. Secure endpoints
5. Write security tests
Follow Spring Security best practices.
Report completion status."

Task 15 - Backend Integration Agent:
"In the backend project:
1. Wire all components together
2. Add exception handlers
3. Configure CORS
4. Add logging
5. Run full backend tests
Ensure everything integrates properly.
Report completion status and test results."
```

### Frontend Implementation Agents (run simultaneously):

```
Use the Task tool to run these 5 frontend agents in PARALLEL:

Task 16 - Component Tree Agent:
"In the frontend project:
1. Create feature folder structure
2. Build all React components
3. Add TypeScript interfaces
4. Implement component states
5. Write component tests
Follow vertical slice architecture.
Report completion status."

Task 17 - State Management Agent:
"In the frontend project:
1. Set up TanStack Query
2. Create API client functions
3. Add query hooks
4. Implement mutations
5. Write hook tests
Use Zod for validation.
Report completion status."

Task 18 - Forms & Validation Agent:
"In the frontend project:
1. Create all forms with React Hook Form
2. Add Zod schemas
3. Implement validation
4. Add error handling
5. Write form tests
Ensure accessibility compliance.
Report completion status."

Task 19 - UI Polish Agent:
"In the frontend project:
1. Add loading states
2. Implement error boundaries
3. Add animations/transitions
4. Ensure responsive design
5. Add performance optimizations
Make it look professional.
Report completion status."

Task 20 - Frontend Integration Agent:
"In the frontend project:
1. Connect all components
2. Wire up API calls
3. Test full user flows
4. Add error handling
5. Run all frontend tests
Ensure smooth user experience.
Report completion status and test results."
```

## Step 4: System Integration (5 minutes)

Deploy integration agents to connect everything:

```
Use the Task tool to run these 2 agents in PARALLEL:

Task 21 - Full Stack Integration Agent:
"Connect frontend to backend:
1. Update API endpoints in frontend
2. Test all CRUD operations
3. Verify error handling
4. Check authentication flow
5. Test edge cases
6. Measure response times
Run both services and validate integration.
Report any issues found."

Task 22 - Demo Preparation Agent:
"Prepare for demo:
1. Create demo script with timing
2. Set up demo data
3. Create metrics dashboard
4. Prepare backup scenarios
5. Test full demo flow
6. Generate presentation points
Save demo materials to PRPs/demos/{{challenge|slugify}}/
Report demo readiness."
```

## Step 5: Parallel Quality Assurance (5 minutes)

Run final validation across all components:

```
Use the Task tool to run these 3 agents in PARALLEL:

Task 23 - Backend QA Agent:
"Run comprehensive backend validation:
1. ./gradlew test - all tests
2. ./gradlew jacocoTestReport - coverage
3. ./gradlew spotlessCheck - formatting
4. ./gradlew sonarqube - code quality
5. Performance testing
Report all metrics and any failures."

Task 24 - Frontend QA Agent:
"Run comprehensive frontend validation:
1. npm test -- --coverage
2. npm run lint
3. npm run type-check
4. npm run build
5. Lighthouse audit
Report all metrics and any failures."

Task 25 - Integration QA Agent:
"Run end-to-end testing:
1. Full user journey tests
2. API contract testing
3. Performance benchmarks
4. Security scan
5. Accessibility audit
Report comprehensive quality metrics."
```

## Execution Monitoring

Create a real-time dashboard showing:

```
## Parallel Execution Status

### Spec Generation (Tasks 1-5)
- [ ] Technical Architecture: [status]
- [ ] User Experience: [status]
- [ ] Business Logic: [status]
- [ ] Testing Strategy: [status]
- [ ] Demo Impact: [status]

### Planning Phase (Tasks 6-10)
- [ ] Backend Plan: [status]
- [ ] Frontend Plan: [status]
- [ ] Database Plan: [status]
- [ ] DevOps Plan: [status]
- [ ] Quality Plan: [status]

### Backend Implementation (Tasks 11-15)
- [ ] Entities: [status]
- [ ] Services: [status]
- [ ] REST API: [status]
- [ ] Security: [status]
- [ ] Integration: [status]

### Frontend Implementation (Tasks 16-20)
- [ ] Components: [status]
- [ ] State Management: [status]
- [ ] Forms: [status]
- [ ] UI Polish: [status]
- [ ] Integration: [status]

### Final Phase (Tasks 21-25)
- [ ] Full Stack Integration: [status]
- [ ] Demo Preparation: [status]
- [ ] Backend QA: [status]
- [ ] Frontend QA: [status]
- [ ] Integration QA: [status]

### Metrics
- Total Agents: 25
- Parallel Execution Groups: 5
- Estimated Time: 40 minutes
- Lines of Code Generated: [count]
- Test Coverage: [percentage]
- Response Time: [ms]
```

## Coordination Protocol

1. **Phase Gates**: Each phase must complete before next
2. **Failure Handling**: If an agent fails, reassign to another
3. **Synthesis Points**: After each phase, synthesize results
4. **Progress Tracking**: Update dashboard in real-time
5. **Time Boxing**: Each agent has strict time limits

## Emergency Protocols

If running behind schedule:
1. Reduce agent count per phase
2. Skip non-critical agents (DevOps, some QA)
3. Focus on core functionality only
4. Use mock data instead of full implementation
5. Prioritize demo-critical features

## Success Metrics

Showcase the power of parallel execution:
- 25 AI agents working simultaneously
- 40-minute complete implementation
- 80%+ test coverage
- Sub-100ms response times
- Full documentation generated
- Production-ready code

## Execution Command

```bash
# Start the parallel execution
/hackathon hackathon-prp-parallel "{{challenge}}"

# Monitor progress
/hackathon show-parallel-status

# Get final metrics
/hackathon generate-metrics-report
```

This parallel approach demonstrates the true power of AI-assisted development, showing how multiple AI agents can collaborate to deliver enterprise-quality solutions at unprecedented speed!