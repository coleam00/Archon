#!/bin/bash
# NFR Coverage Checklist Script
# Outputs comprehensive checklist of NFR categories to address in architecture

set -e

echo "================================================================================"
echo "  Non-Functional Requirements (NFR) Coverage Checklist"
echo "================================================================================"
echo ""
echo "Use this checklist to ensure your architecture addresses all relevant NFR"
echo "categories. Mark each item as addressed in your architecture document."
echo ""
echo "================================================================================"
echo ""

cat << 'EOF'
## Performance
  [ ] Response time targets defined and architecture addresses them
  [ ] Caching strategy designed (application, database, CDN)
  [ ] Database indexing strategy defined
  [ ] Load balancing approach specified
  [ ] Compression strategy for responses
  [ ] Query optimization approach
  [ ] Connection pooling configured
  [ ] Lazy loading / pagination strategy

## Scalability
  [ ] Horizontal scaling approach defined
  [ ] Stateless design implemented
  [ ] Database scaling strategy (sharding, read replicas)
  [ ] Load balancing configured
  [ ] Auto-scaling policies defined
  [ ] Concurrent user targets addressed
  [ ] Data volume growth strategy
  [ ] Message queues for load buffering (if applicable)

## Security
  [ ] Authentication mechanism defined (JWT, OAuth2, SAML, etc.)
  [ ] Authorization model specified (RBAC, ABAC)
  [ ] Encryption in transit (TLS/SSL) required
  [ ] Encryption at rest configured for sensitive data
  [ ] Secret management solution specified
  [ ] API security measures (rate limiting, authentication)
  [ ] Network security (VPC, security groups, firewalls)
  [ ] Input validation and sanitization strategy
  [ ] SQL injection prevention (parameterized queries)
  [ ] Compliance requirements addressed (GDPR, HIPAA, PCI DSS, SOC 2)
  [ ] Audit logging strategy defined
  [ ] Dependency scanning and security updates process

## Reliability
  [ ] Redundancy strategy (multiple instances, multi-AZ)
  [ ] Failover mechanism defined
  [ ] Circuit breakers implemented
  [ ] Retry logic with exponential backoff
  [ ] Graceful degradation approach
  [ ] Health checks configured
  [ ] Timeout handling strategy
  [ ] Database backup strategy
  [ ] Disaster recovery procedures documented
  [ ] Error rate targets defined and addressed

## Availability
  [ ] Uptime targets defined (e.g., 99.9%, 99.99%)
  [ ] Multi-region deployment (if required)
  [ ] Active-active or active-passive configuration
  [ ] Backup and restore procedures
  [ ] Monitoring and alerting configured
  [ ] Auto-scaling policies
  [ ] Database replication strategy
  [ ] Load balancer health checks
  [ ] Recovery Time Objective (RTO) defined
  [ ] Recovery Point Objective (RPO) defined

## Maintainability
  [ ] Clear module boundaries and interfaces defined
  [ ] Code organization structure specified
  [ ] Testing strategy (unit, integration, e2e)
  [ ] Documentation approach (architecture, API, code)
  [ ] CI/CD pipeline designed
  [ ] Logging strategy (structured, centralized)
  [ ] Monitoring approach (metrics, dashboards)
  [ ] Version control and branching strategy
  [ ] Code review process defined
  [ ] Dependency management approach
  [ ] Onboarding documentation for new developers

## Observability
  [ ] Logging strategy (structured logs, correlation IDs)
  [ ] Centralized log aggregation configured
  [ ] Application metrics defined
  [ ] Infrastructure metrics monitored
  [ ] Distributed tracing for request flows
  [ ] Real-time dashboards designed
  [ ] Alerting rules and thresholds defined
  [ ] Error tracking solution specified

## Usability (if applicable)
  [ ] User interface responsiveness targets
  [ ] Accessibility requirements (WCAG compliance)
  [ ] Mobile responsiveness
  [ ] Browser compatibility requirements
  [ ] Internationalization (i18n) support
  [ ] User feedback mechanisms

## Compliance (if applicable)
  [ ] Data residency requirements
  [ ] Data retention and deletion policies
  [ ] Privacy requirements (GDPR, CCPA)
  [ ] Industry-specific compliance (HIPAA, PCI DSS, SOC 2)
  [ ] Audit trail requirements
  [ ] Right to be forgotten (data deletion)

## Cost Optimization
  [ ] Infrastructure cost estimates
  [ ] Auto-scaling to match demand
  [ ] Resource right-sizing strategy
  [ ] Reserved instances / savings plans (if applicable)
  [ ] Cost monitoring and alerting
  [ ] Optimization opportunities identified

## Portability (if applicable)
  [ ] Cloud vendor lock-in minimized
  [ ] Containerization strategy (Docker)
  [ ] Infrastructure as Code (Terraform, CloudFormation)
  [ ] Database migration strategy
  [ ] Multi-cloud support (if required)

## Data Integrity
  [ ] Data validation rules
  [ ] Referential integrity enforcement
  [ ] Transaction management strategy
  [ ] Consistency guarantees defined (strong vs. eventual)
  [ ] Data backup and recovery
  [ ] Data versioning (if applicable)

## Interoperability (if applicable)
  [ ] API versioning strategy
  [ ] Integration with external systems defined
  [ ] Data format standards (JSON, XML)
  [ ] Protocol standards (REST, GraphQL, gRPC)
  [ ] Backward compatibility approach

EOF

echo ""
echo "================================================================================"
echo "  NFR Checklist Complete"
echo "================================================================================"
echo ""
echo "Review your architecture document and ensure all applicable NFRs are addressed"
echo "with specific architectural decisions and rationale."
echo ""
echo "To validate your architecture document, run:"
echo "  bash scripts/validate-architecture.sh <path-to-architecture-doc>"
echo ""
