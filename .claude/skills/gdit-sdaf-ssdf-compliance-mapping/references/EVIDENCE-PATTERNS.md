# Evidence Collection Patterns by Platform

When documenting evidence and validation commands in compliance mappings, use these patterns based on the project's CI/CD platform.

## AWS CodePipeline / CodeBuild

```bash
# Retrieve scan reports from S3 artifact bucket
aws s3 cp s3://{bucket}/SecurityReports/{build-id}/{report}.json -

# Verify pipeline stage status
aws codepipeline get-pipeline-state --name {pipeline} | jq '.stageStates[] | select(.stageName=="{stage}")'

# Check Security Hub findings
aws securityhub get-findings --filters '{"ProductFields":[{"Key":"PipelineName","Value":"{pipeline}","Comparison":"EQUALS"}]}'

# Verify IAM least privilege
aws iam get-role-policy --role-name {role} --policy-name {policy}

# Verify S3 encryption
aws s3api get-bucket-encryption --bucket {bucket}

# Verify VPC isolation
aws codebuild batch-get-projects --names {project} | jq '.projects[0].vpcConfig'

# CloudFormation drift detection
aws cloudformation detect-stack-drift --stack-name {stack}

# Verify approval gate
aws codepipeline get-pipeline --name {pipeline} | jq '.pipeline.stages[] | select(.name=="Approval")'
```

## GitLab CI

```bash
# Retrieve job artifacts
curl --header "PRIVATE-TOKEN: $TOKEN" "https://{gitlab}/api/v4/projects/{id}/jobs/{job_id}/artifacts"

# List security findings (Ultimate tier)
curl --header "PRIVATE-TOKEN: $TOKEN" "https://{gitlab}/api/v4/projects/{id}/vulnerability_findings"

# Check MR approval status
curl --header "PRIVATE-TOKEN: $TOKEN" "https://{gitlab}/api/v4/projects/{id}/merge_requests/{mr_id}/approvals"

# Pipeline status
curl --header "PRIVATE-TOKEN: $TOKEN" "https://{gitlab}/api/v4/projects/{id}/pipelines/{pipeline_id}"

# Download SAST report
curl --header "PRIVATE-TOKEN: $TOKEN" "https://{gitlab}/api/v4/projects/{id}/jobs/artifacts/{branch}/download?job={job_name}"
```

## GitHub Actions

```bash
# List workflow run artifacts
gh api repos/{owner}/{repo}/actions/runs/{run_id}/artifacts

# Download artifact
gh run download {run_id} -n {artifact_name}

# Check branch protection (review requirements)
gh api repos/{owner}/{repo}/branches/{branch}/protection

# View SARIF results (code scanning)
gh api repos/{owner}/{repo}/code-scanning/alerts

# Check Dependabot alerts
gh api repos/{owner}/{repo}/dependabot/alerts
```

## Azure DevOps

```bash
# List build artifacts
az pipelines runs artifact list --run-id {run_id}

# Download artifact
az pipelines runs artifact download --run-id {run_id} --artifact-name {name}

# Check pipeline status
az pipelines runs show --id {run_id}

# List branch policies (review requirements)
az repos policy list --repository-id {repo_id} --branch {branch}
```

## Universal (Any Platform)

```bash
# Verify GPG signatures
gpg --verify {file}.asc {file}

# Verify SHA-256 checksums
sha256sum -c checksums.txt

# Check SBOM contents
cat sbom.json | jq '.components | length'

# Verify no secrets in codebase
gitleaks detect --source . --no-git --verbose

# Run SAST scan
semgrep --config=auto --severity=ERROR --json .

# Verify IaC security
checkov -d infrastructure/ --framework cloudformation --output json
```
