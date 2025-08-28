# Archon UI Testing Guide

This guide explains how to run tests for the Archon UI frontend using Docker containers.

## Quick Start

```bash
# Run all tests with coverage (Docker)
make test

# Run tests locally (requires npm install)
make test-local

# Run tests in watch mode
make test-watch

# Run test UI on http://localhost:51204
make test-ui
```

## Prerequisites

- Docker installed and running
- Make command available
- (Optional) Node.js 20+ for local testing

## Testing with Docker

The project includes a `Dockerfile.test` that creates a containerized test environment with all dependencies pre-installed. This ensures consistent test execution across different machines.

### Available Make Commands

| Command | Description |
|---------|-------------|
| `make test` | Run tests with coverage in Docker |
| `make test-watch` | Run tests in watch mode (Docker) |
| `make test-ui` | Run test UI on port 51204 (Docker) |
| `make test-quick` | Run tests without coverage (Docker) |
| `make test-ci` | Run tests in CI mode |
| `make lint-docker` | Run linting in Docker |
| `make shell` | Open shell in test container |
| `make build-test` | Build the test Docker image |
| `make clean-docker` | Remove test containers and images |

### Local Testing Commands

| Command | Description |
|---------|-------------|
| `make test-local` | Run tests locally |
| `make test-local-watch` | Run tests in watch mode locally |
| `make test-local-ui` | Run test UI locally |
| `make lint` | Run linting locally |
| `make install` | Install dependencies locally |

### Utility Commands

| Command | Description |
|---------|-------------|
| `make test-results` | Show test results summary |
| `make coverage-report` | Open coverage report in browser |
| `make verify` | Run linting and tests (Docker) |
| `make ci` | Full CI pipeline |
| `make clean-all` | Clean everything |

## Docker Test Container

The `Dockerfile.test` creates a container with:
- Node.js 20 Alpine Linux
- All npm dependencies installed
- Test runner configured
- Coverage reporting enabled

### Building the Container

```bash
# Build test container
make build-test

# Or manually
docker build -f Dockerfile.test -t archon-ui-test:latest .
```

### Running Tests Manually

```bash
# Run tests with coverage
docker run --rm archon-ui-test:latest

# Run tests in watch mode
docker run --rm -it \
  -v "$(pwd)/src:/app/src:ro" \
  -v "$(pwd)/test:/app/test:ro" \
  archon-ui-test:latest npm run test

# Run test UI
docker run --rm -it \
  -p 51204:51204 \
  archon-ui-test:latest \
  npm run test:ui -- --host 0.0.0.0 --port 51204
```

## Test Files

Tests are located in the `test/` directory:
- `components.test.tsx` - Component unit tests
- `pages.test.tsx` - Page component tests
- `user_flows.test.tsx` - User interaction tests
- `errors.test.tsx` - Error handling tests
- `services/projectService.test.ts` - Service tests
- `components/project-tasks/DocsTab.integration.test.tsx` - Integration tests
- `config/api.test.ts` - Configuration tests

## Test Framework

The project uses:
- **Vitest** - Test runner and assertion library
- **React Testing Library** - Component testing
- **jsdom** - DOM simulation
- **@vitest/coverage-v8** - Coverage reporting

## Coverage Reports

Coverage reports are generated in multiple formats:
- Terminal output (text-summary)
- HTML report in `public/test-results/coverage/`
- JSON report for CI integration

View coverage report:
```bash
make coverage-report
```

## CI/CD Integration

For CI/CD pipelines, use:

```bash
# Run complete CI pipeline
make ci

# Or manually
make clean
make build-test
make test-ci
make test-results
```

## Helper Scripts

### run-tests.sh

A bash script is also available for running tests:

```bash
./run-tests.sh        # Run tests with coverage
./run-tests.sh build  # Build container
./run-tests.sh ui     # Run test UI
./run-tests.sh watch  # Run in watch mode
./run-tests.sh clean  # Clean up
```

### Docker Compose

For more complex scenarios, use docker-compose:

```bash
# Run tests
docker-compose -f docker-compose.test.yml up test-runner

# Run test UI
docker-compose -f docker-compose.test.yml --profile ui up test-ui

# Stop services
docker-compose -f docker-compose.test.yml down
```

## Troubleshooting

### Test Results

**All 77 tests pass in the Docker environment!** ✅

The test suite includes proper handling for Docker-specific environment constraints:
- Environment variable tests skip when running in Docker (where they can't be deleted)
- All functionality tests pass successfully
- Coverage reports are generated as expected

### Container Not Found

If you get "image not found" errors:
```bash
make build-test
```

### Permission Issues

If you encounter permission issues with volumes:
- Ensure Docker has access to the project directory
- Check Docker Desktop settings for file sharing

### Port Already in Use

If port 51204 is already in use for test UI:
```bash
# Find process using port
lsof -i :51204

# Or use a different port
docker run --rm -it -p 5555:51204 archon-ui-test:latest \
  npm run test:ui -- --host 0.0.0.0 --port 51204
```

## Performance

- Initial build: ~30 seconds
- Test execution: ~2 seconds
- Container size: ~713MB
- Coverage generation: ~3 seconds

## Best Practices

1. **Use Docker for CI/CD** - Ensures consistent environment
2. **Run tests before commits** - Use `make verify`
3. **Keep tests fast** - Use `make test-quick` during development
4. **Watch mode for TDD** - Use `make test-watch` while coding
5. **Review coverage** - Aim for >80% coverage

## Development Workflow

```bash
# 1. Start development
make dev

# 2. Write code and tests
make test-watch

# 3. Verify changes
make verify

# 4. Check coverage
make coverage-report

# 5. Clean up
make clean-all
```