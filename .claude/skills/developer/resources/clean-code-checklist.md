# Clean Code Checklist

A reference guide for writing clean, maintainable code. Use this checklist during development and code review.

## Naming Conventions

### Variables

**✓ Good:**
```javascript
const userEmail = 'user@example.com';
const totalPrice = calculateTotal(items);
const isAuthenticated = checkAuth();
const MAX_RETRY_ATTEMPTS = 3;
```

**✗ Bad:**
```javascript
const e = 'user@example.com';
const tp = calculateTotal(items);
const auth = checkAuth();
const max = 3;
```

**Rules:**
- Use descriptive, meaningful names
- Use camelCase for variables in JavaScript/TypeScript
- Use snake_case for variables in Python/Ruby
- Use PascalCase for classes and components
- Use UPPER_CASE for constants
- No single-letter variables except loop counters (i, j, k)
- Boolean variables should start with is, has, can, should
- Avoid abbreviations unless widely understood

### Functions

**✓ Good:**
```javascript
function calculateOrderTotal(items, taxRate) { ... }
function validateEmailFormat(email) { ... }
function getUserById(userId) { ... }
function formatCurrency(amount) { ... }
```

**✗ Bad:**
```javascript
function calc(i, t) { ... }
function validate(e) { ... }
function get(id) { ... }
function format(a) { ... }
```

**Rules:**
- Use verb phrases (calculate, validate, format, get, create, update, delete)
- Function names should describe what they do
- Use camelCase in JavaScript/TypeScript
- Use snake_case in Python/Ruby
- Be specific: getUserById not getUser

### Classes and Components

**✓ Good:**
```javascript
class UserAuthenticationService { ... }
class OrderProcessor { ... }
const LoginForm = () => { ... }
const ProductCard = () => { ... }
```

**✗ Bad:**
```javascript
class UAS { ... }
class Processor { ... }
const Form1 = () => { ... }
const Card = () => { ... }
```

**Rules:**
- Use PascalCase
- Use nouns or noun phrases
- Be descriptive and specific
- Avoid abbreviations

## Function Design

### Single Responsibility Principle

Each function should do one thing and do it well.

**✓ Good:**
```javascript
function validateEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

function validatePassword(password) {
  return password.length >= 8;
}

function createUser(email, password) {
  if (!validateEmail(email)) throw new Error('Invalid email');
  if (!validatePassword(password)) throw new Error('Invalid password');
  return database.users.insert({ email, password });
}
```

**✗ Bad:**
```javascript
function createUser(email, password) {
  // Doing too many things: validation, hashing, database insert
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) throw new Error('Invalid email');
  if (password.length < 8) throw new Error('Invalid password');
  const hashedPassword = bcrypt.hashSync(password, 10);
  return database.users.insert({ email, password: hashedPassword });
}
```

### Function Size

Keep functions small - under 50 lines is ideal, under 20 is better.

**✓ Good:**
```javascript
function processOrder(order) {
  validateOrder(order);
  const total = calculateTotal(order);
  const payment = processPayment(order, total);
  return createOrderRecord(order, payment);
}
```

**✗ Bad:**
```javascript
function processOrder(order) {
  // 150 lines of validation, calculation, payment, and database operations
  // ...
}
```

### Parameter Count

Limit to 3-4 parameters. Use objects for more.

**✓ Good:**
```javascript
function createUser({ email, name, age, address, phone }) { ... }

function calculatePrice(basePrice, options) { ... }
```

**✗ Bad:**
```javascript
function createUser(email, name, age, street, city, state, zip, phone) { ... }

function calculatePrice(base, tax, discount, shipping, handling, fees) { ... }
```

### Return Early

Reduce nesting by returning early.

**✓ Good:**
```javascript
function processPayment(order) {
  if (!order) return null;
  if (!order.items.length) return null;
  if (order.total <= 0) return null;

  return chargeCard(order);
}
```

**✗ Bad:**
```javascript
function processPayment(order) {
  if (order) {
    if (order.items.length > 0) {
      if (order.total > 0) {
        return chargeCard(order);
      }
    }
  }
  return null;
}
```

## DRY Principle (Don't Repeat Yourself)

Extract repeated code into functions.

**✓ Good:**
```javascript
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(amount);
}

const subtotal = formatCurrency(49.99);
const tax = formatCurrency(4.50);
const total = formatCurrency(54.49);
```

**✗ Bad:**
```javascript
const subtotal = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
}).format(49.99);

const tax = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
}).format(4.50);

const total = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
}).format(54.49);
```

## Error Handling

### Explicit Error Handling

Never swallow errors silently.

**✓ Good:**
```javascript
async function fetchUser(userId) {
  try {
    const response = await api.get(`/users/${userId}`);
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      throw new UserNotFoundError(userId);
    }
    logger.error('Failed to fetch user', { userId, error });
    throw new APIError('Failed to fetch user', error);
  }
}
```

**✗ Bad:**
```javascript
async function fetchUser(userId) {
  try {
    const response = await api.get(`/users/${userId}`);
    return response.data;
  } catch (error) {
    return null; // Silent failure - bad!
  }
}
```

### Input Validation

Validate inputs early and explicitly.

**✓ Good:**
```javascript
function calculateDiscount(price, percent) {
  if (typeof price !== 'number' || price < 0) {
    throw new Error('Price must be a non-negative number');
  }
  if (typeof percent !== 'number' || percent < 0 || percent > 100) {
    throw new Error('Percent must be between 0 and 100');
  }
  return price * (percent / 100);
}
```

**✗ Bad:**
```javascript
function calculateDiscount(price, percent) {
  return price * (percent / 100); // No validation!
}
```

## Comments

### Comment the "Why" Not the "What"

**✓ Good:**
```javascript
// Using exponential backoff to prevent API overwhelm during outages
const delay = Math.pow(2, attempt) * 1000;

// Legacy accounts (pre-2023) are grandfathered into old pricing
if (account.createdAt < new Date('2023-01-01')) {
  return LEGACY_PRICING;
}
```

**✗ Bad:**
```javascript
// Calculate delay
const delay = Math.pow(2, attempt) * 1000;

// Check if date is before 2023
if (account.createdAt < new Date('2023-01-01')) {
  return LEGACY_PRICING;
}
```

### Avoid Obvious Comments

**✓ Good:**
```javascript
// Complicated logic that needs explanation
const result = complexCalculation();
```

**✗ Bad:**
```javascript
// Increment i
i++;

// Set name to John
const name = 'John';
```

### Remove Dead Code and Commented Code

**✓ Good:**
```javascript
function processOrder(order) {
  validateOrder(order);
  return createOrder(order);
}
```

**✗ Bad:**
```javascript
function processOrder(order) {
  validateOrder(order);
  // const oldMethod = processOldWay(order);
  // return oldMethod;
  return createOrder(order);
}
```

## Code Organization

### File Structure

Organize files logically:

```
src/
├── components/          # UI components
│   ├── common/         # Shared components
│   │   ├── Button.jsx
│   │   └── Input.jsx
│   └── features/       # Feature-specific
│       └── auth/
│           └── LoginForm.jsx
├── services/           # Business logic
│   ├── authService.js
│   └── userService.js
├── utils/             # Helper functions
│   ├── dateUtils.js
│   └── stringUtils.js
├── hooks/             # Custom hooks
│   └── useAuth.js
└── constants/         # Constants
    └── apiEndpoints.js
```

### File Size

Keep files under 300 lines. Split large files into smaller modules.

### Module Exports

**✓ Good:**
```javascript
// dateUtils.js
export function formatDate(date) { ... }
export function parseDate(str) { ... }
export const DATE_FORMAT = 'YYYY-MM-DD';
```

**✗ Bad:**
```javascript
// dateUtils.js
export default {
  formatDate: (date) => { ... },
  parseDate: (str) => { ... },
  DATE_FORMAT: 'YYYY-MM-DD'
};
```

## Git Commit Practices

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
- `test`: Test changes
- `docs`: Documentation
- `chore`: Maintenance

**Examples:**
```
feat(auth): add password reset functionality

fix(api): handle null response from user service

refactor(utils): extract date formatting logic

test(auth): add edge case tests for login

docs(readme): update installation instructions
```

### Commit Size

- Commit after each logical unit of work
- Keep commits small and focused
- One concern per commit
- Commit frequently (at least daily)

**✓ Good:**
```
feat(auth): add User model
feat(auth): add login endpoint
feat(auth): add session management
test(auth): add unit tests for auth service
```

**✗ Bad:**
```
feat(auth): complete entire authentication system
# (One massive commit with 50+ file changes)
```

## Quick Reference Checklist

When writing code, ask yourself:

- [ ] Are my variable and function names descriptive?
- [ ] Are my functions small (under 50 lines)?
- [ ] Does each function have a single responsibility?
- [ ] Have I eliminated code duplication?
- [ ] Are errors handled explicitly?
- [ ] Do comments explain "why" not "what"?
- [ ] Have I removed dead code and commented code?
- [ ] Is input validation in place?
- [ ] Are edge cases handled?
- [ ] Would another developer understand this code?
- [ ] Can this be simplified?
- [ ] Have I followed project conventions?
- [ ] Are my commits small and focused?
- [ ] Are my commit messages clear?

## Summary

**The Golden Rule:** Write code that your future self (or another developer) will thank you for.

Clean code is:
- **Readable** - Easy to understand
- **Maintainable** - Easy to modify
- **Testable** - Easy to test
- **Scalable** - Easy to extend
- **Reliable** - Handles errors gracefully

Remember: Code is read far more often than it is written. Optimize for readability.
