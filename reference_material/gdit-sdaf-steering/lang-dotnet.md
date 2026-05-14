---
inclusion: always
enforcement: mandatory
---

# .NET / C# Language Standards

Reference examples: `~/.kiro/steering/lang-dotnet-reference.md`

## Context

This steering file defines .NET/C# development standards including version requirements, validation tooling, naming conventions, security patterns, and project structure. It is loaded by .NET-focused GDIT-SDAF agent variants.

## Version & Tooling

- **.NET**: 8.0 LTS (or 9.0 when LTS available)
- **C#**: 12 (matches .NET 8) or later
- **Build Tool**: `dotnet` CLI
- **Package Manager**: NuGet
- **Analyzer**: Roslyn analyzers (Microsoft.CodeAnalysis)

**project.yaml overrides** (optional — defaults above apply when absent):

- `language.dotnet.version` — override .NET version
- `language.dotnet.build-tool` — override build tool (default: dotnet)
- `language.dotnet.analyzer` — override analyzer (default: roslyn)

## Manual Validation Tools

Since hooks don't trigger in kiro-cli, you MUST manually run these for .NET code files (_.cs, _.csproj, \*.sln):

> **Note**: The tools below document defaults. Runtime scanner selection is driven by `security.scanner-file-mapping` in `project.yaml` when present.

```bash
# Build / compilation check
dotnet build --no-restore -warnaserror

# Code formatting validation
dotnet format --verify-no-changes

# SAST scanning
semgrep --config=auto --severity=ERROR --severity=WARNING --json <file>

# Secrets detection
gitleaks detect --source <file> --no-git --verbose

# Vulnerability scanning (dependencies)
trivy fs --scanners vuln --severity HIGH,CRITICAL <directory>
```

**Blocking Criteria:**

- BLOCK on: Secrets detected, ERROR-level SAST, HIGH/CRITICAL vulnerabilities, build errors, Roslyn analyzer errors
- ADVISORY on: WARNING-level findings, MEDIUM vulnerabilities, formatting violations (auto-fix with `dotnet format`), Roslyn analyzer warnings

## Naming Conventions

### Namespaces

- **Format**: PascalCase dot-separated
- **Pattern**: `Organization.Service.Module`
- **Examples**: `Acme.UserService.Controllers`, `Acme.OrderService.Models`

### Classes and Records

- **Format**: PascalCase with descriptive suffix
- **Controllers**: `UserController`, **Services**: `UserService`, **Repositories**: `UserRepository`
- **DTOs**: `UserDto`, `CreateUserRequest`, **Models**: `User`, `Order`
- **Exceptions**: `ResourceNotFoundException`, `ValidationException`
- **Interfaces**: `IUserService`, `IRepository<T>` (prefix with `I`)

### Methods

- **Format**: PascalCase
- **Examples**: `GetUserById`, `ProcessRemediation`, `ValidateInput`
- **Async methods**: Suffix with `Async` — `GetUserByIdAsync`, `SaveChangesAsync`

### Properties

- **Format**: PascalCase
- **Examples**: `UserId`, `CreatedAt`, `IsActive`

### Parameters and Local Variables

- **Format**: camelCase
- **Examples**: `userId`, `itemData`, `retryCount`

### Private Fields

- **Format**: `_camelCase` (underscore prefix)
- **Examples**: `_userService`, `_logger`, `_configuration`

### Constants

- **Format**: PascalCase (C# convention, not UPPER_SNAKE_CASE)
- **Examples**: `MaxRetryAttempts`, `DefaultTimeout`, `TableName`

### Configuration Keys

- **Format**: PascalCase sections in `appsettings.json`
- **Examples**: `ConnectionStrings:DefaultConnection`, `Aws:Region`, `Logging:LogLevel:Default`

## Project Structure

### Web API Layout

```
service-root/
├── ServiceName.sln
├── src/
│   └── ServiceName.Api/
│       ├── ServiceName.Api.csproj
│       ├── Program.cs
│       ├── Controllers/
│       ├── Services/
│       ├── Repositories/
│       ├── Models/
│       │   ├── Entities/
│       │   └── Dtos/
│       ├── Middleware/
│       ├── Extensions/
│       └── appsettings.json
├── tests/
│   ├── ServiceName.UnitTests/
│   │   └── ServiceName.UnitTests.csproj
│   └── ServiceName.IntegrationTests/
│       └── ServiceName.IntegrationTests.csproj
```

### Lambda Function Layout

```
src/lambdas/FunctionName/
├── FunctionName.csproj
├── Function.cs
├── Models/
└── aws-lambda-tools-defaults.json
```

### Build Files Allowed in Service Root

- `*.sln`, `*.csproj`, `global.json`, `Directory.Build.props`, `Directory.Packages.props`, `nuget.config`

## Security Patterns (Summary)

- **Input validation**: Use Data Annotations (`[Required]`, `[StringLength]`, `[RegularExpression]`, `[Range]`) on request DTOs with `[ApiController]` auto-validation, or FluentValidation for complex rules
- **Exception handling**: Use middleware (`UseExceptionHandler`) or `IExceptionHandler` (NET 8+); never expose stack traces; return `ProblemDetails` responses
- **CORS**: Configure via `builder.Services.AddCors()` with explicit origin allowlist, not wildcards
- **Secrets**: Use AWS Secrets Manager via `AWSSDK.SecretsManager`, reference via environment variables or `IConfiguration`; never hardcode
- **Database queries**: Use Entity Framework Core (auto-parameterized) or Dapper with parameterized queries (`@param`)
- **Response headers**: Add security headers via middleware (`X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`)
- **Anti-patterns**: No `dynamic` or `object` request bodies without validation, no string-concatenated SQL, no hardcoded credentials, no leaked stack traces

## Deployment Patterns (Summary)

- **ECS/Fargate**: Published app with `mcr.microsoft.com/dotnet/aspnet` base image
- **Lambda**: `Amazon.Lambda.AspNetCoreServer.Hosting` for minimal API or `Amazon.Lambda.RuntimeSupport` for standalone handlers

## Testing Conventions

Testing conventions are applied when `workflow.testing` is `test-after` or `test-driven` in `project.yaml`.

### xUnit (default for .NET)

- Test project: `tests/ServiceName.UnitTests/` with separate `*.csproj`
- Test file naming: `{Module}Tests.cs`
- One test class per spec feature, one `[Fact]` or `[Theory]` method per acceptance criterion
- Setup via constructor injection and `IClassFixture<T>`
- Use `Assert.Equal`, `Assert.True`, or FluentAssertions (`actual.Should().Be(expected)`)
- Run command: `dotnet test`

### NUnit

- Test project: `tests/ServiceName.Tests/`
- Test file naming: `{Module}Tests.cs`
- One `[TestFixture]` class per spec feature, one `[Test]` method per acceptance criterion
- Setup/teardown via `[SetUp]`/`[TearDown]`
- Run command: `dotnet test`

### MSTest

- Test project: `tests/ServiceName.Tests/`
- Test file naming: `{Module}Tests.cs`
- One `[TestClass]` per spec feature, one `[TestMethod]` per acceptance criterion
- Setup/teardown via `[TestInitialize]`/`[TestCleanup]`
- Run command: `dotnet test`

### Test-to-Spec Mapping

```
requirements.md acceptance criterion  →  one [Fact] or [Test] method
design.md correctness property        →  one [Fact] or [Test] method
.kiro/specs/user-greeting/            →  tests/ServiceName.UnitTests/UserGreetingTests.cs
```

### Test Traits (when layers configured)

Tag every test with its layer using framework-specific traits:

#### xUnit

```csharp
[Fact]
[Trait("Category", "Unit")]
public void Greet_WithName_ReturnsGreeting()
{
    Assert.Equal("Hello, Alice!", Greeter.Greet("Alice"));
}

[Fact]
[Trait("Category", "Integration")]
public void Greet_WritesToLog() { ... }

[Fact]
[Trait("Category", "E2E")]
public void GreetingPage_ShowsGreeting() { ... }

[Fact]
[Trait("Category", "Pipeline")]
public void Api_Returns200() { ... }
```

#### NUnit

```csharp
[Test]
[Category("Unit")]
public void Greet_WithName_ReturnsGreeting() { ... }
```

#### MSTest

```csharp
[TestMethod]
[TestCategory("Unit")]
public void Greet_WithName_ReturnsGreeting() { ... }
```

### Selective Execution

```bash
dotnet test                                              # all tests
dotnet test --filter "Category=Unit"                     # by trait/category
dotnet test --filter "Category=Unit|Category=Integration" # multiple
dotnet test --filter "FullyQualifiedName~UserGreeting"   # by class name
dotnet test --filter "DisplayName~Greet_WithName"        # single test
dotnet test --filter "Category=Pipeline"                 # pipeline tests only
```

### Runner Config

Test projects reference the test SDK and framework package in their `.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.9.0" />
    <PackageReference Include="xunit" Version="2.7.0" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.5.7" />
  </ItemGroup>
</Project>
```
