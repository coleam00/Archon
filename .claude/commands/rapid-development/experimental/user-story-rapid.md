# Analyze User Story and Create Implementation Plan

User Story: $ARGUMENTS

## Task: Create detailed implementation plan for separate backend and frontend projects based on the tech stack detailed in the user story

1. **Parse user story**:
   - Extract: As a [user], I want [feature], so that [benefit]
   - List explicit and implicit acceptance criteria
   - Identify non-functional requirements (performance, security, UX)
   - Define success metrics

2. **Plan API contract first** (backend/frontend agreement):
   ```yaml
   Endpoints:
     - GET /api/v1/{resources} - List with pagination
     - GET /api/v1/{resources}/{id} - Get single resource
     - POST /api/v1/{resources} - Create new
     - PUT /api/v1/{resources}/{id} - Update existing
     - DELETE /api/v1/{resources}/{id} - Delete
   
   DTOs:
     Request: {field validations}
     Response: {field types}
     Error: {standard error format}
   ```

3. **Backend implementation plan** (Java project):
   ```
   Package structure:
   com.company.feature/
   ├── controller/
   ├── service/
   ├── repository/
   ├── entity/
   ├── dto/
   ├── exception/
   └── mapper/
   ```
   
   Implementation order:
   1. Entity with JPA annotations
   2. Repository interface
   3. DTOs with validation
   4. Mapper interface
   5. Service with business logic
   6. Controller with OpenAPI
   7. Exception handling
   8. Integration tests

4. **Frontend implementation plan** (React project):
   ```
   src/features/{feature}/
   ├── api/          # API client functions
   ├── components/   # UI components
   ├── hooks/        # Custom hooks
   ├── schemas/      # Zod validation
   ├── types/        # TypeScript types
   ├── __tests__/    # Component tests
   └── index.ts      # Public exports
   ```
   
   Implementation order:
   1. Zod schemas matching backend DTOs
   2. TypeScript types
   3. API client functions
   4. Custom hooks with TanStack Query
   5. UI components
   6. Forms with validation
   7. Error handling
   8. Component tests

5. **Integration plan**:
   - CORS configuration on backend
   - Environment variables for API URL
   - Error response handling
   - Loading states
   - Optimistic updates where applicable

6. **Validation commands**:
   ```bash
   # Backend (in Java project)
   ./gradlew clean build test
   
   # Frontend (in React project)
   npm run type-check && npm run lint && npm run test:coverage
   
   # Integration (manual or e2e)
   - Start backend: ./gradlew bootRun
   - Start frontend: npm run dev
   - Test full user flow
   ```

7. **Risk mitigation**:
   - Start with API contract agreement
   - Use API mocking in frontend if backend delayed
   - Implement health check endpoint
   - Add request/response logging
   - Plan for error scenarios

Save this plan as: `PRPs/implementations/{feature}-plan.md`