# AWS Security Hub Controls Reference

Quick reference for common AWS Security Hub controls and their remediation patterns.

## Config Controls

### Config.1 - AWS Config should be enabled

**Finding:** AWS Config recorder is not enabled
**Impact:** Cannot track resource configuration changes
**Remediation:**
```bash
aws configservice put-configuration-recorder \
  --configuration-recorder name=default,roleARN=arn:aws:iam::ACCOUNT:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig \
  --recording-group allSupported=true,includeGlobalResourceTypes=true \
  --profile $PROFILE

aws configservice start-configuration-recorder \
  --configuration-recorder-name default \
  --profile $PROFILE
```

## IAM Controls

### IAM.1 - IAM policies should not allow full "*:*" administrative privileges

**Finding:** IAM policy grants full administrative access
**Impact:** Violates least privilege principle
**Remediation:**
1. Review policy document
2. Replace `"*"` actions with specific required actions
3. Replace `"*"` resources with specific ARNs
4. Create new policy version

### IAM.3 - IAM users' access keys should be rotated every 90 days or less

**Finding:** Access keys older than 90 days
**Impact:** Increased risk of credential compromise
**Remediation:**
```bash
# List old access keys
aws iam list-access-keys --user-name USERNAME --profile $PROFILE

# Create new key
aws iam create-access-key --user-name USERNAME --profile $PROFILE

# Update application configuration with new key

# Deactivate old key
aws iam update-access-key --user-name USERNAME --access-key-id KEYID --status Inactive --profile $PROFILE

# Delete old key after verification
aws iam delete-access-key --user-name USERNAME --access-key-id KEYID --profile $PROFILE
```

### IAM.4 - IAM root user access key should not exist

**Finding:** Root user has active access keys
**Impact:** Critical security risk
**Remediation:**
1. Log in as root user
2. Navigate to Security Credentials
3. Delete all root access keys
4. Use IAM users with MFA instead

## S3 Controls

### S3.1 - S3 Block Public Access setting should be enabled

**Finding:** S3 bucket allows public access
**Impact:** Data exposure risk
**Remediation:**
```bash
aws s3api put-public-access-block \
  --bucket BUCKET_NAME \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" \
  --profile $PROFILE
```

### S3.2 - S3 buckets should prohibit public read access

**Finding:** Bucket policy or ACL allows public read
**Impact:** Unauthorized data access
**Remediation:**
```bash
# Remove public read ACL
aws s3api put-bucket-acl --bucket BUCKET_NAME --acl private --profile $PROFILE

# Review and update bucket policy to remove public access
aws s3api get-bucket-policy --bucket BUCKET_NAME --profile $PROFILE
aws s3api put-bucket-policy --bucket BUCKET_NAME --policy file://updated-policy.json --profile $PROFILE
```

### S3.5 - S3 buckets should require requests to use SSL

**Finding:** Bucket policy doesn't enforce SSL/TLS
**Impact:** Data in transit not encrypted
**Remediation:**
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenyInsecureTransport",
    "Effect": "Deny",
    "Principal": "*",
    "Action": "s3:*",
    "Resource": [
      "arn:aws:s3:::BUCKET_NAME",
      "arn:aws:s3:::BUCKET_NAME/*"
    ],
    "Condition": {
      "Bool": {"aws:SecureTransport": "false"}
    }
  }]
}
```

### S3.8 - S3 Block Public Access setting should be enabled at the bucket level

**Finding:** Account-level block public access not enabled
**Impact:** New buckets may be created with public access
**Remediation:**
```bash
aws s3control put-public-access-block \
  --account-id ACCOUNT_ID \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" \
  --profile $PROFILE
```

## EC2 Controls

### EC2.2 - VPC default security group should not allow inbound and outbound traffic

**Finding:** Default security group has rules
**Impact:** Unintended network access
**Remediation:**
```bash
# Get default security group ID
SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=default" "Name=vpc-id,Values=VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text --profile $PROFILE)

# Remove all ingress rules
aws ec2 revoke-security-group-ingress --group-id $SG_ID --ip-permissions ... --profile $PROFILE

# Remove all egress rules
aws ec2 revoke-security-group-egress --group-id $SG_ID --ip-permissions ... --profile $PROFILE
```

## RDS Controls

### RDS.1 - RDS snapshots should be private

**Finding:** RDS snapshot is public
**Impact:** Database backup exposed
**Remediation:**
```bash
aws rds modify-db-snapshot-attribute \
  --db-snapshot-identifier SNAPSHOT_ID \
  --attribute-name restore \
  --values-to-remove all \
  --profile $PROFILE
```

### RDS.2 - RDS DB instances should prohibit public access

**Finding:** RDS instance is publicly accessible
**Impact:** Database exposed to internet
**Remediation:**
```bash
aws rds modify-db-instance \
  --db-instance-identifier DB_INSTANCE \
  --no-publicly-accessible \
  --apply-immediately \
  --profile $PROFILE
```

## Lambda Controls

### Lambda.1 - Lambda functions should prohibit public access

**Finding:** Lambda function policy allows public invocation
**Impact:** Unauthorized function execution
**Remediation:**
```bash
# Remove public access from function policy
aws lambda remove-permission \
  --function-name FUNCTION_NAME \
  --statement-id PUBLIC_STATEMENT_ID \
  --profile $PROFILE
```

### Lambda.2 - Lambda functions should use supported runtimes

**Finding:** Lambda using deprecated runtime
**Impact:** Security vulnerabilities, no updates
**Remediation:**
```bash
# Update function runtime
aws lambda update-function-configuration \
  --function-name FUNCTION_NAME \
  --runtime python3.12 \
  --profile $PROFILE
```

## KMS Controls

### KMS.1 - IAM customer managed policies should not allow decryption actions on all KMS keys

**Finding:** Policy allows kms:Decrypt on all keys
**Impact:** Excessive permissions
**Remediation:**
1. Review policy document
2. Replace `"Resource": "*"` with specific key ARNs
3. Create new policy version

### KMS.2 - IAM principals should not have IAM inline policies that allow decryption actions on all KMS keys

**Finding:** Inline policy with broad KMS permissions
**Impact:** Excessive permissions
**Remediation:**
```bash
# Get inline policy
aws iam get-user-policy --user-name USERNAME --policy-name POLICY_NAME --profile $PROFILE

# Delete inline policy
aws iam delete-user-policy --user-name USERNAME --policy-name POLICY_NAME --profile $PROFILE

# Create managed policy with restricted permissions
aws iam create-policy --policy-name RestrictedKMSPolicy --policy-document file://policy.json --profile $PROFILE
aws iam attach-user-policy --user-name USERNAME --policy-arn POLICY_ARN --profile $PROFILE
```

## CloudTrail Controls

### CloudTrail.1 - CloudTrail should be enabled and configured with at least one multi-Region trail

**Finding:** No multi-region CloudTrail trail
**Impact:** Incomplete audit logging
**Remediation:**
```bash
aws cloudtrail create-trail \
  --name multi-region-trail \
  --s3-bucket-name BUCKET_NAME \
  --is-multi-region-trail \
  --enable-log-file-validation \
  --profile $PROFILE

aws cloudtrail start-logging --name multi-region-trail --profile $PROFILE
```

## Severity Prioritization

**CRITICAL** - Remediate immediately:
- IAM.4 (Root access keys)
- S3.2 (Public read access)
- RDS.1 (Public snapshots)

**HIGH** - Remediate within 24 hours:
- IAM.1 (Full admin policies)
- S3.1 (Block public access)
- Lambda.1 (Public functions)

**MEDIUM** - Remediate within 7 days:
- IAM.3 (Key rotation)
- Config.1 (Config recorder)
- CloudTrail.1 (Multi-region trail)

**LOW** - Remediate within 30 days:
- Lambda.2 (Runtime updates)
- Documentation improvements
