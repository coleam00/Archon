---
inclusion: always
enforcement: mandatory
---

# Java / Spring Boot Language Standards

Reference examples: `~/.kiro/steering/lang-java-springboot-reference.md`

## Context

This steering file defines Java and Spring Boot development standards including version requirements, validation tooling, naming conventions, security patterns, and project structure. It is loaded by Java-focused GDIT-SDAF agent variants.

## Version & Tooling

- **Java**: 17 or 21 (LTS releases only)
- **Spring Boot**: 3.x (requires Java 17+)
- **Build Tool**: Maven (preferred) or Gradle
- **Dependency Management**: Spring Boot Starter BOMs, no manual version pinning for managed dependencies

**project.yaml overrides** (optional — defaults above apply when absent):

- `language.java.version` — override Java version
- `language.java.build-tool` — override build tool preference (maven | gradle)
- `language.java.base-package` — override base package pattern

## Manual Validation Tools

Since hooks don't trigger in kiro-cli, you MUST manually run these for Java code files (_.java) and build files (pom.xml, _.gradle):

> **Note**: The tools below document defaults. Runtime scanner selection is driven by `security.scanner-file-mapping` in `project.yaml` when present. See `project-yaml-expansion` spec for the central mapping schema.

```bash
# Compilation check
mvn compile -q

# Static analysis
mvn spotbugs:check -q
mvn pmd:check -q

# Secrets detection
gitleaks detect --source <file> --no-git --verbose

# Dependency vulnerability scanning
mvn org.owasp:dependency-check-maven:check -q

# Code formatting validation
mvn spotless:check -q
```

**Blocking Criteria:**

- BLOCK on: Secrets detected, SpotBugs HIGH/ERROR findings, CRITICAL/HIGH CVEs in dependencies, compilation errors
- ADVISORY on: SpotBugs LOW/MEDIUM, PMD warnings, MEDIUM CVEs

## Naming Conventions

### Packages

- **Format**: lowercase dot-separated, reverse domain
- **Pattern**: `com.organization.service.module`

### Classes

- **Format**: PascalCase with descriptive suffix
- **Controllers**: `UserController`, **Services**: `UserService`, **Repositories**: `UserRepository`
- **DTOs/Models**: `UserDto`, `FindingResponse`, **Config**: `SecurityConfig`, `AwsConfig`
- **Exceptions**: `ResourceNotFoundException`, `ValidationException`

### Methods

- **Format**: camelCase with verb prefix
- **Examples**: `getUserById`, `processRemediation`, `validateInput`

### Variables

- **Format**: camelCase
- **Examples**: `userId`, `findingCount`, `remediationStatus`

### Constants

- **Format**: UPPER_SNAKE_CASE
- **Examples**: `MAX_RETRY_ATTEMPTS`, `DEFAULT_PAGE_SIZE`, `API_BASE_PATH`

### Configuration Properties

- **Format**: kebab-case in `application.yml`
- **Examples**: `spring.datasource.url`, `app.security.jwt-secret`, `aws.region`

## Project Structure

### Maven Standard Layout

- `src/main/java/com/organization/service/` — Application.java, config/, controller/, service/, repository/, model/, exception/
- `src/main/resources/` — application.yml, application-dev.yml, application-prod.yml
- `src/test/java/` — mirrors main structure

### Build Files Allowed in Service Root

- `pom.xml` or `build.gradle`, `mvnw`, `gradlew`, `.mvn/`, `.gradle/`

## Security Patterns (Summary)

- **Input validation**: Use Bean Validation annotations (@NotBlank, @Size, @Pattern, @Email, @Min, @Max) on request DTOs with @Valid on controller parameters
- **Exception handling**: Use @RestControllerAdvice with GlobalExceptionHandler; never expose stack traces; return generic error messages
- **CORS**: Configure via Spring Security with explicit origin allowlist, not wildcards
- **Secrets**: Use AWS Secrets Manager via Spring config; reference via environment variables; never hardcode
- **Database queries**: Use Spring Data JPA (auto-parameterized) or @Query with named @Param parameters
- **Response headers**: Add X-Content-Type-Options, X-Frame-Options, Content-Security-Policy via Filter
- **Anti-patterns**: No Map<String,Object> request bodies, no string-concatenated queries, no hardcoded credentials, no leaked stack traces

## Deployment Patterns (Summary)

- **ECS/EKS**: Fat JAR with eclipse-temurin base image
- **Lambda**: Spring Cloud Function adapter with SnapStart for cold start optimization

## Testing Conventions

Testing conventions are applied when `workflow.testing` is `test-after` or `test-driven` in `project.yaml`.

### JUnit 5 (default for Java)

- Test directory: `src/test/java/` (Maven standard layout)
- Test file naming: `{Module}Test.java` in package mirroring source
- One test class per spec feature, one `@Test` method per acceptance criterion
- Setup/teardown via `@BeforeEach`/`@AfterEach`
- Use `assertThat` (AssertJ) or `assertEquals` (JUnit assertions)
- Spring Boot integration tests: `@SpringBootTest` with `@AutoConfigureMockMvc`
- Run command: `mvn test -q`

### Test-to-Spec Mapping

```
requirements.md acceptance criterion  →  one @Test method
design.md correctness property        →  one @Test method
.kiro/specs/user-greeting/            →  src/test/java/.../UserGreetingTest.java
```

### Test Tags (when layers configured)

Tag every test with its layer using JUnit 5 `@Tag`:

```java
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

@Tag("unit")
@Test
void testGreetWithName() {
    assertEquals("Hello, Alice!", greet("Alice"));
}

@Tag("integration")
@Test
void testGreetWritesToLog() { ... }

@Tag("e2e")
@Test
void testGreetingPage() { ... }
```

### Selective Execution

```bash
mvn test                                  # all tests
mvn test -Dgroups="unit"                  # by tag
mvn test -Dgroups="unit,integration"      # multiple tags
mvn test -Dtest="UserGreetingTest"        # by class
mvn test -Dtest="UserGreetingTest#testGreetWithName"  # single method
```

### Runner Config (generated on first test if missing)

Maven surefire plugin configuration in `pom.xml`:

```xml
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-surefire-plugin</artifactId>
    <configuration>
        <groups>${test.groups}</groups>
    </configuration>
</plugin>
```
