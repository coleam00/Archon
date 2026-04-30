# System Architect Reference

This document provides detailed reference material for architectural patterns, NFR mapping, and decision-making frameworks.

## Table of Contents

1. [Architectural Patterns](#architectural-patterns)
2. [Pattern Selection Criteria](#pattern-selection-criteria)
3. [NFR Mapping Reference](#nfr-mapping-reference)
4. [Technology Stack Selection](#technology-stack-selection)
5. [Trade-off Analysis Framework](#trade-off-analysis-framework)
6. [Component Design Principles](#component-design-principles)

---

## Architectural Patterns

### Application Architecture Patterns

#### 1. Monolith

**Description:** Single deployable unit containing all application functionality.

**Characteristics:**
- All code in one codebase
- Single deployment artifact
- Shared database
- In-process communication

**When to Use:**
- Level 0-1 projects
- Small teams (1-3 developers)
- Simple requirements
- Rapid prototyping
- MVPs and proofs of concept

**Pros:**
- Simple to develop and deploy
- Easy to test end-to-end
- No network latency between components
- Simple data consistency

**Cons:**
- Scales as a unit (all or nothing)
- Can become complex over time
- Tight coupling risk
- Limited technology choices

**Example Use Cases:**
- Internal tools
- Simple CRUD applications
- Company websites
- Small SaaS products

---

#### 2. Modular Monolith

**Description:** Monolith organized into well-defined modules with clear boundaries.

**Characteristics:**
- Logical separation into modules
- Single deployment
- Module-level encapsulation
- Shared database with module-specific schemas
- Can evolve to microservices

**When to Use:**
- Level 2 projects
- Medium teams (4-8 developers)
- Growing complexity
- Need for module independence
- Future microservices potential

**Pros:**
- Balance of simplicity and modularity
- Team can work on different modules
- Refactoring to microservices easier
- Still simple deployment

**Cons:**
- Requires discipline to maintain boundaries
- Can still have coupling issues
- Shared database coordination needed

**Example Use Cases:**
- E-commerce platforms
- SaaS applications
- Enterprise applications
- Multi-tenant systems

---

#### 3. Microservices

**Description:** Independent services communicating via APIs, each deployable separately.

**Characteristics:**
- Multiple services with independent lifecycles
- Service-specific databases
- API-based communication
- Independent scaling
- Polyglot programming possible

**When to Use:**
- Level 3-4 projects
- Large teams (10+ developers)
- Complex domains
- High scalability needs
- Multiple team independence required

**Pros:**
- Independent scaling per service
- Technology diversity
- Team autonomy
- Isolated failures
- Easier to understand individual services

**Cons:**
- Operational complexity
- Network latency
- Distributed data challenges
- Testing complexity
- Requires DevOps maturity

**Example Use Cases:**
- Large-scale SaaS platforms
- High-traffic applications
- Complex business domains
- Global distributed systems

---

#### 4. Serverless

**Description:** Event-driven functions managed by cloud provider, no server management.

**Characteristics:**
- Function-as-a-Service (FaaS)
- Event-driven execution
- Automatic scaling
- Pay-per-execution
- Stateless functions

**When to Use:**
- Event-driven workloads
- Irregular traffic patterns
- Background processing
- API backends
- Cost optimization priority

**Pros:**
- Zero server management
- Automatic scaling
- Pay only for execution
- Fast deployment

**Cons:**
- Cold start latency
- Vendor lock-in
- Limited execution time
- Debugging challenges
- Complex orchestration

**Example Use Cases:**
- API gateways
- Background jobs
- Image processing
- IoT data processing
- Scheduled tasks

---

#### 5. Layered Architecture

**Description:** Traditional separation into presentation, business logic, and data layers.

**Characteristics:**
- Clear layer separation
- Top-down dependencies
- Each layer has specific responsibility
- Common in enterprise applications

**When to Use:**
- Enterprise applications
- Traditional IT environments
- Clear separation of concerns needed
- Teams organized by layer

**Pros:**
- Clear separation of concerns
- Easy to understand
- Testable layers
- Industry standard

**Cons:**
- Can become rigid
- Changes ripple through layers
- Sometimes unnecessary abstraction

**Example Use Cases:**
- Enterprise resource planning (ERP)
- Customer relationship management (CRM)
- Traditional web applications

---

### Data Architecture Patterns

#### 1. CRUD (Create, Read, Update, Delete)

**Description:** Simple operations on data entities.

**When to Use:**
- Most standard applications
- Simple data operations
- No complex query requirements

**Characteristics:**
- Direct database operations
- Typically relational database
- Straightforward data access

---

#### 2. CQRS (Command Query Responsibility Segregation)

**Description:** Separate models for reading and writing data.

**When to Use:**
- Read-heavy workloads (10:1 read-to-write ratio or more)
- Different scalability needs for reads vs. writes
- Complex reporting requirements
- Event sourcing integration

**Characteristics:**
- Write model optimized for updates
- Read model optimized for queries
- Can use different databases
- Eventual consistency between models

**Pros:**
- Optimized read and write performance
- Independent scaling
- Simpler query models

**Cons:**
- Added complexity
- Eventual consistency challenges
- More infrastructure

---

#### 3. Event Sourcing

**Description:** Store all changes as sequence of events rather than current state.

**When to Use:**
- Audit trail requirements
- Time travel capabilities needed
- Financial systems
- Complex business rules

**Characteristics:**
- Events are immutable
- Current state derived from events
- Complete history available

**Pros:**
- Complete audit trail
- Can reconstruct any past state
- Natural fit for event-driven systems

**Cons:**
- Query complexity
- Storage requirements
- Schema evolution challenges

---

#### 4. Data Lake

**Description:** Centralized repository for structured and unstructured data.

**When to Use:**
- Big data analytics
- Machine learning pipelines
- Multiple data sources
- Exploratory analysis

**Characteristics:**
- Schema-on-read
- Handles any data format
- Scalable storage

---

### Integration Patterns

#### 1. REST APIs

**Description:** Resource-oriented HTTP APIs using standard methods (GET, POST, PUT, DELETE).

**When to Use:**
- Standard choice for most APIs
- CRUD operations
- Simple request-response
- Web and mobile clients

**Pros:**
- Industry standard
- Simple to understand
- Wide tool support
- Cacheable

**Cons:**
- Over-fetching or under-fetching
- Multiple round trips needed
- Versioning challenges

---

#### 2. GraphQL

**Description:** Query language allowing clients to request exactly what they need.

**When to Use:**
- Complex UI data requirements
- Multiple client types
- Need to avoid over-fetching
- Rapid frontend iteration

**Pros:**
- Flexible queries
- Single endpoint
- Strongly typed
- Reduced over-fetching

**Cons:**
- Learning curve
- Caching complexity
- Potential N+1 queries
- Backend complexity

---

#### 3. Message Queues

**Description:** Asynchronous communication via message broker.

**When to Use:**
- Background processing
- Decoupled services
- Load leveling
- Reliable delivery needed

**Pros:**
- Asynchronous processing
- Loose coupling
- Load buffering
- Retry capabilities

**Cons:**
- Eventual consistency
- Debugging complexity
- Message ordering challenges
- Infrastructure overhead

**Examples:** RabbitMQ, AWS SQS, Azure Service Bus

---

#### 4. Event Streaming

**Description:** Real-time data stream processing.

**When to Use:**
- Real-time analytics
- Event-driven architectures
- High-throughput data
- Complex event processing

**Pros:**
- Real-time processing
- Scalable
- Replay capability
- Multiple consumers

**Cons:**
- Operational complexity
- Eventual consistency
- Schema management

**Examples:** Apache Kafka, AWS Kinesis, Azure Event Hubs

---

## Pattern Selection Criteria

### By Project Level

| Level | Typical Pattern | Rationale |
|-------|----------------|-----------|
| 0 | Simple Monolith | Proof of concept, minimal complexity |
| 1 | Monolith | Small team, straightforward requirements |
| 2 | Modular Monolith | Growing complexity, team collaboration |
| 3 | Microservices (selective) | High scale, complex domain, large team |
| 4 | Microservices | Enterprise scale, multiple teams, high complexity |

### By Team Size

| Team Size | Recommended Pattern |
|-----------|-------------------|
| 1-3 developers | Monolith |
| 4-8 developers | Modular Monolith |
| 9-15 developers | Modular Monolith or selective Microservices |
| 16+ developers | Microservices |

### By NFR Priority

| Primary NFR | Pattern Recommendation |
|-------------|----------------------|
| Scalability | Microservices, Serverless |
| Simplicity | Monolith, Modular Monolith |
| Performance | Modular Monolith with caching |
| Team Independence | Microservices |
| Cost Optimization | Serverless, Monolith |
| Rapid Development | Monolith, Serverless |

---

## NFR Mapping Reference

### Performance

**Architectural Decisions:**
- **Caching Strategy:** Redis, CDN, browser caching, database query cache
- **Database Optimization:** Indexing, query optimization, connection pooling
- **Load Balancing:** Distribute traffic across instances
- **CDN:** Static asset delivery, edge caching
- **Compression:** Gzip, Brotli for response compression
- **Lazy Loading:** Load data on demand
- **Pagination:** Limit data transfer per request

**Metrics to Address:**
- Response time targets (e.g., <200ms)
- Throughput requirements (requests per second)
- Query performance

---

### Scalability

**Architectural Decisions:**
- **Horizontal Scaling:** Add more instances rather than bigger instances
- **Stateless Design:** No session state in application servers
- **Database Sharding:** Partition data across multiple databases
- **Read Replicas:** Separate read and write databases
- **Load Balancing:** Distribute load across instances
- **Microservices:** Scale services independently
- **Message Queues:** Decouple and buffer load

**Metrics to Address:**
- Concurrent user targets (e.g., 10,000 concurrent users)
- Growth projections (e.g., 10x over 2 years)
- Data volume growth

---

### Security

**Architectural Decisions:**
- **Authentication:** JWT, OAuth2, SAML, SSO
- **Authorization:** RBAC (Role-Based Access Control), ABAC (Attribute-Based)
- **Encryption in Transit:** TLS/SSL for all communications
- **Encryption at Rest:** Database encryption, file encryption
- **Secret Management:** AWS Secrets Manager, HashiCorp Vault, Azure Key Vault
- **API Gateway:** Rate limiting, authentication, threat protection
- **Network Security:** VPC, security groups, firewalls
- **Input Validation:** Sanitization, parameterized queries (SQL injection prevention)
- **Dependency Scanning:** Regular security updates

**Requirements to Address:**
- Compliance (GDPR, HIPAA, PCI DSS, SOC 2)
- Data protection
- Access control
- Audit logging

---

### Reliability

**Architectural Decisions:**
- **Redundancy:** Multiple instances, multi-AZ deployment
- **Failover:** Automatic failover to backup instances
- **Circuit Breakers:** Prevent cascade failures
- **Retry Logic:** Exponential backoff for transient failures
- **Graceful Degradation:** Reduced functionality rather than complete failure
- **Health Checks:** Monitor service health
- **Timeout Handling:** Prevent hanging requests
- **Database Backups:** Automated regular backups
- **Disaster Recovery:** Documented recovery procedures

**Metrics to Address:**
- MTBF (Mean Time Between Failures)
- MTTR (Mean Time To Recovery)
- Error rate targets (e.g., <0.1%)

---

### Availability

**Architectural Decisions:**
- **Multi-Region Deployment:** Deploy across geographic regions
- **Active-Active Configuration:** All regions serve traffic
- **Active-Passive Configuration:** Failover to backup region
- **Backup and Restore:** Regular automated backups with tested restore
- **Monitoring and Alerting:** Proactive detection (CloudWatch, Datadog, New Relic)
- **Auto-Scaling:** Automatically adjust capacity
- **Database Replication:** Real-time or near-real-time replication
- **Load Balancing:** Health checks, automatic routing around failures

**Metrics to Address:**
- Uptime targets (e.g., 99.9%, 99.99%)
- Recovery time objectives (RTO)
- Recovery point objectives (RPO)

---

### Maintainability

**Architectural Decisions:**
- **Module Boundaries:** Clear separation with defined interfaces
- **Code Organization:** Consistent structure, naming conventions
- **Testing Strategy:** Unit, integration, end-to-end tests
- **Documentation:** Architecture docs, API docs, code comments
- **CI/CD Pipeline:** Automated build, test, deploy
- **Logging:** Structured logging, centralized log aggregation
- **Monitoring:** Application metrics, dashboards
- **Version Control:** Git with branching strategy
- **Code Reviews:** Peer review process
- **Dependency Management:** Keep dependencies updated

**Goals:**
- Easy onboarding for new developers
- Quick bug fixes
- Safe refactoring
- Clear code ownership

---

### Observability

**Architectural Decisions:**
- **Logging:** Structured logs, correlation IDs, centralized aggregation
- **Metrics:** Application metrics, infrastructure metrics
- **Tracing:** Distributed tracing for request flows
- **Dashboards:** Real-time visibility
- **Alerting:** Proactive notification of issues
- **Error Tracking:** Sentry, Rollbar, CloudWatch Logs Insights

**Tools:** CloudWatch, Datadog, New Relic, Prometheus, Grafana, ELK Stack

---

## Technology Stack Selection

### Decision Framework

For each technology choice, document:
1. **Requirement it addresses** - Which FR or NFR?
2. **Alternatives considered** - What else was evaluated?
3. **Selection rationale** - Why this choice?
4. **Trade-offs accepted** - What are the downsides?

### Common Stack Patterns

#### Web Application Stack
- **Frontend:** React, Vue, Angular, Svelte
- **Backend:** Node.js, Python, Java, C#, Go
- **Database:** PostgreSQL, MySQL, MongoDB
- **Caching:** Redis, Memcached
- **Infrastructure:** AWS, Azure, GCP

#### Mobile Application Stack
- **Mobile:** React Native, Flutter, Swift (iOS), Kotlin (Android)
- **Backend:** Same as web application
- **API:** REST or GraphQL
- **Push Notifications:** Firebase Cloud Messaging, AWS SNS

#### Data-Intensive Stack
- **Storage:** S3, Azure Blob, Google Cloud Storage
- **Processing:** Apache Spark, AWS EMR
- **Streaming:** Kafka, Kinesis
- **Warehouse:** Snowflake, BigQuery, Redshift
- **Orchestration:** Airflow, Step Functions

---

## Trade-off Analysis Framework

### Common Trade-offs

#### 1. Performance vs. Cost
- **High Performance:** More servers, better hardware, premium services
- **Lower Cost:** Fewer resources, optimization, caching
- **Balance:** Right-size resources, use caching effectively, scale on demand

#### 2. Simplicity vs. Flexibility
- **Simple:** Monolith, fewer technologies, straightforward design
- **Flexible:** Microservices, plugin architecture, abstraction layers
- **Balance:** Modular monolith, plugin architecture for known extension points only

#### 3. Consistency vs. Availability (CAP Theorem)
- **Consistency:** Strong consistency, synchronous updates, single source of truth
- **Availability:** Eventually consistent, asynchronous updates, replicated data
- **Balance:** Consistency where critical (financial), eventual consistency elsewhere

#### 4. Speed of Development vs. Long-term Maintainability
- **Speed:** Quick wins, technical debt acceptable, MVP focus
- **Maintainability:** Proper architecture, testing, documentation
- **Balance:** Iterative approach, refactor as you grow, time-boxed tech debt

#### 5. Build vs. Buy
- **Build:** Custom solution, full control, specific to needs
- **Buy:** Faster time to market, proven solution, ongoing costs
- **Balance:** Buy for commodity, build for competitive advantage

### Documentation Template

For each major trade-off:

```markdown
## Trade-off: [Name]

**Decision:** [What was decided]

**Options Considered:**
1. Option A - [Description]
2. Option B - [Description]

**Selection Rationale:**
[Why this option was chosen]

**Trade-offs Accepted:**
- **Benefit:** [What we gain]
- **Cost:** [What we give up]
- **Mitigation:** [How we minimize the cost]

**Revisit Conditions:**
[Under what conditions should this be reconsidered]
```

---

## Component Design Principles

### 1. Single Responsibility Principle
- Each component has one clear purpose
- Easy to name and describe
- Changes for only one reason

### 2. Interface Segregation
- Components expose minimal interfaces
- Clients depend only on what they use
- Multiple specific interfaces better than one general

### 3. Dependency Inversion
- Depend on abstractions, not concrete implementations
- High-level modules shouldn't depend on low-level modules
- Both should depend on abstractions

### 4. Loose Coupling
- Components are independent
- Changes in one don't require changes in others
- Communication through well-defined interfaces

### 5. High Cohesion
- Related functionality grouped together
- Component elements work together toward single purpose
- Minimal coupling between components

### Component Definition Template

```markdown
## Component: [Name]

**Responsibility:** [Single sentence describing purpose]

**Interfaces:**
- **Provides:** [APIs or services this component offers]
- **Requires:** [Dependencies on other components]

**Data Owned:** [Data entities managed by this component]

**Key Operations:**
1. [Operation 1] - [Description]
2. [Operation 2] - [Description]

**NFRs Addressed:**
- [NFR-001]: [How this component addresses it]

**Technology Choices:** [Languages, frameworks, databases used]
```

---

## References

- Martin Fowler's Architecture Patterns: https://martinfowler.com/architecture/
- Microservices.io Patterns: https://microservices.io/patterns/
- AWS Well-Architected Framework: https://aws.amazon.com/architecture/well-architected/
- Microsoft Azure Architecture Center: https://docs.microsoft.com/azure/architecture/
- Google Cloud Architecture Framework: https://cloud.google.com/architecture/framework

---

**Last Updated:** 2025-12-09
