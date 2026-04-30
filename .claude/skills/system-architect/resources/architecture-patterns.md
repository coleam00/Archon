# Architecture Patterns Reference

This document provides a comprehensive reference for architectural patterns, organized by category with detailed guidance on when to use each pattern.

## Table of Contents

1. [Application Architecture Patterns](#application-architecture-patterns)
2. [Data Architecture Patterns](#data-architecture-patterns)
3. [Integration Patterns](#integration-patterns)
4. [Pattern Selection Guide](#pattern-selection-guide)
5. [Anti-Patterns to Avoid](#anti-patterns-to-avoid)

---

## Application Architecture Patterns

### 1. Monolith

**Overview:**
A monolithic architecture is a single-tiered software application where all components are combined into a single deployable unit.

**Key Characteristics:**
- Single codebase
- Single deployment artifact (WAR, JAR, executable)
- Shared database
- In-process communication between components
- Single technology stack

**When to Use:**
- **Project Level:** 0-1 (proof of concept, simple applications)
- **Team Size:** 1-3 developers
- **Complexity:** Low to medium
- **Time to Market:** Need rapid MVP or prototype
- **Requirements:** Simple, well-understood, stable requirements

**Pros:**
- **Simple Development:** Easy to develop with familiar tools
- **Easy Testing:** End-to-end testing straightforward
- **Simple Deployment:** Single artifact to deploy
- **No Network Latency:** In-process calls are fast
- **Strong Consistency:** Easier to maintain ACID properties
- **Debugging:** Simpler to debug in single process

**Cons:**
- **Scaling:** Must scale entire application, not individual components
- **Complexity Over Time:** Can become large and hard to understand
- **Tight Coupling Risk:** Without discipline, components become tightly coupled
- **Technology Lock-in:** Difficult to use different technologies for different parts
- **Deployment Risk:** Small change requires redeploying everything
- **Team Coordination:** Multiple developers working on same codebase can create conflicts

**Best Practices:**
- Organize code into clear modules
- Define module boundaries and interfaces
- Use dependency injection
- Keep business logic separate from infrastructure
- Write comprehensive tests
- Use CI/CD for rapid deployment
- Consider modular monolith as project grows

**Example Use Cases:**
- Internal business tools
- Simple CRUD applications
- Company websites and blogs
- MVPs and proof of concepts
- Small SaaS applications (early stage)

**Technology Examples:**
- Ruby on Rails application
- Django application
- Spring Boot single JAR
- ASP.NET Core single deployment

---

### 2. Modular Monolith

**Overview:**
A monolithic application organized into well-defined modules with clear boundaries and responsibilities, while still deploying as a single unit.

**Key Characteristics:**
- Logical separation into modules
- Clear module boundaries and interfaces
- Single deployment (but organized internally)
- Modules communicate through defined interfaces
- Can use separate database schemas per module
- Easier path to microservices if needed

**When to Use:**
- **Project Level:** 2 (medium complexity applications)
- **Team Size:** 4-8 developers
- **Complexity:** Medium, with distinct domain areas
- **Growth Potential:** Likely to grow and need better organization
- **Team Structure:** Multiple developers/teams working on different areas

**Pros:**
- **Balance:** Simplicity of monolith with organization of services
- **Team Productivity:** Teams can work on different modules independently
- **Clear Boundaries:** Enforced module separation prevents coupling
- **Evolution Path:** Can extract modules to microservices later
- **Simple Deployment:** Still single deployment unit
- **Performance:** No network calls between modules
- **Testability:** Can test modules in isolation

**Cons:**
- **Discipline Required:** Need to maintain module boundaries
- **Shared Database:** Still potential for coupling through database
- **Scaling:** All modules scale together
- **Deployment:** Changes to any module require full redeployment
- **Technology Constraints:** All modules use same tech stack

**Best Practices:**
- Define clear module responsibilities (Single Responsibility Principle)
- Use dependency inversion (depend on interfaces, not implementations)
- Prevent circular dependencies between modules
- Each module owns its data (encapsulation)
- Use API/interface layer between modules
- Document module boundaries and contracts
- Use architecture tests to enforce boundaries
- Consider hexagonal/clean architecture principles

**Module Organization:**
```
/src
  /modules
    /user-management
      /api          (public interfaces)
      /domain       (business logic)
      /data         (data access)
    /product-catalog
      /api
      /domain
      /data
    /order-processing
      /api
      /domain
      /data
  /shared
    /common         (shared utilities)
    /infrastructure (shared infrastructure)
```

**Example Use Cases:**
- E-commerce platforms
- Multi-tenant SaaS applications
- Enterprise applications with distinct domains
- Content management systems
- Customer relationship management (CRM) systems

**Technology Examples:**
- Spring Boot with modules
- ASP.NET Core with projects
- Node.js with npm workspaces
- Python with package structure

**Evolution to Microservices:**
Well-designed modules can become microservices:
1. Start with modular monolith
2. Identify module that needs independent scaling
3. Extract module with its database
4. Implement API between extracted service and monolith
5. Repeat as needed

---

### 3. Microservices

**Overview:**
An architectural style where the application is composed of small, independent services that communicate over network protocols.

**Key Characteristics:**
- Multiple independent services
- Each service has its own database
- Services communicate via APIs (REST, gRPC, messaging)
- Independent deployment and scaling
- Can use different technologies per service
- Team ownership per service

**When to Use:**
- **Project Level:** 3-4 (complex, large-scale applications)
- **Team Size:** 10+ developers, multiple teams
- **Complexity:** High, complex business domain
- **Scalability Needs:** Different services have different scaling requirements
- **Team Independence:** Need teams to work and deploy independently
- **DevOps Maturity:** Have strong DevOps practices and tooling

**Pros:**
- **Independent Scaling:** Scale services based on their specific needs
- **Technology Diversity:** Use best technology for each service
- **Team Autonomy:** Teams can develop, deploy, test independently
- **Fault Isolation:** Failure in one service doesn't crash entire system
- **Easier Understanding:** Each service is smaller and easier to understand
- **Parallel Development:** Teams can work in parallel without conflicts
- **Selective Deployment:** Deploy changes to specific services

**Cons:**
- **Operational Complexity:** More moving parts to manage
- **Network Latency:** Inter-service calls add latency
- **Distributed Data:** Harder to maintain consistency across services
- **Testing Complexity:** End-to-end testing is challenging
- **DevOps Required:** Need strong CI/CD, monitoring, logging
- **Debugging:** Harder to trace requests across services
- **Data Duplication:** May need to duplicate data across services

**Best Practices:**
- **Service Boundaries:** Align with business capabilities or domains
- **API Design:** Well-defined, versioned APIs
- **Database per Service:** Each service owns its data
- **Decentralized Governance:** Teams make their own technology decisions
- **Infrastructure Automation:** Automated deployment, scaling, recovery
- **Design for Failure:** Circuit breakers, retries, fallbacks
- **Monitoring:** Comprehensive logging, metrics, tracing
- **API Gateway:** Single entry point for external clients
- **Service Mesh:** For service-to-service communication (optional)

**Service Communication Patterns:**
- **Synchronous:** REST, gRPC (request-response)
- **Asynchronous:** Message queues, event streaming
- **Hybrid:** Synchronous for queries, asynchronous for commands

**Data Management:**
- **Database per Service:** Each service has its own database
- **Event Sourcing:** Services publish events when data changes
- **CQRS:** Separate read and write models
- **Saga Pattern:** Distributed transactions across services

**Example Use Cases:**
- Large-scale SaaS platforms (Netflix, Uber, Amazon)
- High-traffic applications with varying scaling needs
- Complex business domains (e-commerce, financial services)
- Organizations with multiple teams
- Global distributed systems

**Technology Examples:**
- Spring Boot services with Eureka/Consul
- Node.js services with Docker/Kubernetes
- Go microservices
- AWS Lambda functions (serverless microservices)

---

### 4. Serverless / Function-as-a-Service (FaaS)

**Overview:**
Event-driven architecture where code runs in stateless functions managed by cloud provider, with automatic scaling and pay-per-execution pricing.

**Key Characteristics:**
- Functions triggered by events
- No server management required
- Automatic scaling (0 to thousands)
- Pay only for execution time
- Stateless functions
- Managed by cloud provider

**When to Use:**
- **Workload Type:** Event-driven, bursty, irregular traffic
- **Use Cases:** API backends, background jobs, webhooks, data processing
- **Cost Optimization:** Variable or unpredictable load
- **Time to Market:** Rapid development and deployment
- **Operations:** Minimal operations team or expertise

**Pros:**
- **Zero Server Management:** No infrastructure to manage
- **Automatic Scaling:** Scales from 0 to thousands automatically
- **Cost Efficient:** Pay only for execution time
- **Fast Deployment:** Deploy functions quickly
- **Built-in Availability:** High availability by default
- **Event Integration:** Native integration with cloud events

**Cons:**
- **Cold Start Latency:** Initial invocation may be slow
- **Execution Time Limits:** Maximum execution time (e.g., 15 minutes AWS Lambda)
- **Vendor Lock-in:** Tied to cloud provider's function service
- **Debugging Challenges:** Harder to debug distributed functions
- **Local Development:** Local testing can be complex
- **Stateless Constraint:** Must use external storage for state

**Best Practices:**
- **Keep Functions Small:** Single responsibility, focused purpose
- **Minimize Cold Starts:** Keep deployment packages small, use provisioned concurrency
- **Use Environment Variables:** For configuration
- **Implement Proper Error Handling:** Retries, dead letter queues
- **Monitor and Log:** Use cloud provider's monitoring tools
- **Security:** Least privilege IAM roles, secure secrets
- **Optimize Dependencies:** Include only necessary libraries

**Common Patterns:**
- **API Backend:** API Gateway + Lambda functions
- **Event Processing:** S3 upload triggers Lambda for processing
- **Scheduled Tasks:** CloudWatch Events + Lambda for cron jobs
- **Stream Processing:** Kinesis/DynamoDB Streams + Lambda
- **Webhooks:** External service calls API Gateway + Lambda

**Example Use Cases:**
- REST API backends
- Image/video processing
- File conversion
- Data transformation and ETL
- Scheduled tasks and cron jobs
- Webhook handlers
- IoT data processing
- Chatbots and voice assistants

**Technology Examples:**
- AWS Lambda + API Gateway
- Azure Functions
- Google Cloud Functions
- Cloudflare Workers
- Netlify Functions

---

### 5. Layered Architecture

**Overview:**
Traditional architecture organized into horizontal layers, where each layer has specific responsibilities and dependencies flow in one direction.

**Typical Layers:**
1. **Presentation Layer:** UI, API controllers
2. **Business Logic Layer:** Domain models, business rules
3. **Data Access Layer:** Database access, repositories
4. **Database Layer:** Physical data storage

**Key Characteristics:**
- Clear separation of concerns
- Top-down dependencies (presentation → business → data)
- Each layer can only call the layer directly below
- Horizontal slicing

**When to Use:**
- **Application Type:** Enterprise applications, traditional web apps
- **Team Structure:** Teams organized by technical specialty
- **Requirements:** Clear separation between UI, business logic, data
- **Complexity:** Medium complexity with standard CRUD operations

**Pros:**
- **Clear Separation:** Each layer has distinct responsibility
- **Easy to Understand:** Industry standard pattern
- **Testable:** Can test layers independently
- **Team Organization:** Teams can specialize by layer
- **Reusability:** Business logic reusable across different UIs

**Cons:**
- **Rigidity:** Can become rigid and hard to change
- **Cascading Changes:** Changes can ripple through all layers
- **Performance:** May require multiple layer traversals
- **Abstraction Overhead:** Sometimes unnecessary abstraction

**Best Practices:**
- Keep layers thin and focused
- Use dependency injection
- Don't skip layers
- Consider hexagonal architecture for better testability
- Use DTOs to cross layer boundaries

**Example Use Cases:**
- Enterprise resource planning (ERP) systems
- Customer relationship management (CRM)
- Traditional web applications
- Line-of-business applications

---

## Data Architecture Patterns

### 1. CRUD (Create, Read, Update, Delete)

**Overview:**
Simple, direct operations on data entities with straightforward mapping between application objects and database tables.

**When to Use:**
- Most standard applications
- Simple data operations
- Relational data model
- ACID compliance needed

**Characteristics:**
- Direct database operations
- Typically uses ORM (Object-Relational Mapping)
- Synchronous read/write
- Single source of truth

**Best Practices:**
- Use transactions for consistency
- Implement proper indexing
- Use connection pooling
- Implement caching for reads
- Use pagination for large datasets

---

### 2. CQRS (Command Query Responsibility Segregation)

**Overview:**
Separate models for reading data (queries) and writing data (commands), allowing independent optimization of each.

**When to Use:**
- Read-heavy workloads (10:1 read-to-write ratio or higher)
- Complex reporting requirements
- Different scalability needs for reads vs. writes
- Event sourcing integration

**Characteristics:**
- Write model optimized for updates
- Read model optimized for queries
- Can use different databases for each
- Eventual consistency between models
- Commands change state, queries return data

**Implementation Patterns:**

**Simple CQRS:**
- Same database, different models
- Write model uses normalized schema
- Read model uses denormalized views

**Full CQRS:**
- Separate databases for read and write
- Event-driven synchronization
- Read database optimized for queries (e.g., ElasticSearch)

**Pros:**
- Optimized read and write performance
- Independent scaling of reads and writes
- Simplified query models
- Better suited for event-driven architectures

**Cons:**
- Increased complexity
- Eventual consistency challenges
- More infrastructure needed
- Code duplication between models

**Example Use Cases:**
- Analytics dashboards with complex queries
- High-traffic applications with heavy reads
- Event-driven systems
- Systems with complex business logic

---

### 3. Event Sourcing

**Overview:**
Store all changes to application state as a sequence of events rather than just the current state.

**When to Use:**
- Need complete audit trail
- Time travel capabilities required
- Financial systems or compliance requirements
- Complex business rules and workflows
- Event-driven architecture

**Characteristics:**
- Events are immutable
- Current state derived by replaying events
- Complete history of all changes
- Can rebuild state at any point in time

**Event Store:**
- Append-only log of events
- Events never deleted or modified
- Typically uses specialized event store database

**Pros:**
- Complete audit trail automatically
- Can reconstruct any past state
- Natural fit for event-driven systems
- Supports temporal queries
- Business logic expressed as events

**Cons:**
- Query complexity (need to replay events)
- Storage requirements grow continuously
- Schema evolution challenges
- Learning curve for developers
- Eventual consistency

**Best Practices:**
- Use snapshots to avoid replaying all events
- Design events carefully (they're permanent)
- Version events for schema evolution
- Use CQRS for query optimization
- Implement event upcasting for compatibility

**Example Use Cases:**
- Banking and financial transactions
- Order processing systems
- Inventory management
- Compliance-heavy applications
- Collaborative editing systems

---

### 4. Data Lake

**Overview:**
Centralized repository that stores structured and unstructured data at any scale in its raw format.

**When to Use:**
- Big data analytics
- Machine learning pipelines
- Multiple diverse data sources
- Exploratory data analysis
- Historical data retention

**Characteristics:**
- Schema-on-read (apply structure when reading)
- Handles any data format (JSON, CSV, Parquet, images, logs)
- Scalable storage (petabyte scale)
- Separation of storage and compute

**Layers:**
- **Raw/Bronze:** Data as ingested
- **Cleansed/Silver:** Validated and cleaned data
- **Curated/Gold:** Business-level aggregates

**Pros:**
- Store any type of data
- Cost-effective storage
- Scalable to massive datasets
- Flexible analysis
- Future-proof (keep raw data)

**Cons:**
- Can become data swamp without governance
- Query performance can be slow
- Requires skilled data engineers
- Security and access control complexity

**Technology Examples:**
- AWS S3 + Athena/EMR
- Azure Data Lake + Databricks
- Google Cloud Storage + BigQuery
- Hadoop HDFS

---

## Integration Patterns

### 1. REST APIs

**Overview:**
Resource-oriented HTTP APIs using standard methods (GET, POST, PUT, DELETE, PATCH).

**When to Use:**
- Standard choice for most web and mobile APIs
- CRUD operations on resources
- Request-response communication
- Public APIs

**Characteristics:**
- Stateless
- Resource-based URLs
- HTTP methods for operations
- JSON or XML payloads
- Cacheable responses

**Best Practices:**
- Use plural nouns for resources (`/users`, not `/user`)
- Use HTTP methods correctly (GET for read, POST for create)
- Return appropriate status codes
- Version your API (`/api/v1/users`)
- Use HATEOAS for discoverability (optional)
- Implement pagination for collections
- Use HTTP caching headers

**Pros:**
- Industry standard, widely understood
- Simple to implement and consume
- Cacheable
- Stateless
- Wide tooling support

**Cons:**
- Over-fetching or under-fetching data
- Multiple round trips needed for related data
- Versioning complexity

---

### 2. GraphQL

**Overview:**
Query language for APIs that allows clients to request exactly the data they need.

**When to Use:**
- Complex UI data requirements
- Multiple client types (web, mobile, etc.)
- Need to avoid over-fetching
- Rapid frontend iteration
- Real-time data with subscriptions

**Characteristics:**
- Single endpoint
- Strongly typed schema
- Client specifies exactly what data to return
- Real-time updates via subscriptions
- Introspection for API discovery

**Pros:**
- Flexible queries
- No over-fetching or under-fetching
- Single request for related data
- Strongly typed
- Great developer experience

**Cons:**
- Learning curve
- Caching complexity
- Potential N+1 query problems
- Backend complexity
- File uploads require special handling

**Best Practices:**
- Design schema carefully
- Implement DataLoader for N+1 prevention
- Use query complexity analysis
- Implement proper authorization
- Consider persisted queries for production

---

### 3. Message Queues

**Overview:**
Asynchronous communication via message broker, allowing decoupled services to communicate.

**When to Use:**
- Background job processing
- Decoupled services
- Load leveling and buffering
- Reliable message delivery needed
- Workflow orchestration

**Characteristics:**
- Asynchronous communication
- Message persistence
- Guaranteed delivery
- Point-to-point or publish-subscribe

**Common Patterns:**
- **Work Queue:** Multiple consumers process tasks
- **Pub/Sub:** Multiple subscribers receive same message
- **Request/Reply:** Async request-response
- **Priority Queue:** Process high-priority messages first

**Pros:**
- Decouples services
- Load buffering
- Retry and error handling
- Scales independently
- Reliable delivery

**Cons:**
- Eventual consistency
- Debugging complexity
- Message ordering challenges
- Infrastructure overhead

**Technology Examples:**
- RabbitMQ
- AWS SQS
- Azure Service Bus
- Apache ActiveMQ

---

### 4. Event Streaming

**Overview:**
Real-time data streams processed continuously, allowing multiple consumers to read and react to events.

**When to Use:**
- Real-time analytics
- Event-driven architectures
- High-throughput data ingestion
- Complex event processing
- Audit logs and activity streams

**Characteristics:**
- Append-only log
- Ordered sequence of events
- Multiple consumers
- Replay capability
- Durable storage

**Pros:**
- Real-time processing
- Scalable
- Can replay events
- Multiple independent consumers
- Natural audit log

**Cons:**
- Operational complexity
- Eventual consistency
- Schema management
- Storage costs

**Technology Examples:**
- Apache Kafka
- AWS Kinesis
- Azure Event Hubs
- Google Cloud Pub/Sub

---

## Pattern Selection Guide

### Decision Matrix by Project Level

| Level | Team Size | Complexity | Recommended Pattern | Alternative |
|-------|-----------|------------|-------------------|-------------|
| 0 | 1 | Proof of concept | Simple Monolith | Serverless |
| 1 | 1-3 | Low | Monolith | Serverless |
| 2 | 4-8 | Medium | Modular Monolith | Monolith |
| 3 | 9-15 | High | Modular Monolith or Microservices | Microservices |
| 4 | 16+ | Very High | Microservices | Modular Monolith |

### Decision Matrix by NFR Priority

| Primary NFR | Pattern | Rationale |
|-------------|---------|-----------|
| Simplicity | Monolith | Minimal moving parts |
| Time to Market | Monolith or Serverless | Fast development |
| Scalability | Microservices, Serverless | Independent scaling |
| Performance | Modular Monolith | No network latency |
| Cost Optimization | Serverless, Monolith | Efficient resource use |
| Team Independence | Microservices | Independent deployment |
| Reliability | Microservices | Fault isolation |

---

## Anti-Patterns to Avoid

### 1. Distributed Monolith
**Description:** Microservices that are tightly coupled, requiring coordinated deployment

**Why Bad:** Gets all the complexity of microservices without the benefits

**How to Avoid:**
- Ensure services are truly independent
- Use async communication where possible
- Each service owns its data

---

### 2. Shared Database Across Services
**Description:** Multiple services directly accessing the same database

**Why Bad:** Creates tight coupling through shared schema

**How to Avoid:**
- Database per service
- Use APIs for cross-service data access
- Consider data replication if needed

---

### 3. Big Ball of Mud
**Description:** System with no clear structure or organization

**Why Bad:** Impossible to maintain or evolve

**How to Avoid:**
- Define clear module boundaries
- Enforce architectural principles
- Regular refactoring
- Architecture reviews

---

### 4. Golden Hammer
**Description:** Using same pattern/technology for every problem

**Why Bad:** Not all problems fit the same solution

**How to Avoid:**
- Evaluate requirements first
- Consider alternatives
- Match pattern to problem

---

**Last Updated:** 2025-12-09
