# Testing Standards

A comprehensive guide to testing patterns, strategies, and best practices for achieving high-quality test coverage.

## Table of Contents

1. [Testing Pyramid](#testing-pyramid)
2. [Unit Testing](#unit-testing)
3. [Integration Testing](#integration-testing)
4. [End-to-End Testing](#end-to-end-testing)
5. [Coverage Targets](#coverage-targets)
6. [Mocking Strategies](#mocking-strategies)
7. [Test Organization](#test-organization)
8. [Best Practices](#best-practices)

## Testing Pyramid

The testing pyramid guides how to balance different types of tests:

```
       /\
      /  \      E2E Tests (Few)
     /____\     - Test complete user flows
    /      \    - Slow, expensive, brittle
   /________\   Integration Tests (Some)
  /          \  - Test component interactions
 /____________\ - Moderate speed and cost
/              \ Unit Tests (Many)
/________________\ - Test individual functions
                   - Fast, cheap, reliable
```

**Distribution:**
- 70% Unit Tests
- 20% Integration Tests
- 10% E2E Tests

## Unit Testing

Unit tests verify individual functions, methods, or components in isolation.

### Characteristics

- Fast (milliseconds)
- Isolated (no external dependencies)
- Focused (one thing per test)
- Deterministic (same result every time)

### Unit Test Patterns

#### Testing Pure Functions

**✓ Good:**
```javascript
// Function under test
function calculateDiscount(price, discountPercent) {
  if (price < 0 || discountPercent < 0 || discountPercent > 100) {
    throw new Error('Invalid input');
  }
  return price * (discountPercent / 100);
}

// Tests
describe('calculateDiscount', () => {
  it('should calculate correct discount amount', () => {
    expect(calculateDiscount(100, 10)).toBe(10);
    expect(calculateDiscount(50, 20)).toBe(10);
  });

  it('should handle zero discount', () => {
    expect(calculateDiscount(100, 0)).toBe(0);
  });

  it('should handle 100% discount', () => {
    expect(calculateDiscount(100, 100)).toBe(100);
  });

  it('should throw error for negative price', () => {
    expect(() => calculateDiscount(-10, 10)).toThrow('Invalid input');
  });

  it('should throw error for invalid discount percent', () => {
    expect(() => calculateDiscount(100, -5)).toThrow('Invalid input');
    expect(() => calculateDiscount(100, 150)).toThrow('Invalid input');
  });
});
```

#### Testing Classes

**✓ Good:**
```javascript
// Class under test
class ShoppingCart {
  constructor() {
    this.items = [];
  }

  addItem(item) {
    this.items.push(item);
  }

  getTotal() {
    return this.items.reduce((sum, item) => sum + item.price, 0);
  }

  getItemCount() {
    return this.items.length;
  }
}

// Tests
describe('ShoppingCart', () => {
  let cart;

  beforeEach(() => {
    cart = new ShoppingCart();
  });

  describe('addItem', () => {
    it('should add item to cart', () => {
      cart.addItem({ id: 1, price: 10 });
      expect(cart.getItemCount()).toBe(1);
    });

    it('should allow multiple items', () => {
      cart.addItem({ id: 1, price: 10 });
      cart.addItem({ id: 2, price: 20 });
      expect(cart.getItemCount()).toBe(2);
    });
  });

  describe('getTotal', () => {
    it('should return 0 for empty cart', () => {
      expect(cart.getTotal()).toBe(0);
    });

    it('should calculate total of single item', () => {
      cart.addItem({ id: 1, price: 15 });
      expect(cart.getTotal()).toBe(15);
    });

    it('should calculate total of multiple items', () => {
      cart.addItem({ id: 1, price: 10 });
      cart.addItem({ id: 2, price: 20 });
      cart.addItem({ id: 3, price: 5 });
      expect(cart.getTotal()).toBe(35);
    });
  });
});
```

#### Testing Async Functions

**✓ Good:**
```javascript
// Async function under test
async function fetchUser(userId) {
  const response = await api.get(`/users/${userId}`);
  return response.data;
}

// Tests
describe('fetchUser', () => {
  it('should return user data on success', async () => {
    const mockUser = { id: 1, name: 'John' };
    api.get = jest.fn().mockResolvedValue({ data: mockUser });

    const user = await fetchUser(1);
    expect(user).toEqual(mockUser);
    expect(api.get).toHaveBeenCalledWith('/users/1');
  });

  it('should throw error on failure', async () => {
    api.get = jest.fn().mockRejectedValue(new Error('Network error'));

    await expect(fetchUser(1)).rejects.toThrow('Network error');
  });
});
```

#### Testing React Components

**✓ Good:**
```javascript
// Component under test
function LoginForm({ onSubmit }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({ email, password });
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        data-testid="email-input"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        data-testid="password-input"
      />
      <button type="submit" data-testid="submit-button">Login</button>
    </form>
  );
}

// Tests
describe('LoginForm', () => {
  it('should render email and password inputs', () => {
    render(<LoginForm onSubmit={() => {}} />);
    expect(screen.getByTestId('email-input')).toBeInTheDocument();
    expect(screen.getByTestId('password-input')).toBeInTheDocument();
  });

  it('should call onSubmit with email and password', () => {
    const mockSubmit = jest.fn();
    render(<LoginForm onSubmit={mockSubmit} />);

    fireEvent.change(screen.getByTestId('email-input'), {
      target: { value: 'user@example.com' }
    });
    fireEvent.change(screen.getByTestId('password-input'), {
      target: { value: 'password123' }
    });
    fireEvent.click(screen.getByTestId('submit-button'));

    expect(mockSubmit).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'password123'
    });
  });
});
```

## Integration Testing

Integration tests verify that multiple components work together correctly.

### Characteristics

- Moderate speed (seconds)
- Tests real interactions
- May use real or test database
- Tests interfaces between components

### Integration Test Patterns

**✓ Good:**
```javascript
// Testing service layer integration
describe('UserService Integration', () => {
  let userService;
  let database;

  beforeAll(async () => {
    database = await createTestDatabase();
    userService = new UserService(database);
  });

  afterAll(async () => {
    await database.close();
  });

  afterEach(async () => {
    await database.clear();
  });

  it('should create and retrieve user', async () => {
    const userData = { email: 'test@example.com', name: 'Test User' };

    const createdUser = await userService.createUser(userData);
    expect(createdUser.id).toBeDefined();
    expect(createdUser.email).toBe(userData.email);

    const retrievedUser = await userService.getUser(createdUser.id);
    expect(retrievedUser).toEqual(createdUser);
  });

  it('should throw error when getting non-existent user', async () => {
    await expect(userService.getUser(999)).rejects.toThrow('User not found');
  });

  it('should update user details', async () => {
    const user = await userService.createUser({
      email: 'test@example.com',
      name: 'Original Name'
    });

    const updated = await userService.updateUser(user.id, {
      name: 'Updated Name'
    });

    expect(updated.name).toBe('Updated Name');
    expect(updated.email).toBe('test@example.com');
  });
});
```

### API Integration Testing

**✓ Good:**
```javascript
// Testing API endpoints
describe('Auth API Integration', () => {
  let app;
  let server;

  beforeAll(async () => {
    app = createApp();
    server = app.listen(0);
  });

  afterAll(async () => {
    await server.close();
  });

  it('should login with valid credentials', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'password123' })
      .expect(200);

    expect(response.body).toHaveProperty('token');
    expect(response.body.user).toHaveProperty('email', 'user@example.com');
  });

  it('should reject invalid credentials', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'wrongpassword' })
      .expect(401);

    expect(response.body).toHaveProperty('error', 'Invalid credentials');
  });

  it('should require authentication for protected routes', async () => {
    await request(app)
      .get('/api/users/profile')
      .expect(401);
  });
});
```

## End-to-End Testing

E2E tests verify complete user workflows from UI to backend.

### Characteristics

- Slow (seconds to minutes)
- Test real user scenarios
- Use real browser
- Most expensive to maintain

### E2E Test Patterns

**✓ Good:**
```javascript
// Using Playwright or Cypress
describe('User Login Flow', () => {
  beforeEach(async () => {
    await page.goto('http://localhost:3000');
  });

  it('should allow user to login successfully', async () => {
    await page.click('[data-testid="login-link"]');
    await page.waitForSelector('[data-testid="login-form"]');

    await page.fill('[data-testid="email-input"]', 'user@example.com');
    await page.fill('[data-testid="password-input"]', 'password123');
    await page.click('[data-testid="submit-button"]');

    await page.waitForURL('**/dashboard');
    await expect(page.locator('[data-testid="user-name"]'))
      .toContainText('John Doe');
  });

  it('should show error for invalid credentials', async () => {
    await page.click('[data-testid="login-link"]');
    await page.fill('[data-testid="email-input"]', 'user@example.com');
    await page.fill('[data-testid="password-input"]', 'wrongpassword');
    await page.click('[data-testid="submit-button"]');

    await expect(page.locator('[data-testid="error-message"]'))
      .toContainText('Invalid credentials');
  });

  it('should allow user to logout', async () => {
    // Login first
    await loginUser(page, 'user@example.com', 'password123');

    // Then logout
    await page.click('[data-testid="user-menu"]');
    await page.click('[data-testid="logout-button"]');

    await page.waitForURL('**/');
    await expect(page.locator('[data-testid="login-link"]'))
      .toBeVisible();
  });
});
```

## Coverage Targets

### Minimum Coverage Requirements

- **Overall Coverage:** 80% minimum
- **Critical Paths:** 90%+ (auth, payments, data mutations)
- **Utility Functions:** 95%+ (should be easy to fully test)
- **New Code:** 90%+ (don't lower coverage with new changes)

### What to Cover

**High Priority (Must Test):**
- Business logic
- Data transformations
- Authentication and authorization
- Payment processing
- User input validation
- Error handling
- Edge cases and boundary conditions

**Medium Priority (Should Test):**
- UI components
- API endpoints
- Database queries
- State management
- Navigation flows

**Low Priority (Optional):**
- Trivial getters/setters
- Simple utility functions
- Third-party library wrappers
- Configuration files

### What NOT to Test

- Third-party library internals
- Generated code (migrations, build artifacts)
- Mock objects themselves
- Framework code
- Constants and configuration

## Mocking Strategies

### When to Mock

- External APIs
- Database connections
- File system operations
- Time-dependent functions
- Random number generation
- Third-party services

### Mock Examples

**Mocking Functions:**
```javascript
// Jest
const mockFunction = jest.fn();
mockFunction.mockReturnValue(42);
mockFunction.mockResolvedValue({ data: 'result' });

// Verify calls
expect(mockFunction).toHaveBeenCalledWith('arg1', 'arg2');
expect(mockFunction).toHaveBeenCalledTimes(1);
```

**Mocking Modules:**
```javascript
// Mock entire module
jest.mock('./api', () => ({
  get: jest.fn(),
  post: jest.fn()
}));

// Mock specific functions
jest.mock('./utils', () => ({
  ...jest.requireActual('./utils'),
  formatDate: jest.fn(() => '2024-01-01')
}));
```

**Mocking Classes:**
```javascript
jest.mock('./UserService');

const mockUserService = {
  getUser: jest.fn(),
  createUser: jest.fn()
};

UserService.mockImplementation(() => mockUserService);
```

**Mocking Time:**
```javascript
// Jest
jest.useFakeTimers();
jest.setSystemTime(new Date('2024-01-01'));

// Sinon
const clock = sinon.useFakeTimers(new Date('2024-01-01'));
clock.restore();
```

## Test Organization

### File Structure

```
src/
├── components/
│   ├── LoginForm.jsx
│   └── LoginForm.test.jsx       # Co-located tests
├── services/
│   ├── userService.js
│   └── userService.test.js
└── utils/
    ├── dateUtils.js
    └── dateUtils.test.js

tests/
├── integration/
│   ├── auth.test.js
│   └── user.test.js
└── e2e/
    ├── login.test.js
    └── checkout.test.js
```

### Naming Conventions

- Test files: `*.test.js` or `*.spec.js`
- Test suites: `describe('ComponentName', ...)`
- Test cases: `it('should do something', ...)`

### Test Structure (AAA Pattern)

```javascript
it('should calculate total correctly', () => {
  // Arrange - Set up test data
  const items = [
    { price: 10 },
    { price: 20 }
  ];

  // Act - Execute the code under test
  const total = calculateTotal(items);

  // Assert - Verify the result
  expect(total).toBe(30);
});
```

## Best Practices

### 1. Write Descriptive Test Names

**✓ Good:**
```javascript
it('should return 0 for empty cart', () => { ... });
it('should throw error when price is negative', () => { ... });
it('should redirect to dashboard after successful login', () => { ... });
```

**✗ Bad:**
```javascript
it('works', () => { ... });
it('test 1', () => { ... });
it('should calculate', () => { ... });
```

### 2. Test One Thing Per Test

**✓ Good:**
```javascript
it('should validate email format', () => {
  expect(validateEmail('user@example.com')).toBe(true);
});

it('should reject email without @', () => {
  expect(validateEmail('userexample.com')).toBe(false);
});
```

**✗ Bad:**
```javascript
it('should validate email', () => {
  expect(validateEmail('user@example.com')).toBe(true);
  expect(validateEmail('userexample.com')).toBe(false);
  expect(validateEmail('')).toBe(false);
  // Testing too many scenarios
});
```

### 3. Keep Tests Independent

Tests should not depend on each other or share state.

**✓ Good:**
```javascript
beforeEach(() => {
  database.clear();
});

it('should create user', async () => {
  const user = await createUser({ email: 'test@example.com' });
  expect(user).toBeDefined();
});

it('should find user by email', async () => {
  await createUser({ email: 'test@example.com' });
  const user = await findUser('test@example.com');
  expect(user).toBeDefined();
});
```

### 4. Test Edge Cases

Always test:
- Empty/null inputs
- Boundary values (min, max)
- Invalid inputs
- Error conditions

```javascript
describe('calculateAge', () => {
  it('should calculate age correctly', () => {
    expect(calculateAge(new Date('1990-01-01'))).toBe(34);
  });

  it('should handle null birthdate', () => {
    expect(() => calculateAge(null)).toThrow('Invalid birthdate');
  });

  it('should handle future birthdate', () => {
    const futureDate = new Date('2050-01-01');
    expect(() => calculateAge(futureDate)).toThrow('Future date');
  });

  it('should handle same day (age 0)', () => {
    expect(calculateAge(new Date())).toBe(0);
  });
});
```

### 5. Use Test Data Builders

**✓ Good:**
```javascript
function createTestUser(overrides = {}) {
  return {
    id: 1,
    email: 'test@example.com',
    name: 'Test User',
    age: 25,
    ...overrides
  };
}

it('should validate user age', () => {
  const user = createTestUser({ age: 17 });
  expect(validateAge(user)).toBe(false);
});
```

### 6. Clean Up After Tests

```javascript
afterEach(async () => {
  await database.clear();
  jest.clearAllMocks();
});

afterAll(async () => {
  await database.close();
  await server.close();
});
```

## Summary

**Key Principles:**
- Test behavior, not implementation
- Write tests alongside code (TDD when appropriate)
- Aim for 80%+ coverage
- Focus on critical paths
- Test edge cases and errors
- Keep tests fast and independent
- Use the testing pyramid as a guide
- Mock external dependencies
- Write descriptive test names
- Refactor tests like production code

**Remember:** Good tests give you confidence to refactor and change code without breaking functionality.
