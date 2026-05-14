---
inclusion: always
---

# Generic Naming Conventions

🚨 **PROACTIVE ENFORCEMENT REQUIRED** 🚨
Before naming ANY resource, AI MUST:

1. Check: What type of resource is being named?
2. Validate: Does name follow framework pattern for this type?
3. Block: Non-compliant names until corrected
4. Verify: Name uses generic placeholders (no company/product names)

## Database Tables and Attributes

### DynamoDB Tables

- **Format**: PascalCase with environment prefix
- **Examples**: `dev-UserData`, `prod-UserData`, `staging-SystemSettings`
- **Pattern**: `[environment]-[EntityName]`
- **Environment Values**: `dev`, `staging`, `prod`, `test`

### DynamoDB Attributes

- **Format**: camelCase
- **Examples**: `userId`, `itemKey`, `createdAt`, `statusValue`
- **Pattern**: Descriptive with clear data type indication

### Global Secondary Indexes (GSI)

- **Format**: PascalCase with environment prefix and descriptive suffix
- **Examples**: `dev-UserDataByStatus`, `prod-ItemsByCategory`, `staging-UsersByEmail`
- **Pattern**: `[environment]-[Entity]By[QueryAttribute]`

## Infrastructure as Code Templates and Resources

### CloudFormation Template Files

- **Format**: kebab-case with numeric prefix
- **Examples**: `01-core-infrastructure.yml`, `09-api-resolver.yml`
- **Pattern**: `[##]-[feature-name].yml`
- **Note**: Templates are environment-agnostic; environment specified via parameters

### SAM Template Files

- **Format**: kebab-case, typically named template.yaml/yml
- **Examples**: `template.yml`, `sam-template.yaml`, `serverless-template.yml`
- **Pattern**: `[template|sam-template|serverless-template].[yml|yaml]`
- **Note**: SAM extends CloudFormation with serverless-specific resources

### CDK Application Files

- **Format**: Language-specific conventions
- **TypeScript**: `app.ts`, `lib/[stack-name]-stack.ts`
- **Python**: `app.py`, `[package]/[stack_name]_stack.py`
- **Java**: `App.java`, `[StackName]Stack.java`
- **C#**: `Program.cs`, `[StackName]Stack.cs`
- **Go**: `main.go`, `[stack-name].go`

### Terraform Files

- **Format**: kebab-case with descriptive purpose
- **Examples**: `main.tf`, `variables.tf`, `outputs.tf`, `vpc.tf`
- **Pattern**: `[purpose].tf`
- **Note**: Use descriptive names for resource-specific files

### Stack/Application Names

- **CloudFormation**: `[environment]-[##]-[feature-name]` (matches template file name)
- **SAM**: `[environment]-[application-name]` (e.g., `dev-serverless-api`)
- **CDK**: `[Environment][StackName]Stack` (e.g., `DevApiStack`, `ProdDataStack`)
- **Terraform**: `[environment]-[workspace-name]` (e.g., `dev-infrastructure`)

### IaC Resource Naming

- **Format**: PascalCase with descriptive suffix (environment handled by deployment)
- **Examples**: `UserDataTable`, `ApiResolverLambda`, `AssetsS3Bucket`
- **Pattern**: `[Purpose][ResourceType]`
- **Note**: Environment isolation achieved through stack/workspace deployment, not resource names

### IaC Parameters/Variables

- **CloudFormation/SAM Parameters**: PascalCase (e.g., `Environment`, `BuildVersion`)
- **CDK Properties**: camelCase (e.g., `environment`, `buildVersion`)
- **Terraform Variables**: snake_case (e.g., `environment`, `build_version`)

### IaC Outputs

- **CloudFormation/SAM**: PascalCase (e.g., `ApiEndpoint`, `UserPoolId`)
- **CDK**: camelCase (e.g., `apiEndpoint`, `userPoolId`)
- **Terraform**: snake_case (e.g., `api_endpoint`, `user_pool_id`)

## AWS Resources

### Lambda Functions

- **Format**: PascalCase with environment prefix
- **Examples**: `dev-ApiResolverLambda`, `prod-UsersResolverLambda`, `staging-DataProcessorLambda`
- **Pattern**: `[environment]-[Purpose][Resolver|Processor|Handler]Lambda`

### S3 Buckets

- **Format**: kebab-case with environment prefix and random suffix for public buckets
- **Examples**: `dev-assets-s3bucket-a7x9k`, `prod-backups-s3bucket-m3n8p`
- **Pattern**: `[environment]-[purpose]-s3bucket-[random-suffix]`
- **Note**: Use random suffix for buckets with public access or sensitive content

### IAM Roles and Policies

- **Roles Format**: PascalCase with environment prefix and IamRole suffix
- **Examples**: `dev-ApiResolverIamRole`, `prod-AdminUserIamRole`
- **Policies Format**: PascalCase with environment prefix and IamPolicy suffix
- **Examples**: `dev-DynamoDBReadIamPolicy`, `prod-S3UploadIamPolicy`
- **Pattern**: `[environment]-[Purpose][IamRole|IamPolicy]`

### CloudWatch Resources

- **Log Groups**: `/aws/lambda/[environment]-[function-name]`
- **Examples**: `/aws/lambda/dev-ApiResolverLambda`, `/aws/lambda/prod-UsersResolverLambda`
- **Alarms**: `[environment]-[resource-type]-[metric]-cloudwatch-alarm`
- **Examples**: `dev-lambda-errors-cloudwatch-alarm`, `prod-dynamodb-throttles-cloudwatch-alarm`

### Cognito Resources

- **User Pools**: `[environment]-cognito-userpool-[random-suffix]`
- **Identity Pools**: `[environment]-cognito-identitypool-[random-suffix]`
- **Examples**: `dev-cognito-userpool-x4m9n`, `prod-cognito-identitypool-k7p2q`
- **Note**: Random suffix prevents resource enumeration attacks

### CloudFront Distributions

- **Format**: Environment-specific origins and behaviors with generic naming
- **Origin Domain**: Points to environment-specific S3 bucket or API Gateway
- **Comment**: `[Environment] CDN`
- **Examples**: `Dev CDN`, `Prod CDN`
- **Note**: Use generic terms to avoid exposing application details

### KMS Keys

- **Format**: kebab-case with environment and purpose
- **Examples**: `dev-dynamodb-kms-key`, `prod-s3-kms-key`
- **Pattern**: `[environment]-[purpose]-kms-key`
- **Aliases**: `alias/[environment]-[purpose]-kms`

### SNS Topics and SQS Queues

- **SNS Topics**: `[environment]-[purpose]-sns-topic`
- **SQS Queues**: `[environment]-[purpose]-sqs-queue`
- **Examples**: `dev-notifications-sns-topic`, `prod-processing-sqs-queue`

### ElastiCache Clusters

- **Format**: kebab-case with environment prefix
- **Examples**: `dev-redis-elasticache`, `prod-memcached-elasticache`
- **Pattern**: `[environment]-[cache-type]-elasticache`

### API Gateway and AppSync

- **API Names**: PascalCase with environment prefix and random suffix
- **Examples**: `dev-ApiGateway-x7k9m`, `prod-AppSyncGraphQL-p4n8q`
- **Resolvers**: PascalCase with environment prefix and field name
- **Examples**: `dev-GetUserDataAppSyncResolver`, `prod-AddUserItemAppSyncResolver`
- **Pattern**: `[environment]-[ApiGateway|AppSyncGraphQL]-[random-suffix]` for APIs, `[environment]-[FieldName]AppSyncResolver` for resolvers
- **Note**: Generic API names with random suffixes prevent enumeration

## VPC and Networking Resources

### VPC Resources

- **VPC Names**: kebab-case with environment prefix
- **Examples**: `dev-vpc`, `prod-vpc`
- **Pattern**: `[environment]-vpc`

### Subnets

- **Format**: kebab-case with environment and type
- **Examples**: `dev-private-subnet-1a`, `prod-public-subnet-1b`
- **Pattern**: `[environment]-[private|public]-subnet-[az]`

### Security Groups

- **Format**: kebab-case with environment and purpose
- **Examples**: `dev-lambda-sg`, `prod-alb-sg`
- **Pattern**: `[environment]-[purpose]-sg`

### NAT Gateways and Internet Gateways

- **NAT Gateway**: `[environment]-nat-gateway-[az]`
- **Internet Gateway**: `[environment]-igw`
- **Examples**: `dev-nat-gateway-1a`, `prod-igw`

### Route Tables

- **Format**: kebab-case with environment and type
- **Examples**: `dev-private-rt`, `prod-public-rt`
- **Pattern**: `[environment]-[private|public]-rt`

## Frontend Code

### React Components

- **Format**: PascalCase
- **Examples**: `DataPage`, `AddItemModal`, `UserRegistrationForm`
- **Pattern**: Descriptive component purpose with type suffix

### JavaScript/TypeScript Files

- **Components**: PascalCase (e.g., `DataPage.jsx`)
- **Utilities**: camelCase (e.g., `inputValidation.js`)
- **Services**: camelCase (e.g., `graphqlService.js`)
- **Hooks**: camelCase with "use" prefix (e.g., `useAuth.js`)

### CSS Classes and Modules

- **Format**: kebab-case with BEM methodology
- **Examples**: `data-page`, `add-item-modal__header`, `user-form--loading`
- **Files**: kebab-case (e.g., `data-page.module.css`)

### Variables and Functions

- **JavaScript**: camelCase (e.g., `getUserData`, `itemCollection`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `MAX_ITEMS_PER_PAGE`)
- **React Props**: camelCase (e.g., `onItemSelect`, `isLoading`)

## Backend Code

Language-specific backend naming conventions (functions, variables, constants, classes) are defined in the `lang-*.md` steering files loaded per agent variant.

## GraphQL Schema

- **Types**: PascalCase (e.g., `UserData`, `ItemStatus`)
- **Fields**: camelCase (e.g., `itemKey`, `statusValue`)
- **Queries**: camelCase with descriptive verb (e.g., `getUserData`, `searchItems`)
- **Mutations**: camelCase with action verb (e.g., `addUserItem`, `updateUser`)
- **Input Types**: PascalCase with Input suffix (e.g., `UserDataInput`)

## Environment and Configuration

### Environment Variables

- **Format**: UPPER_SNAKE_CASE
- **Examples**: `REACT_APP_API_URL`, `DYNAMODB_TABLE_NAME`
- **Pattern**: Clear indication of purpose and scope

### Parameter Store Keys

- **Format**: kebab-case with hierarchy
- **Examples**: `/[environment]/api-url`, `/[environment]/database-name`
- **Pattern**: `/[environment]/[parameter-name]`

### Secret Manager Keys

- **Format**: kebab-case with descriptive purpose
- **Examples**: `[environment]-api-keys`, `[environment]-database-credentials`
- **Pattern**: `[environment]-[secret-type]`

## API and Integration Patterns

### REST API Endpoints

- **Format**: kebab-case with HTTP verbs
- **Examples**:
  - `GET /api/users`
  - `POST /api/users`
  - `GET /api/users/{id}`
  - `PUT /api/users/{id}`
  - `DELETE /api/users/{id}`
  - `GET /api/users/{id}/orders`
- **Pattern**: `/api/[resource-plural]/[{id}]/[sub-resource-plural]`
- **Rules**:
  - Use plural nouns for collections
  - Use HTTP verbs, not action words in URLs
  - Use kebab-case for multi-word resources
  - Nest resources logically (max 2-3 levels)

### GraphQL Operations

- **Queries**: camelCase with descriptive verb (e.g., `getUserData`, `searchItems`)
- **Mutations**: camelCase with action verb (e.g., `addUserItem`, `updateUser`, `deleteItem`)
- **Subscriptions**: camelCase with "on" prefix (e.g., `onUserUpdated`, `onItemCreated`)
- **Types**: PascalCase (e.g., `UserData`, `ItemStatus`)
- **Input Types**: PascalCase with Input suffix (e.g., `UserDataInput`, `ItemFilterInput`)

### Event Names

- **Format**: PascalCase with domain prefix
- **EventBridge**: `[Domain].[Entity].[Action]`
- **Examples**:
  - `User.Created`
  - `Order.Completed`
  - `Payment.Failed`
  - `Inventory.Updated`
- **SNS Topics**: `[environment]-[domain]-[event-type]-sns-topic`
- **SQS Queues**: `[environment]-[domain]-[event-type]-sqs-queue`

## Error Handling and Logging

### Error Codes

- **Format**: UPPER_SNAKE_CASE with domain prefix
- **Examples**:
  - `AUTH_INVALID_CREDENTIALS`
  - `USER_NOT_FOUND`
  - `PAYMENT_INSUFFICIENT_FUNDS`
  - `VALIDATION_MISSING_FIELD`
- **Pattern**: `[DOMAIN]_[ERROR_TYPE]`
- **HTTP Status Mapping**:
  - 400: `VALIDATION_*`, `REQUEST_*`
  - 401: `AUTH_*`
  - 403: `PERMISSION_*`
  - 404: `*_NOT_FOUND`
  - 500: `INTERNAL_*`, `SERVICE_*`

### Log Message Patterns

- **Format**: Structured with consistent fields
- **Required Fields**: timestamp, level, service, message, context
- **Examples**:
  ```json
  {
    "timestamp": "2026-02-19T11:22:00Z",
    "level": "ERROR",
    "service": "user-service",
    "message": "Failed to authenticate user",
    "context": {
      "userId": "user-123",
      "errorCode": "AUTH_INVALID_CREDENTIALS",
      "requestId": "req-456"
    }
  }
  ```
- **Log Levels**: ERROR, WARN, INFO, DEBUG
- **Message Format**: Start with action verb, be specific and actionable

## File and Directory Structure

### Directory Names

- **Format**: kebab-case or camelCase (consistent within scope)
- **Examples**: `lambda-resolvers`, `react/src/components`
- **Pattern**: Descriptive of contents and purpose

### Test Files

- **Unit Tests**: `ComponentName.test.jsx`, `function_name.test.py`
- **Integration Tests**: `ComponentName.integration.test.jsx`
- **E2E Tests**: `feature-name.e2e.test.js`
- **Unit Tests (.NET)**: `{Module}Tests.cs`
- **Integration Tests (.NET)**: `{Module}IntegrationTests.cs`

### Documentation Files

- **Format**: kebab-case with .md extension
- **Examples**: `naming-conventions.md`, `api-standards.md`
- **Pattern**: Descriptive of document purpose

## Version Control

### Branch Names

- **Format**: kebab-case with type prefix
- **Examples**: `feature/user-authentication`, `bugfix/data-search`
- **Pattern**: `[type]/[descriptive-name]`

### Commit Messages

- **Format**: Conventional Commits
- **Examples**: `feat: add user authentication`, `fix: resolve data search bug`
- **Pattern**: `[type]: [description]`

### Tag Names

- **Format**: Semantic versioning
- **Examples**: `v1.0.0`, `v1.2.3-beta`
- **Pattern**: `v[major].[minor].[patch][-prerelease]`

## Security Considerations

### Public-Facing Resources

- **S3 Buckets**: Add random suffix for public buckets to prevent enumeration
- **CloudFront**: Use generic distribution names (CDN vs Distribution)
- **API Gateway**: Avoid exposing internal structure in names, use random suffixes
- **Cognito**: Add random suffixes to prevent resource enumeration attacks

### Sensitive Resources

- **KMS Keys**: Use aliases that don't reveal encryption scope details
- **IAM Roles**: Balance descriptiveness with operational security
- **Lambda Functions**: Consider generic names for security-sensitive functions
- **Database Names**: Avoid revealing data structure in public-facing names

### OPSEC Guidelines

- **Avoid Sequential Numbering**: Use random suffixes instead of predictable patterns
- **Generic Terms**: Use "API", "CDN", "Service" instead of specific business terms
- **Environment Indicators**: Use less obvious environment indicators for public resources
- **Information Disclosure**: Minimize architecture details exposed through naming

### Random Suffix Generation

- **Format**: 5-character alphanumeric (lowercase)
- **Pattern**: `[a-z0-9]{5}` (e.g., `x7k9m`, `a4n8p`)
- **Usage**: Required for public buckets, APIs, and authentication resources
- **Exclusions**: Avoid confusing characters (0/o, 1/l, etc.)

## Anti-Patterns to Avoid

### Naming Anti-Patterns

- Abbreviations without clear meaning (e.g., `usr` instead of `user`)
- Inconsistent casing within the same scope
- Generic names that don't indicate purpose (e.g., `data`, `info`)
- Numbers in names without clear meaning (e.g., `table1`, `function2`)
- Mixing naming conventions within the same file or component

### Resource Naming Anti-Patterns

- Environment-specific names in reusable templates
- Hardcoded names that prevent multiple deployments
- Names that don't follow AWS service naming constraints
- Inconsistent prefixes across related resources
- Names that expose sensitive information or internal structure
- **Missing environment prefixes** that cause resource conflicts
- **Shared resources** between environments (except intentional cross-environment resources)
- **Hardcoded environment values** in template files (use parameters instead)
- **Missing random suffixes** for public-facing resources (security risk)
- **Predictable naming patterns** that enable resource enumeration
- **Exposing business logic** in public resource names
