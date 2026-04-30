# Code Review Checklist

Use this checklist when reviewing code before marking a story complete or during peer review.

## Story Completion

- [ ] All acceptance criteria are met
- [ ] All required functionality is implemented
- [ ] Edge cases are handled
- [ ] Error scenarios are covered

## Code Quality

### Clean Code
- [ ] Variable and function names are descriptive and meaningful
- [ ] No single-letter variables (except loop counters)
- [ ] Functions are small and focused (under 50 lines)
- [ ] Each function has a single responsibility
- [ ] Code follows DRY principle (no unnecessary repetition)
- [ ] Common logic is extracted into reusable functions
- [ ] Code is properly organized and modular

### Comments and Documentation
- [ ] Comments explain "why" not "what"
- [ ] Complex business logic is documented
- [ ] No obvious or redundant comments
- [ ] Public APIs have JSDoc/docstring comments
- [ ] README or documentation updated if needed

### Error Handling
- [ ] All errors are handled explicitly
- [ ] No silent error swallowing
- [ ] Error messages are clear and actionable
- [ ] Validation is performed on inputs
- [ ] Edge cases and boundary conditions are handled

### Code Style
- [ ] Code follows project conventions and style guide
- [ ] Consistent formatting (use linter/formatter)
- [ ] No unused imports or variables
- [ ] No commented-out code (remove or explain)
- [ ] Proper indentation and spacing

## Testing

### Test Coverage
- [ ] Test coverage is at least 80%
- [ ] All new code has corresponding tests
- [ ] Critical paths have high coverage (90%+)
- [ ] Coverage report reviewed

### Test Quality
- [ ] Unit tests cover individual functions/components
- [ ] Integration tests cover component interactions
- [ ] E2E tests cover critical user flows (if applicable)
- [ ] Tests cover happy path scenarios
- [ ] Tests cover edge cases and boundary values
- [ ] Tests cover error conditions
- [ ] Tests are readable and well-named
- [ ] Tests don't duplicate coverage unnecessarily
- [ ] Mocks and stubs are used appropriately

### Test Execution
- [ ] All tests pass locally
- [ ] All tests pass in CI/CD pipeline (if applicable)
- [ ] No flaky or intermittent test failures
- [ ] Tests run in reasonable time

## Security

- [ ] No hardcoded secrets, API keys, or passwords
- [ ] Sensitive data is properly encrypted/hashed
- [ ] User inputs are validated and sanitized
- [ ] SQL injection prevented (parameterized queries)
- [ ] XSS vulnerabilities prevented (output escaping)
- [ ] Authentication and authorization properly implemented
- [ ] No security vulnerabilities introduced
- [ ] Dependencies are up-to-date and secure

## Performance

- [ ] No obvious performance issues
- [ ] Database queries are optimized (indexes, no N+1)
- [ ] Large datasets are paginated or lazy-loaded
- [ ] Expensive operations are cached when appropriate
- [ ] No memory leaks (event listeners cleaned up)
- [ ] Async operations used for I/O-bound tasks

## Database Changes

- [ ] Migrations are reversible (have up and down)
- [ ] Migrations are tested
- [ ] Database schema changes are documented
- [ ] Indexes added for frequently queried columns
- [ ] Foreign keys and constraints properly defined

## API Changes

- [ ] API endpoints follow RESTful conventions
- [ ] Request/response formats are documented
- [ ] Backward compatibility maintained (or breaking changes documented)
- [ ] API versioning used if needed
- [ ] Proper HTTP status codes used
- [ ] Rate limiting considered (if applicable)

## Frontend (if applicable)

- [ ] UI matches design specifications
- [ ] Responsive design works on different screen sizes
- [ ] Accessibility standards followed (WCAG)
- [ ] Loading states and error states handled
- [ ] Form validation provides clear feedback
- [ ] No console errors or warnings

## Git and Version Control

- [ ] Commits are small and focused
- [ ] Commit messages are clear and descriptive
- [ ] Commit messages follow conventional format
- [ ] No merge conflicts
- [ ] No unrelated changes included
- [ ] Branch is up-to-date with main/develop

## Deployment Readiness

- [ ] Environment variables documented (if new ones added)
- [ ] Configuration changes documented
- [ ] Database migrations can run safely in production
- [ ] Rollback plan considered for risky changes
- [ ] Monitoring/logging added for new features

## Documentation

- [ ] README updated if needed
- [ ] API documentation updated (if API changed)
- [ ] Architecture documentation updated (if structure changed)
- [ ] Inline comments for complex logic
- [ ] Setup/installation instructions updated (if needed)

## Review Notes

### What was reviewed:
<!-- List files or components reviewed -->

### Issues found:
<!-- List any issues that need to be addressed -->

### Suggestions for improvement:
<!-- List non-blocking suggestions -->

### Positive observations:
<!-- Note particularly good implementations -->

---

## Reviewer Sign-off

- **Reviewer Name:**
- **Date:**
- **Approval:** [ ] Approved [ ] Needs changes [ ] Rejected

## Self-Review Notes

Use this section when performing self-review before requesting peer review:

### Tested scenarios:
<!-- List what you manually tested -->

### Known limitations:
<!-- Note any known limitations or technical debt -->

### Follow-up items:
<!-- List any TODO items or follow-up work needed -->

---

**Note:** This is a comprehensive checklist. Not all items apply to every change. Use judgment to focus on relevant items for the specific code being reviewed.
