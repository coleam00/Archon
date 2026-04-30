# Developer Reference Guide

This document provides detailed standards, patterns, and best practices for code implementation.

## Table of Contents

1. [Clean Code Standards](#clean-code-standards)
2. [Testing Standards](#testing-standards)
3. [Code Review Checklist](#code-review-checklist)
4. [Git Workflow](#git-workflow)
5. [Common Patterns](#common-patterns)

## Clean Code Standards

### Naming Conventions

**Variables and Functions:**
```javascript
// Good
const userProfile = getUserProfile(userId);
function calculateTotalPrice(items, taxRate) { ... }

// Bad
const up = getUP(u);
function calc(i, t) { ... }
```

**Classes and Components:**
```javascript
// Good
class UserAuthenticationService { ... }
const LoginForm = () => { ... }

// Bad
class UAS { ... }
const Form1 = () => { ... }
```

**Constants:**
```javascript
// Good
const MAX_RETRY_ATTEMPTS = 3;
const API_BASE_URL = 'https://api.example.com';

// Bad
const max = 3;
const url = 'https://api.example.com';
```

### Function Design

**Single Responsibility:**
Each function should do one thing well.

```javascript
// Good - Single responsibility
function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function saveUser(user) {
  return database.users.insert(user);
}

// Bad - Multiple responsibilities
function validateAndSaveUser(email, userData) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error('Invalid email');
  }
  return database.users.insert({ email, ...userData });
}
```

**Function Size:**
Keep functions under 50 lines. If longer, break into smaller functions.

```javascript
// Good - Broken into smaller functions
function processOrder(order) {
  validateOrder(order);
  const total = calculateOrderTotal(order);
  const payment = processPayment(order.paymentMethod, total);
  return createOrderRecord(order, payment);
}

// Bad - Too long (not shown fully, but imagine 80+ lines)
function processOrder(order) {
  // 80+ lines of validation, calculation, payment, and recording
}
```

**Parameter Limits:**
Limit to 3-4 parameters. Use object parameter for more.

```javascript
// Good
function createUser({ email, name, age, address }) { ... }

// Bad
function createUser(email, name, age, street, city, state, zip) { ... }
```

### DRY Principle (Don't Repeat Yourself)

Extract common logic into reusable functions.

```javascript
// Good - DRY
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(amount);
}

const price = formatCurrency(19.99);
const total = formatCurrency(59.97);

// Bad - Repetition
const price = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
}).format(19.99);

const total = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
}).format(59.97);
```

### Error Handling

**Explicit Error Handling:**
```javascript
// Good - Explicit handling
async function fetchUser(userId) {
  try {
    const response = await api.get(`/users/${userId}`);
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      throw new UserNotFoundError(userId);
    }
    throw new APIError('Failed to fetch user', error);
  }
}

// Bad - Silent failure
async function fetchUser(userId) {
  try {
    const response = await api.get(`/users/${userId}`);
    return response.data;
  } catch (error) {
    return null; // Swallowing error
  }
}
```

**Validation:**
```javascript
// Good - Early validation with clear errors
function calculateDiscount(price, discountPercent) {
  if (typeof price !== 'number' || price < 0) {
    throw new Error('Price must be a non-negative number');
  }
  if (typeof discountPercent !== 'number' || discountPercent < 0 || discountPercent > 100) {
    throw new Error('Discount percent must be between 0 and 100');
  }
  return price * (discountPercent / 100);
}
```

### Comments

Comments should explain **why**, not **what**.

```javascript
// Good - Explains why
// Using exponential backoff to prevent overwhelming the API during outages
const retryDelay = Math.pow(2, attemptNumber) * 1000;

// Bad - States the obvious
// Set retry delay
const retryDelay = Math.pow(2, attemptNumber) * 1000;

// Good - Documents complex business logic
// Accounts created before 2023 use legacy pricing (grandfathered)
if (account.createdAt < new Date('2023-01-01')) {
  return LEGACY_PRICING_TIER;
}

// Bad - Redundant comment
// Check if account created before 2023
if (account.createdAt < new Date('2023-01-01')) {
  return LEGACY_PRICING_TIER;
}
```

### Code Organization

**File Structure:**
```
src/
├── components/        # UI components
│   ├── common/       # Reusable components
│   └── features/     # Feature-specific components
├── services/         # Business logic and API calls
├── utils/           # Helper functions
├── hooks/           # Custom React hooks
├── store/           # State management
├── types/           # TypeScript types/interfaces
└── constants/       # Application constants
```

**Module Exports:**
```javascript
// Good - Clear exports
export function formatDate(date) { ... }
export function parseDate(dateString) { ... }
export const DATE_FORMAT = 'YYYY-MM-DD';

// Bad - Default export of object
export default {
  formatDate: (date) => { ... },
  parseDate: (dateString) => { ... },
  DATE_FORMAT: 'YYYY-MM-DD'
};
```

## Testing Standards

### Unit Tests

Test individual functions and components in isolation.

```javascript
// Good unit test
describe('calculateDiscount', () => {
  it('should calculate correct discount amount', () => {
    expect(calculateDiscount(100, 10)).toBe(10);
    expect(calculateDiscount(50, 20)).toBe(10);
  });

  it('should handle zero discount', () => {
    expect(calculateDiscount(100, 0)).toBe(0);
  });

  it('should throw error for negative price', () => {
    expect(() => calculateDiscount(-10, 10)).toThrow('non-negative');
  });

  it('should throw error for invalid discount percent', () => {
    expect(() => calculateDiscount(100, -5)).toThrow('between 0 and 100');
    expect(() => calculateDiscount(100, 150)).toThrow('between 0 and 100');
  });
});
```

### Integration Tests

Test component interactions and workflows.

```javascript
// Good integration test
describe('User Authentication Flow', () => {
  it('should authenticate user with valid credentials', async () => {
    const mockUser = { email: 'test@example.com', password: 'password123' };

    // Test service layer integration
    const token = await authService.login(mockUser.email, mockUser.password);
    expect(token).toBeTruthy();

    // Test session creation
    const session = await sessionService.getSession(token);
    expect(session.user.email).toBe(mockUser.email);
  });

  it('should reject invalid credentials', async () => {
    await expect(
      authService.login('test@example.com', 'wrongpassword')
    ).rejects.toThrow('Invalid credentials');
  });
});
```

### E2E Tests

Test complete user flows from UI to backend.

```javascript
// Good E2E test (using Playwright/Cypress syntax)
describe('User Login Journey', () => {
  it('should allow user to login and see dashboard', async () => {
    await page.goto('/login');

    await page.fill('[data-testid="email-input"]', 'user@example.com');
    await page.fill('[data-testid="password-input"]', 'password123');
    await page.click('[data-testid="login-button"]');

    // Should redirect to dashboard
    await expect(page).toHaveURL('/dashboard');
    await expect(page.locator('[data-testid="user-name"]'))
      .toContainText('John Doe');
  });

  it('should show error for invalid credentials', async () => {
    await page.goto('/login');

    await page.fill('[data-testid="email-input"]', 'user@example.com');
    await page.fill('[data-testid="password-input"]', 'wrongpassword');
    await page.click('[data-testid="login-button"]');

    await expect(page.locator('[data-testid="error-message"]'))
      .toContainText('Invalid credentials');
  });
});
```

### Test Coverage

**Coverage Targets:**
- Overall: 80% minimum
- Critical paths: 90%+ (authentication, payments, data mutations)
- Utility functions: 95%+ (should be easy to fully test)

**What to Test:**
1. Happy path (expected usage)
2. Edge cases (boundary values, empty inputs)
3. Error conditions (invalid inputs, network failures)
4. Security scenarios (unauthorized access, injection)

**What Not to Test:**
- Third-party library internals
- Trivial getters/setters
- Generated code
- Configuration files

### Mocking Strategies

```javascript
// Good - Mock external dependencies
describe('UserService', () => {
  let mockDatabase;

  beforeEach(() => {
    mockDatabase = {
      users: {
        findById: jest.fn(),
        insert: jest.fn(),
        update: jest.fn()
      }
    };
  });

  it('should fetch user by id', async () => {
    const mockUser = { id: 1, name: 'John' };
    mockDatabase.users.findById.mockResolvedValue(mockUser);

    const userService = new UserService(mockDatabase);
    const user = await userService.getUser(1);

    expect(user).toEqual(mockUser);
    expect(mockDatabase.users.findById).toHaveBeenCalledWith(1);
  });
});
```

## Code Review Checklist

See [templates/code-review.template.md](templates/code-review.template.md) for full checklist.

**Key Review Points:**
1. Does code meet acceptance criteria?
2. Are all edge cases handled?
3. Is error handling explicit and appropriate?
4. Are tests comprehensive (80%+ coverage)?
5. Do tests cover edge cases and errors?
6. Are function and variable names descriptive?
7. Are functions small and focused?
8. Is code DRY (no unnecessary repetition)?
9. Are there security vulnerabilities?
10. Is performance acceptable?
11. Is documentation adequate?
12. Does code follow project conventions?

## Git Workflow

### Commit Messages

Follow Conventional Commits format:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `docs`: Documentation changes
- `chore`: Maintenance tasks
- `perf`: Performance improvements

**Examples:**
```
feat(auth): add password reset functionality

Implements password reset flow with email verification.
- Add reset token generation
- Create reset email template
- Add reset form validation

Closes #123

fix(api): handle null response from user service

Prevents crash when user service returns null for deleted users.

refactor(utils): extract date formatting to utility function

test(auth): add edge case tests for login validation
```

### Branch Strategy

```
main (or master)          # Production-ready code
  ├── develop            # Integration branch (if using git-flow)
  ├── feature/STORY-001  # Feature branches
  ├── feature/STORY-002
  └── hotfix/critical-bug # Hotfix branches
```

**Branch Naming:**
- Features: `feature/STORY-ID-short-description` or `feature/short-description`
- Fixes: `fix/bug-description` or `fix/ISSUE-ID`
- Hotfixes: `hotfix/critical-issue`

### Commit Frequency

- Commit after each logical unit of work
- Commit before switching tasks
- Commit before refactoring
- Push at least daily (or more for collaboration)

**Good Commit Sequence:**
```
feat(auth): add User model and schema
feat(auth): add login endpoint
feat(auth): add session management
test(auth): add unit tests for authentication
feat(auth): add login form component
test(auth): add integration tests for login flow
docs(auth): add authentication API documentation
```

## Common Patterns

### Async/Await Error Handling

```javascript
// Good - Consistent error handling pattern
async function fetchAndProcessData(id) {
  try {
    const data = await fetchData(id);
    const processed = await processData(data);
    return processed;
  } catch (error) {
    logger.error('Failed to fetch and process data', { id, error });
    throw new DataProcessingError('Unable to process data', error);
  }
}
```

### API Response Formatting

```javascript
// Good - Consistent response format
function successResponse(data, message = 'Success') {
  return {
    success: true,
    message,
    data
  };
}

function errorResponse(message, statusCode = 400) {
  return {
    success: false,
    message,
    statusCode
  };
}

// Usage
app.get('/users/:id', async (req, res) => {
  try {
    const user = await userService.getUser(req.params.id);
    res.json(successResponse(user));
  } catch (error) {
    res.status(404).json(errorResponse('User not found', 404));
  }
});
```

### State Management Pattern (React)

```javascript
// Good - Custom hook for state management
function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const login = async (email, password) => {
    setLoading(true);
    setError(null);
    try {
      const userData = await authService.login(email, password);
      setUser(userData);
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    authService.logout();
    setUser(null);
  };

  return { user, loading, error, login, logout };
}
```

### Validation Pattern

```javascript
// Good - Reusable validation with clear errors
const userSchema = {
  email: (value) => {
    if (!value) return 'Email is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Invalid email format';
    return null;
  },
  password: (value) => {
    if (!value) return 'Password is required';
    if (value.length < 8) return 'Password must be at least 8 characters';
    return null;
  }
};

function validate(data, schema) {
  const errors = {};
  for (const [field, validator] of Object.entries(schema)) {
    const error = validator(data[field]);
    if (error) errors[field] = error;
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

// Usage
const errors = validate(userData, userSchema);
if (errors) {
  return res.status(400).json(errorResponse('Validation failed', 400, errors));
}
```

## Summary

- Write clean, readable code with descriptive names
- Keep functions small and focused (under 50 lines)
- Follow DRY principle - extract common logic
- Handle errors explicitly, never silently
- Write comprehensive tests (80%+ coverage)
- Test happy path, edge cases, and error conditions
- Commit frequently with clear messages
- Follow project conventions and established patterns
- Refactor as you go - leave code better than you found it

For more resources, see:
- [resources/clean-code-checklist.md](resources/clean-code-checklist.md)
- [resources/testing-standards.md](resources/testing-standards.md)
- [templates/code-review.template.md](templates/code-review.template.md)
