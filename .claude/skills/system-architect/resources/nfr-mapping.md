# Non-Functional Requirements (NFR) Mapping Reference

This document provides comprehensive mapping from NFR categories to specific architectural decisions and implementation approaches.

## Table of Contents

1. [Performance](#performance)
2. [Scalability](#scalability)
3. [Security](#security)
4. [Reliability](#reliability)
5. [Availability](#availability)
6. [Maintainability](#maintainability)
7. [Observability](#observability)
8. [Usability](#usability)
9. [Compliance](#compliance)
10. [Cost Optimization](#cost-optimization)
11. [NFR Priority Framework](#nfr-priority-framework)

---

## Performance

### Definition
The system's responsiveness and efficiency in processing requests and operations.

### Common Requirements
- API response time targets (e.g., <200ms for 95th percentile)
- Page load time (e.g., <2 seconds)
- Database query performance (e.g., <50ms)
- Throughput requirements (e.g., 1000 requests/second)
- Batch processing time (e.g., process 1M records in <1 hour)

### Architectural Decisions

#### 1. Caching Strategy

**Application-Level Caching:**
- **Technology:** Redis, Memcached
- **What to Cache:**
  - User session data
  - Frequently accessed reference data
  - API responses for repeated queries
  - Computed results (aggregations, calculations)
- **Cache Invalidation:**
  - Time-based (TTL): Set expiration on cached items
  - Event-based: Invalidate when data changes
  - Manual: Admin tools to clear cache

**Database Query Caching:**
- **ORM/Query Cache:** Cache query results
- **Materialized Views:** Pre-computed query results in database
- **Query Result Cache:** Database-level caching (MySQL Query Cache, PostgreSQL shared buffers)

**CDN (Content Delivery Network):**
- **What to Cache:**
  - Static assets (images, CSS, JavaScript)
  - API responses (with appropriate headers)
  - Media files (videos, PDFs)
- **Technologies:** CloudFront, Cloudflare, Akamai, Azure CDN

**Browser Caching:**
- Use HTTP cache headers (Cache-Control, ETag)
- Service workers for offline caching

#### 2. Database Optimization

**Indexing:**
- Index frequently queried columns
- Composite indexes for multi-column queries
- Avoid over-indexing (impacts write performance)

**Query Optimization:**
- Use EXPLAIN to analyze query execution
- Avoid N+1 queries (use eager loading)
- Optimize JOIN operations
- Use appropriate data types
- Denormalize for read-heavy workloads

**Connection Pooling:**
- Reuse database connections
- Configure pool size based on load (typically 10-100)
- Monitor connection usage

**Read Replicas:**
- Separate read and write traffic
- Route heavy queries to read replicas
- Eventual consistency acceptable for reads

#### 3. Load Balancing

**Purpose:** Distribute traffic across multiple instances

**Types:**
- **Application Load Balancer (ALB):** HTTP/HTTPS traffic
- **Network Load Balancer (NLB):** TCP/UDP traffic
- **DNS Load Balancing:** Geographic distribution

**Algorithms:**
- Round-robin
- Least connections
- IP hash (sticky sessions)

**Health Checks:**
- Regular pings to instances
- Remove unhealthy instances from pool

#### 4. Compression

**Response Compression:**
- Gzip or Brotli for HTTP responses
- Typically 60-80% reduction for text content

**Image Optimization:**
- Use appropriate formats (WebP, AVIF)
- Responsive images (multiple sizes)
- Lazy loading

#### 5. Asynchronous Processing

**When to Use:**
- Long-running operations
- Non-critical tasks
- Background jobs

**Implementation:**
- Message queues for job processing
- Immediate response to user, process in background
- Progress updates via polling or webhooks

#### 6. Code-Level Optimization

**Efficient Algorithms:**
- Use appropriate data structures
- Optimize loops and iterations
- Avoid unnecessary computations

**Database Access:**
- Batch operations instead of individual queries
- Use prepared statements
- Limit result sets (pagination)

### Measurement and Monitoring

**Metrics to Track:**
- Response time (average, median, 95th/99th percentile)
- Throughput (requests per second)
- Error rate
- Database query time
- Cache hit rate

**Tools:**
- Application Performance Monitoring (APM): New Relic, Datadog, AppDynamics
- Synthetic monitoring: Test from multiple locations
- Real User Monitoring (RUM): Actual user performance data

### Example NFR Statement

**NFR-001: API Response Time**
- **Requirement:** 95% of API requests must respond in <200ms
- **Architectural Decision:**
  - Redis caching for frequently accessed data (user profiles, product catalog)
  - Database indexing on user_id, product_id, created_at
  - CDN for static assets
  - Application Load Balancer across 3+ instances
- **Validation:** Load testing to verify performance under expected load

---

## Scalability

### Definition
The system's ability to handle increased load by adding resources.

### Types of Scalability

**Horizontal Scaling (Scale Out):**
- Add more instances/servers
- Preferred for cloud environments
- Requires stateless design

**Vertical Scaling (Scale Up):**
- Add more resources to existing instance (CPU, RAM)
- Simpler but has limits
- Downtime for upgrades

### Common Requirements
- Support X concurrent users (e.g., 10,000 concurrent users)
- Handle X requests per second (e.g., 5,000 RPS)
- Process X records per day (e.g., 1M transactions/day)
- Grow X% per year (e.g., 50% growth annually)

### Architectural Decisions

#### 1. Stateless Application Design

**Why:** Enables horizontal scaling without session affinity

**Implementation:**
- Store session state externally (Redis, database)
- Use JWT tokens (no server-side session)
- Avoid local file storage (use S3/cloud storage)
- Each request is independent

#### 2. Horizontal Scaling

**Auto-Scaling:**
- **Scale-out triggers:** CPU > 70%, Memory > 80%, Queue depth > 100
- **Scale-in triggers:** CPU < 30% for sustained period
- **Min/Max instances:** Define boundaries

**Load Balancer:**
- Distribute traffic across instances
- Health checks to route around failures

**Cloud Patterns:**
- AWS: Auto Scaling Groups with ALB
- Azure: Virtual Machine Scale Sets
- GCP: Managed Instance Groups

#### 3. Database Scaling

**Read Replicas:**
- Route read queries to replicas
- Primary handles writes only
- Eventual consistency for reads

**Database Sharding:**
- Partition data across multiple databases
- Shard by customer ID, geography, or hash
- More complex, use when other options exhausted

**Connection Pooling:**
- Limit connections per application instance
- Use connection pooler (PgBouncer for PostgreSQL)

**Caching:**
- Reduce database load
- Cache read-heavy queries

#### 4. Asynchronous Processing

**Message Queues:**
- Buffer spikes in load
- Process jobs asynchronously
- Scale workers independently

**Event-Driven Architecture:**
- Decouple components
- Each component scales independently

#### 5. Microservices (for high scale)

**When to Use:** Different services have different scaling needs

**Pattern:**
- High-traffic service (e.g., product search): Scale independently
- Low-traffic service (e.g., admin): Fewer instances

#### 6. Content Delivery Network (CDN)

**Purpose:** Offload traffic from origin servers

**What to Cache:**
- Static assets
- API responses (with caching headers)
- Media files

### Capacity Planning

**Steps:**
1. Determine current capacity (load testing)
2. Project future growth
3. Calculate required resources
4. Plan scaling strategy

**Example:**
- Current: 1,000 concurrent users on 2 instances
- Target: 10,000 concurrent users
- Linear scaling: Need ~20 instances
- With optimization: ~15 instances

### Measurement and Monitoring

**Metrics to Track:**
- Concurrent users/connections
- Requests per second
- CPU and memory utilization
- Database connections
- Queue depth

**Tools:**
- Cloud provider metrics (CloudWatch, Azure Monitor)
- Application metrics (custom metrics)
- Load testing tools (JMeter, Gatling, k6)

### Example NFR Statement

**NFR-002: Concurrent Users**
- **Requirement:** Support 10,000 concurrent users
- **Architectural Decision:**
  - Stateless application design (JWT tokens, no server-side sessions)
  - Horizontal scaling with Auto Scaling Groups (min: 3, max: 20 instances)
  - Redis for shared session data and caching
  - Database read replicas (1 primary, 2 read replicas)
  - Application Load Balancer with health checks
- **Validation:** Load testing with 10,000 simulated users

---

## Security

### Definition
Protection of the system and data from unauthorized access, use, disclosure, disruption, modification, or destruction.

### Common Requirements
- Authentication and authorization
- Data encryption (in transit and at rest)
- Compliance (GDPR, HIPAA, PCI DSS, SOC 2)
- Secure API access
- Audit logging
- Secret management

### Architectural Decisions

#### 1. Authentication

**Token-Based (JWT):**
- **How:** User logs in, receives JWT token, includes in subsequent requests
- **Pros:** Stateless, scalable
- **Cons:** Token revocation complexity
- **Best Practice:** Short-lived access tokens + refresh tokens

**OAuth 2.0:**
- **How:** Third-party authentication (Google, GitHub, Microsoft)
- **Use Cases:** Social login, API access delegation
- **Flows:** Authorization Code, Client Credentials, Implicit (deprecated)

**SAML:**
- **How:** XML-based, enterprise SSO
- **Use Cases:** Enterprise applications, federated identity

**Multi-Factor Authentication (MFA):**
- **Methods:** SMS, authenticator app, hardware token
- **When:** Sensitive operations, admin access

#### 2. Authorization

**Role-Based Access Control (RBAC):**
- **How:** Users assigned roles (admin, editor, viewer), roles have permissions
- **Best For:** Well-defined roles with static permissions
- **Example:** Admin can delete users, Editor can modify content, Viewer can only read

**Attribute-Based Access Control (ABAC):**
- **How:** Access based on attributes (user department, resource owner, time of day)
- **Best For:** Complex, dynamic authorization rules
- **Example:** User can edit documents if they're the owner AND document status is "draft"

**Resource-Based:**
- **How:** Permissions attached to resources
- **Example:** AWS IAM policies

#### 3. Encryption

**In Transit (TLS/SSL):**
- **What:** All network communication encrypted
- **Implementation:**
  - HTTPS for web traffic (TLS 1.2 or 1.3)
  - TLS for database connections
  - Certificate management (Let's Encrypt, AWS ACM)
- **Best Practice:** Enforce HTTPS (redirect HTTP), use HSTS header

**At Rest:**
- **Database:** Encrypted storage volumes (AWS RDS encryption, Azure SQL TDE)
- **File Storage:** Encrypted buckets (S3 server-side encryption, Azure Storage encryption)
- **Backups:** Encrypted backups
- **Application-Level:** Encrypt sensitive fields (credit cards, SSN) before storing

**Encryption Keys:**
- Use cloud provider key management (AWS KMS, Azure Key Vault)
- Rotate keys regularly
- Never hardcode keys in code

#### 4. Secret Management

**Never in Code:**
- No passwords, API keys, or secrets in source code
- Use .env files (excluded from version control)
- Use environment variables

**Secret Management Services:**
- **AWS Secrets Manager:** Store and rotate secrets
- **Azure Key Vault:** Store secrets, keys, certificates
- **HashiCorp Vault:** Multi-cloud secret management
- **Kubernetes Secrets:** For containerized apps

**Best Practices:**
- Rotate secrets regularly
- Least privilege access to secrets
- Audit secret access

#### 5. API Security

**API Gateway:**
- Central entry point for all API requests
- Rate limiting (prevent abuse)
- Authentication/authorization
- Request/response validation
- DDoS protection

**Rate Limiting:**
- Per user/IP limits (e.g., 100 requests/minute)
- Prevents abuse and DDoS
- Implement exponential backoff

**Input Validation:**
- Validate all inputs
- Sanitize to prevent injection attacks
- Use whitelisting, not blacklisting

**API Keys:**
- For service-to-service communication
- Rotate regularly
- Revoke if compromised

#### 6. Network Security

**Virtual Private Cloud (VPC):**
- Isolated network environment
- Subnets (public and private)
- Network ACLs and security groups

**Security Groups / Firewalls:**
- Restrict inbound/outbound traffic
- Principle of least privilege
- Only open necessary ports

**Private Subnets:**
- Database and backend services in private subnets
- Not directly accessible from internet
- Access via bastion host or VPN

#### 7. Secure Coding Practices

**SQL Injection Prevention:**
- Use parameterized queries/prepared statements
- Never concatenate SQL with user input
- Use ORM with proper escaping

**Cross-Site Scripting (XSS) Prevention:**
- Escape output
- Use Content Security Policy (CSP) headers
- Sanitize user input

**Cross-Site Request Forgery (CSRF) Prevention:**
- CSRF tokens
- SameSite cookie attribute
- Verify origin headers

#### 8. Dependency Security

**Keep Dependencies Updated:**
- Regular security updates
- Monitor for vulnerabilities

**Vulnerability Scanning:**
- Automated scanning (Snyk, Dependabot, npm audit)
- Address high/critical vulnerabilities immediately

**Software Composition Analysis:**
- Know what's in your dependencies
- License compliance

#### 9. Audit Logging

**What to Log:**
- Authentication attempts (success and failure)
- Authorization decisions
- Data access (especially sensitive data)
- Configuration changes
- Admin actions

**What NOT to Log:**
- Passwords or secrets
- Full credit card numbers
- Personal health information (unless encrypted)

**Log Storage:**
- Centralized logging (CloudWatch, ELK, Splunk)
- Immutable logs (append-only)
- Retention policy based on compliance requirements

### Compliance Frameworks

#### GDPR (General Data Protection Regulation)
- **Applicability:** EU citizens' data
- **Key Requirements:**
  - User consent for data collection
  - Right to access data
  - Right to deletion (right to be forgotten)
  - Data breach notification (72 hours)
  - Data minimization
- **Architectural Decisions:**
  - Data deletion workflows
  - Consent management
  - Data export functionality
  - Audit logging

#### HIPAA (Health Insurance Portability and Accountability Act)
- **Applicability:** Healthcare data in US
- **Key Requirements:**
  - Encryption at rest and in transit
  - Access controls and audit logs
  - Business Associate Agreements (BAAs)
  - Data backup and disaster recovery
- **Architectural Decisions:**
  - PHI encryption
  - Role-based access control
  - Comprehensive audit logging
  - HIPAA-compliant cloud services

#### PCI DSS (Payment Card Industry Data Security Standard)
- **Applicability:** Processing credit card payments
- **Key Requirements:**
  - Never store CVV
  - Encrypt card data
  - Secure network
  - Regular security testing
- **Architectural Decisions:**
  - Use payment gateway (Stripe, PayPal) - avoid storing card data
  - Tokenization instead of storage
  - Network segmentation
  - Regular penetration testing

#### SOC 2 (Service Organization Control 2)
- **Applicability:** Service providers handling customer data
- **Key Requirements:**
  - Security controls
  - Availability controls
  - Processing integrity
  - Confidentiality
  - Privacy
- **Architectural Decisions:**
  - Documented security policies
  - Access controls and monitoring
  - Incident response procedures
  - Regular audits

### Measurement and Monitoring

**Metrics to Track:**
- Failed authentication attempts
- Authorization failures
- Security events (from IDS/IPS)
- Vulnerability scan results
- Certificate expiration

**Tools:**
- SIEM (Security Information and Event Management): Splunk, LogRhythm
- Vulnerability scanners: Nessus, Qualys
- Penetration testing: Regular third-party testing

### Example NFR Statement

**NFR-003: PCI DSS Compliance**
- **Requirement:** Process credit card payments securely, PCI DSS compliant
- **Architectural Decision:**
  - Use Stripe payment gateway (PCI DSS Level 1 certified)
  - Never store credit card data (tokenization via Stripe)
  - TLS 1.2+ for all payment-related communication
  - Network segmentation (payment processing in isolated environment)
  - Annual third-party penetration testing
- **Validation:** PCI DSS self-assessment questionnaire, third-party audit

---

## Reliability

### Definition
The ability of the system to function correctly and consistently over time, recovering from failures.

### Common Requirements
- Mean Time Between Failures (MTBF): e.g., 720 hours (30 days)
- Mean Time To Recovery (MTTR): e.g., <15 minutes
- Error rate: e.g., <0.1% of requests
- Data durability: e.g., 99.999999999% (11 nines)

### Architectural Decisions

#### 1. Redundancy

**Application Redundancy:**
- Multiple instances across availability zones
- Minimum 2 instances per service (for failover)
- Load balancer distributes traffic

**Database Redundancy:**
- Primary-replica configuration
- Multi-AZ deployment for automatic failover
- Synchronous or asynchronous replication

**Infrastructure Redundancy:**
- Multiple availability zones
- Multi-region for critical applications

#### 2. Failover Mechanisms

**Automatic Failover:**
- Load balancer health checks
- Remove failed instances automatically
- Route traffic to healthy instances

**Database Failover:**
- Automatic promotion of replica to primary
- RDS Multi-AZ (AWS), Always On (Azure SQL)

**DNS Failover:**
- Route 53 health checks
- Failover to backup region

#### 3. Circuit Breaker Pattern

**Purpose:** Prevent cascading failures

**How It Works:**
1. **Closed State:** Normal operation, requests flow through
2. **Open State:** After threshold failures, stop sending requests (fail fast)
3. **Half-Open State:** After timeout, try one request to test if service recovered

**Implementation:**
- Libraries: Hystrix (Java), Polly (.NET), opossum (Node.js)
- Timeouts and failure thresholds configurable

#### 4. Retry Logic

**Exponential Backoff:**
- Retry with increasing delays (1s, 2s, 4s, 8s)
- Prevents overwhelming failed service
- Add jitter to prevent thundering herd

**When to Retry:**
- Network errors
- Timeouts
- HTTP 5xx errors (server errors)

**When NOT to Retry:**
- HTTP 4xx errors (client errors - fix the request instead)
- Non-idempotent operations without idempotency keys

**Idempotency:**
- Ensure retries don't cause duplicate operations
- Use idempotency keys for critical operations

#### 5. Graceful Degradation

**Concept:** Reduce functionality rather than complete failure

**Examples:**
- Show cached data if live data unavailable
- Disable non-critical features if dependent service down
- Use default values if recommendation service fails

#### 6. Health Checks

**Application Health:**
- `/health` endpoint returns service status
- Check dependencies (database, cache, external services)
- Load balancer uses for routing decisions

**Liveness vs Readiness:**
- **Liveness:** Is the service running? (restart if fails)
- **Readiness:** Is the service ready to serve traffic? (remove from load balancer if fails)

#### 7. Timeout Handling

**Set Timeouts:**
- All external calls (APIs, database, cache)
- Reasonable timeouts (e.g., 5-30 seconds for API calls)
- Prevent hanging requests

**Cascading Timeouts:**
- Each layer has shorter timeout than the layer above
- Example: Gateway 30s → Service 20s → Database 10s

#### 8. Data Integrity

**Transactions:**
- Use ACID transactions for critical operations
- Atomicity ensures all-or-nothing

**Backups:**
- Automated regular backups
- Point-in-time recovery
- Test restore procedures

**Data Validation:**
- Validate data before persisting
- Referential integrity constraints
- Check constraints

### Disaster Recovery

**Backup Strategy:**
- Automated daily backups
- Retention policy (e.g., 30 days)
- Offsite/different region storage

**Recovery Procedures:**
- Documented step-by-step procedures
- Regular DR drills
- Runbooks for common failures

**Recovery Point Objective (RPO):**
- How much data loss is acceptable (e.g., 1 hour)
- Determines backup frequency

**Recovery Time Objective (RTO):**
- How quickly must service be restored (e.g., 4 hours)
- Influences architecture choices

### Measurement and Monitoring

**Metrics to Track:**
- Error rate (errors per total requests)
- Mean time between failures (MTBF)
- Mean time to recovery (MTTR)
- Success rate of retries
- Circuit breaker state changes

**Tools:**
- Error tracking: Sentry, Rollbar, Bugsnag
- Uptime monitoring: Pingdom, UptimeRobot
- Synthetic monitoring: Test critical flows

### Example NFR Statement

**NFR-004: Error Rate**
- **Requirement:** System error rate must be <0.1% (99.9% success rate)
- **Architectural Decision:**
  - Redundancy: Minimum 3 application instances across 2 availability zones
  - Circuit breakers on all external service calls (open after 5 failures in 30s)
  - Exponential backoff retry (3 attempts with 1s, 2s, 4s delays)
  - Health checks every 30 seconds, remove unhealthy instances
  - Graceful degradation: Serve cached data if database unavailable
  - Database: Multi-AZ RDS with automatic failover
- **Validation:** Chaos engineering (kill instances, test recovery)

---

## Availability

### Definition
The proportion of time the system is operational and accessible.

### Common Requirements
- 99% uptime (3.65 days downtime/year)
- 99.9% uptime (8.76 hours downtime/year)
- 99.99% uptime (52.56 minutes downtime/year)
- 99.999% uptime (5.26 minutes downtime/year)

### Architectural Decisions

#### 1. Multi-Region Deployment

**Active-Active:**
- All regions serve traffic simultaneously
- Geographic load balancing (Route 53, Traffic Manager)
- Data replication across regions
- Highest availability, highest cost

**Active-Passive:**
- One region serves traffic, others on standby
- Failover to passive region if active fails
- Lower cost, slightly lower availability

**When to Use:**
- 99.99% or higher availability requirement
- Global user base
- Disaster recovery requirements

#### 2. Multi-AZ (Availability Zone) Deployment

**Purpose:** Protect against data center failures

**Implementation:**
- Deploy application instances across multiple AZs
- Load balancer distributes across AZs
- Database with Multi-AZ (automatic failover)

**Cloud Patterns:**
- AWS: Multiple AZs in same region
- Azure: Availability Zones or Availability Sets
- GCP: Zonal or regional resources

#### 3. Auto-Scaling

**Purpose:** Maintain capacity during failures or traffic spikes

**Health-Based Scaling:**
- Replace unhealthy instances automatically
- Maintain minimum instance count

**Load-Based Scaling:**
- Scale up during high traffic
- Scale down during low traffic
- Prevent overload that could cause outage

#### 4. Backup and Restore

**Automated Backups:**
- Daily automated backups
- Continuous backups (point-in-time recovery)
- Multiple backup copies

**Backup Testing:**
- Regular restore drills
- Verify backup integrity
- Measure restore time

**Backup Storage:**
- Separate region/account
- Immutable backups
- Retention policy

#### 5. Monitoring and Alerting

**Proactive Monitoring:**
- Monitor system health continuously
- Alert before users are impacted
- Dashboards for real-time visibility

**Key Metrics:**
- Uptime/downtime
- Error rates
- Response times
- Resource utilization

**Alerting:**
- Page on-call engineer for critical issues
- Escalation procedures
- Runbooks for common issues

**Tools:**
- CloudWatch, Azure Monitor, GCP Monitoring
- Datadog, New Relic, Dynatrace
- PagerDuty, Opsgenie for alerting

#### 6. Planned Maintenance

**Zero-Downtime Deployments:**
- Rolling deployments
- Blue-green deployments
- Canary deployments

**Maintenance Windows:**
- Schedule during low-traffic periods
- Communicate to users in advance
- Have rollback plan

#### 7. Database High Availability

**Replication:**
- Primary-replica setup
- Synchronous or asynchronous replication
- Automatic failover

**Multi-AZ:**
- RDS Multi-AZ (AWS)
- Always On (SQL Server)
- Availability Groups (Azure SQL)

**Backups:**
- Automated backups
- Point-in-time recovery
- Geographic redundancy

#### 8. Load Balancing

**Health Checks:**
- Regular checks of backend instances
- Remove unhealthy from pool automatically
- Configurable check intervals and thresholds

**Connection Draining:**
- Complete in-flight requests before removing instance
- Graceful shutdown

#### 9. Dependency Management

**Critical vs Non-Critical:**
- Identify critical dependencies (must be up for system to work)
- Graceful degradation for non-critical dependencies

**Service Level Agreements (SLAs):**
- Understand SLAs of dependencies
- Your SLA cannot exceed dependencies
- Example: If cloud provider offers 99.95%, you can't offer 99.99%

### Calculating Availability

**Serial Dependencies (worst case):**
```
Overall = Component1 × Component2 × Component3
Example: 99.9% × 99.9% × 99.9% = 99.7%
```

**Parallel Redundancy (improves availability):**
```
Failure rate = FailureRate1 × FailureRate2
Example: 99% × 99% = 98.01% failure → 99.99% availability
```

### Maintenance Windows

**Scheduled Maintenance:**
- Announce in advance
- During low-traffic periods
- Count against SLA or not (specify in SLA)

**Zero-Downtime Deployments:**
- Rolling updates
- No maintenance window needed
- Higher complexity

### Measurement and Monitoring

**Metrics to Track:**
- Uptime percentage
- Downtime incidents (count, duration)
- Mean time to detect (MTTD)
- Mean time to recovery (MTTR)
- Availability by component

**Tools:**
- Uptime monitoring: Pingdom, StatusCake
- Incident management: PagerDuty, VictorOps
- Status pages: Atlassian Statuspage, StatusPage.io

### Example NFR Statement

**NFR-005: 99.9% Uptime**
- **Requirement:** System must be available 99.9% of time (max 8.76 hours downtime/year)
- **Architectural Decision:**
  - Multi-AZ deployment (minimum 2 AZs)
  - Minimum 3 application instances with Auto Scaling (maintains capacity during failures)
  - Application Load Balancer with health checks (30s interval, 2 failures = unhealthy)
  - RDS Multi-AZ with automatic failover (<2 minutes)
  - Redis with cluster mode (automatic failover)
  - Monitoring and alerting (CloudWatch, PagerDuty)
  - Runbooks for common incidents
  - Rolling deployments (zero-downtime releases)
  - Scheduled maintenance windows not counted against SLA (announced 7 days in advance)
- **Validation:** Uptime monitoring, chaos engineering, failure simulations
- **Expected Availability:** 99.95% (exceeds requirement)
  - ALB: 99.99% (AWS SLA)
  - Application: 99.99% (Multi-AZ, auto-scaling)
  - RDS Multi-AZ: 99.95% (AWS SLA)
  - Overall: ~99.93% (accounts for dependencies)

---

## Maintainability

### Definition
The ease with which the system can be modified, updated, and extended.

### Common Requirements
- Time to onboard new developer (e.g., <1 week to first commit)
- Time to fix bugs (e.g., critical bugs fixed in <4 hours)
- Code test coverage (e.g., >80%)
- Documentation currency (e.g., updated with each release)

### Architectural Decisions

#### 1. Module Boundaries

**Clear Separation:**
- Each module has single responsibility
- Well-defined interfaces between modules
- Minimize coupling, maximize cohesion

**Patterns:**
- Layered architecture
- Hexagonal architecture (ports and adapters)
- Clean architecture

**Benefits:**
- Easy to understand individual modules
- Changes isolated to specific modules
- Can replace modules without affecting others

#### 2. Code Organization

**Consistent Structure:**
```
/src
  /modules or /features  (organized by feature)
  /shared or /common    (shared code)
  /infrastructure       (external dependencies)
```

**Naming Conventions:**
- Consistent, descriptive names
- Follow language/framework conventions

**File Organization:**
- Related files together
- Clear folder structure
- README in each major folder

#### 3. Testing Strategy

**Test Pyramid:**
1. **Unit Tests (70%):** Test individual functions/methods
2. **Integration Tests (20%):** Test component interactions
3. **End-to-End Tests (10%):** Test complete user workflows

**Test Coverage:**
- Target: 80%+ coverage
- 100% coverage for critical paths
- Automated in CI pipeline

**Types:**
- Unit tests
- Integration tests
- End-to-end tests
- Performance tests
- Security tests

**Tools:**
- Jest, Mocha (JavaScript)
- pytest (Python)
- JUnit (Java)
- xUnit (.NET)

#### 4. Documentation

**Architecture Documentation:**
- System overview
- Architecture diagrams
- Component responsibilities
- Decision records (ADRs)

**API Documentation:**
- OpenAPI/Swagger for REST APIs
- GraphQL schema and documentation
- Request/response examples
- Error codes

**Code Documentation:**
- Comments for complex logic
- Docstrings for functions/classes
- README for each module

**Runbooks:**
- Deployment procedures
- Troubleshooting guides
- Common tasks

**Keep Updated:**
- Documentation as part of pull request
- Review in code reviews
- Automated documentation generation

#### 5. CI/CD Pipeline

**Continuous Integration:**
- Automated build on every commit
- Run tests automatically
- Code quality checks (linting, formatting)
- Fail fast if issues detected

**Continuous Deployment:**
- Automated deployment to staging
- Manual or automated to production
- Rollback capability

**Pipeline Stages:**
1. Build
2. Unit tests
3. Integration tests
4. Code quality checks
5. Security scanning
6. Deploy to staging
7. E2E tests
8. Deploy to production

**Tools:**
- GitHub Actions, GitLab CI, Jenkins
- CircleCI, Travis CI

#### 6. Logging

**Structured Logging:**
- JSON format for easy parsing
- Include context (request ID, user ID, timestamp)
- Consistent log levels (DEBUG, INFO, WARN, ERROR)

**What to Log:**
- Application errors and exceptions
- Important business events
- Performance metrics
- Security events

**What NOT to Log:**
- Passwords or secrets
- Personal data (unless encrypted/masked)
- Full credit card numbers

**Centralized Logging:**
- Aggregate logs from all instances
- ELK Stack (Elasticsearch, Logstash, Kibana)
- CloudWatch Logs, Azure Monitor
- Searchable and filterable

#### 7. Monitoring

**Application Metrics:**
- Request count, response time
- Error rate
- Business metrics (orders placed, users signed up)

**Infrastructure Metrics:**
- CPU, memory, disk usage
- Network traffic
- Database connections

**Dashboards:**
- Real-time system health
- Historical trends
- Anomaly detection

**Tools:**
- Prometheus + Grafana
- Datadog, New Relic
- CloudWatch, Azure Monitor

#### 8. Version Control

**Branching Strategy:**
- Git Flow: main, develop, feature branches
- Trunk-based: main branch, short-lived feature branches
- Choose one and be consistent

**Commit Messages:**
- Descriptive commit messages
- Reference issue/ticket numbers
- Follow conventional commits format

**Pull Requests:**
- Required for all changes
- Code review before merge
- Automated checks must pass

#### 9. Code Reviews

**Benefits:**
- Catch bugs early
- Knowledge sharing
- Maintain code quality
- Enforce standards

**Best Practices:**
- Review all code before merge
- Use checklist
- Be constructive
- Limit PR size (easier to review)

#### 10. Dependency Management

**Keep Updated:**
- Regular dependency updates
- Automated vulnerability scanning
- Address security issues promptly

**Lock Files:**
- Lock dependency versions (package-lock.json, yarn.lock)
- Reproducible builds

**Minimal Dependencies:**
- Only include necessary libraries
- Reduce attack surface
- Faster builds

### Technical Debt Management

**Track Debt:**
- Document technical debt
- Prioritize based on impact
- Allocate time to pay down

**Prevent Accumulation:**
- Code reviews catch issues early
- Refactor as you go
- Don't sacrifice quality for speed

### Measurement and Monitoring

**Metrics to Track:**
- Code coverage percentage
- Number of open bugs (by severity)
- Time to resolve bugs
- Deployment frequency
- Mean time to recovery (MTTR)
- Code quality scores (SonarQube)

### Example NFR Statement

**NFR-006: Maintainability**
- **Requirement:** New developers productive within 1 week, >80% test coverage
- **Architectural Decision:**
  - Modular architecture with clear boundaries (user, product, order modules)
  - Comprehensive README with setup instructions
  - Testing: Jest for unit tests, Cypress for E2E (target 80% coverage)
  - CI/CD: GitHub Actions (build, test, deploy on every commit)
  - Structured logging (Winston) with CloudWatch aggregation
  - API documentation (OpenAPI/Swagger, auto-generated)
  - Code reviews required for all PRs
  - Conventional commits for clear history
  - Dependency scanning (Dependabot weekly)
- **Validation:** Track onboarding time, measure test coverage in CI

---

## Observability

### Definition
The ability to understand the internal state of the system by examining its outputs (logs, metrics, traces).

### Three Pillars of Observability

#### 1. Logging

**Purpose:** Understand what happened

**Best Practices:**
- Structured logs (JSON format)
- Include context (request ID, user ID, timestamp)
- Correlation IDs for tracing requests
- Consistent log levels

**Centralized Logging:**
- Aggregate from all instances
- Searchable and filterable
- Retention policy

**Tools:** ELK Stack, CloudWatch Logs, Splunk

#### 2. Metrics

**Purpose:** Quantify system behavior

**Types:**
- **Application Metrics:** Request count, response time, error rate
- **Infrastructure Metrics:** CPU, memory, disk, network
- **Business Metrics:** Orders placed, users signed up

**Best Practices:**
- Monitor key indicators
- Set up dashboards
- Alert on anomalies

**Tools:** Prometheus, Datadog, CloudWatch

#### 3. Distributed Tracing

**Purpose:** Follow request through distributed system

**How It Works:**
- Each request gets unique trace ID
- Each service adds span with timing
- Visualize complete request flow

**Benefits:**
- Identify bottlenecks
- Understand dependencies
- Debug distributed systems

**Tools:** Jaeger, Zipkin, AWS X-Ray, Datadog APM

### Architectural Decisions

#### 1. Structured Logging

**Format:**
```json
{
  "timestamp": "2025-12-09T12:00:00Z",
  "level": "INFO",
  "service": "order-service",
  "trace_id": "abc123",
  "user_id": "user456",
  "message": "Order created",
  "order_id": "order789",
  "amount": 99.99
}
```

**Libraries:**
- Winston (Node.js)
- Logrus (Go)
- Serilog (.NET)
- Python logging

#### 2. Correlation IDs

**Purpose:** Track single request across services

**Implementation:**
- Generate ID at entry point (API Gateway)
- Pass in headers (X-Correlation-ID)
- Include in all logs
- Return in response for debugging

#### 3. Application Metrics

**Key Metrics (RED method):**
- **Rate:** Requests per second
- **Errors:** Error rate
- **Duration:** Response time distribution

**Or USE method (for resources):**
- **Utilization:** Percentage of resource in use
- **Saturation:** Amount of queued work
- **Errors:** Error count

**Custom Metrics:**
- Business KPIs (orders, signups)
- Feature usage
- Funnel metrics

#### 4. Dashboards

**Real-Time Dashboards:**
- System health overview
- Key metrics at a glance
- Drill-down capabilities

**Dashboards to Create:**
- System overview
- Service-specific dashboards
- Infrastructure dashboards
- Business metrics dashboards

#### 5. Alerting

**Alert on:**
- Error rate exceeds threshold
- Response time exceeds SLA
- Resource utilization too high
- Service down

**Alert Fatigue Prevention:**
- Only alert on actionable issues
- Tune thresholds
- Aggregate similar alerts

**Tools:** PagerDuty, Opsgenie, AlertManager

#### 6. Error Tracking

**Detailed Error Info:**
- Stack trace
- Context (user, request, environment)
- Frequency
- Affected users

**Tools:** Sentry, Rollbar, Bugsnag

### Measurement and Monitoring

**Metrics to Track:**
- Mean time to detect (MTTD)
- Mean time to resolution (MTTR)
- Alert noise (false positive rate)
- Dashboard usage

### Example NFR Statement

**NFR-007: Observability**
- **Requirement:** Detect and diagnose issues within 5 minutes
- **Architectural Decision:**
  - Structured logging (JSON) with Winston, aggregated in CloudWatch
  - Correlation IDs for request tracing across services
  - Application metrics (Prometheus) with Grafana dashboards
  - Distributed tracing (AWS X-Ray) for microservices
  - Error tracking (Sentry) with Slack integration
  - Real-time dashboards (Grafana) for system health
  - Alerting (PagerDuty) for critical issues (error rate >1%, response time >500ms)
- **Validation:** Incident drills, measure time to detect and resolve

---

## Usability

### Definition
The ease with which users can accomplish their goals using the system.

### Common Requirements
- Page load time (e.g., <2 seconds)
- Responsive design (mobile, tablet, desktop)
- Accessibility (WCAG 2.1 AA compliance)
- Browser compatibility (Chrome, Firefox, Safari, Edge)
- Internationalization (support multiple languages)

### Architectural Decisions

#### 1. Performance (User-Perceived)

See [Performance](#performance) section for detailed decisions.

**Key Factors:**
- Page load time <2 seconds
- Time to interactive <3 seconds
- Smooth scrolling and animations

#### 2. Responsive Design

**Approach:**
- Mobile-first design
- Breakpoints for tablet, desktop
- Flexible layouts (CSS Grid, Flexbox)
- Responsive images

**Framework Support:**
- Bootstrap, Material UI, Tailwind CSS

#### 3. Accessibility

**WCAG 2.1 Compliance:**
- Level A (minimum)
- Level AA (recommended)
- Level AAA (highest)

**Key Principles:**
- **Perceivable:** Text alternatives, captions, adaptable content
- **Operable:** Keyboard accessible, sufficient time, seizure prevention
- **Understandable:** Readable, predictable, input assistance
- **Robust:** Compatible with assistive technologies

**Implementation:**
- Semantic HTML
- ARIA labels and roles
- Keyboard navigation
- Sufficient color contrast
- Screen reader testing

**Tools:**
- axe DevTools, WAVE
- Lighthouse accessibility audit

#### 4. Browser Compatibility

**Support:**
- Modern browsers (last 2 versions)
- Specific browsers based on audience

**Tools:**
- Browserslist
- Polyfills for older browsers
- Automated cross-browser testing

#### 5. Internationalization (i18n)

**Approach:**
- Externalize strings (don't hardcode)
- Support multiple locales
- Right-to-left (RTL) support
- Date/time/number formatting

**Libraries:**
- i18next (JavaScript)
- gettext (Python)
- Rails I18n (Ruby)

---

## Compliance

See [Security - Compliance Frameworks](#compliance-frameworks) for detailed information on GDPR, HIPAA, PCI DSS, SOC 2.

---

## Cost Optimization

### Definition
Minimizing infrastructure and operational costs while meeting requirements.

### Common Requirements
- Stay within budget (e.g., <$5,000/month infrastructure)
- Cost per transaction (e.g., <$0.01 per order)
- Optimize cloud spending

### Architectural Decisions

#### 1. Right-Sizing Resources

**Approach:**
- Monitor actual usage
- Adjust instance sizes
- Don't over-provision

**Auto-Scaling:**
- Scale down during low traffic
- Scale up during high traffic
- Pay only for what you use

#### 2. Reserved Instances / Savings Plans

**For Steady-State Workloads:**
- 1-year or 3-year commitments
- Up to 75% savings vs on-demand
- AWS Reserved Instances, Azure Reserved VM Instances

#### 3. Serverless for Variable Workloads

**Pay-Per-Use:**
- No idle costs
- Automatic scaling
- Lambda, Azure Functions, Cloud Functions

#### 4. Caching

**Reduce Costs:**
- Fewer database queries
- Fewer API calls
- Less compute needed

#### 5. Storage Tiering

**S3 Storage Classes:**
- S3 Standard (frequent access)
- S3 Infrequent Access (less frequent)
- S3 Glacier (archive)
- Lifecycle policies to move data between tiers

#### 6. Cost Monitoring

**Track Spending:**
- Set budgets and alerts
- Cost allocation tags
- Identify cost drivers

**Tools:**
- AWS Cost Explorer, Azure Cost Management
- CloudHealth, Cloudability

---

## NFR Priority Framework

### Prioritizing NFRs

Not all NFRs are equally important. Prioritize based on:

1. **Business Impact:** What happens if not met?
2. **User Impact:** Does it affect user experience?
3. **Regulatory:** Is it required by law?
4. **Cost:** What's the cost to implement?

### Priority Levels

**P0 (Critical):**
- System unusable if not met
- Regulatory/compliance requirements
- Security vulnerabilities

**P1 (High):**
- Significant user impact
- Competitive disadvantage if not met
- High business value

**P2 (Medium):**
- Nice to have
- Improves user experience
- Moderate effort

**P3 (Low):**
- Future consideration
- Low impact
- High effort

### Trade-offs

**Common Trade-offs:**
- Performance vs. Cost
- Security vs. Usability
- Availability vs. Cost
- Simplicity vs. Flexibility

**Decision Framework:**
1. Identify conflicting NFRs
2. Understand business priorities
3. Quantify trade-offs
4. Document decision and rationale
5. Plan to revisit if priorities change

---

**Last Updated:** 2025-12-09
