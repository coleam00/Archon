#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
S3.5 Remediation: S3 general purpose buckets should require requests to use SSL
IAM-Safe approach: Additive policy enhancement, preserves existing permissions
"""

import boto3
import json
import argparse
from datetime import datetime
from botocore.exceptions import ClientError

def verify_s3_ssl_compliance(bucket_name, s3_client):
    """Verify that S3 bucket has SSL-only policy enforced"""
    try:
        try:
            policy_response = s3_client.get_bucket_policy(Bucket=bucket_name)
            policy_doc = json.loads(policy_response['Policy'])
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchBucketPolicy':
                return {
                    'overall_compliant': False,
                    'error': 'No bucket policy found - SSL enforcement requires bucket policy',
                    'verification_timestamp': datetime.now().isoformat()
                }
            raise
        
        # Check for SSL-only policy statement
        ssl_policy_found = False
        for statement in policy_doc.get('Statement', []):
            if (statement.get('Effect') == 'Deny' and 
                'aws:SecureTransport' in statement.get('Condition', {}).get('Bool', {}) and
                statement['Condition']['Bool']['aws:SecureTransport'] == 'false'):
                ssl_policy_found = True
                break
        
        return {
            'overall_compliant': ssl_policy_found,
            'settings': {
                'ssl_policy_present': {
                    'required': True,
                    'actual': ssl_policy_found,
                    'compliant': ssl_policy_found
                }
            },
            'verification_timestamp': datetime.now().isoformat()
        }
        
    except Exception as e:
        return {
            'overall_compliant': False,
            'error': f'Verification failed: {str(e)}',
            'verification_timestamp': datetime.now().isoformat()
        }

def update_security_hub_finding_status(finding_arn, status, note, profile_name, region):
    """Update Security Hub finding status to RESOLVED"""
    try:
        session = boto3.Session(profile_name=profile_name)
        securityhub = session.client('securityhub', region_name=region)
        
        findings_response = securityhub.get_findings(
            Filters={'Id': [{'Value': finding_arn, 'Comparison': 'EQUALS'}]}
        )
        
        if not findings_response.get('Findings'):
            raise ValueError(f"Finding not found: {finding_arn}")
        
        finding = findings_response['Findings'][0]
        product_arn = finding.get('ProductArn')
        
        if not product_arn:
            raise ValueError(f"ProductArn not found in finding: {finding_arn}")
        
        response = securityhub.batch_update_findings(
            FindingIdentifiers=[{'Id': finding_arn, 'ProductArn': product_arn}],
            Workflow={'Status': status},
            Note={'Text': note, 'UpdatedBy': 'Security Compliance Remediation Framework'}
        )
        
        return {'success': True, 'finding_arn': finding_arn, 'new_status': status}
        
    except Exception as e:
        return {'success': False, 'finding_arn': finding_arn, 'error': f'Security Hub update failed: {str(e)}'}

def remediate_s3_ssl_enforcement_iam_safe(bucket_name, profile_name, region, dry_run=False, finding_arn=None):
    """
    IAM-Safe S3.5 remediation: Adds SSL-only statement to existing bucket policy
    Preserves all existing policy statements and permissions
    """
    
    try:
        session = boto3.Session(profile_name=profile_name)
        s3 = session.client('s3', region_name=region)
        
        # Check if bucket exists
        try:
            s3.head_bucket(Bucket=bucket_name)
        except Exception as e:
            if 'NoSuchBucket' in str(e) or '404' in str(e):
                return {
                    'bucket_name': bucket_name,
                    'control_id': 'S3.5',
                    'status': 'ERROR',
                    'message': f'Bucket {bucket_name} does not exist',
                    'timestamp': datetime.now().isoformat()
                }
            raise
        
        # IAM-SAFE: Get existing bucket policy and preserve it
        existing_policy = None
        try:
            policy_response = s3.get_bucket_policy(Bucket=bucket_name)
            existing_policy = json.loads(policy_response['Policy'])
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchBucketPolicy':
                # No existing policy - create new one
                existing_policy = {"Version": "2012-10-17", "Statement": []}
            else:
                raise
        
        # Check if SSL-only statement already exists
        ssl_policy_exists = False
        ssl_statement_sid = "DenyHTTPRequests"
        
        for statement in existing_policy.get('Statement', []):
            if (statement.get('Sid') == ssl_statement_sid or
                (statement.get('Effect') == 'Deny' and 
                 'aws:SecureTransport' in statement.get('Condition', {}).get('Bool', {}) and
                 statement['Condition']['Bool']['aws:SecureTransport'] == 'false')):
                ssl_policy_exists = True
                break
        
        result = {
            'bucket_name': bucket_name,
            'control_id': 'S3.5',
            'timestamp': datetime.now().isoformat(),
            'needs_remediation': not ssl_policy_exists,
            'existing_statements_count': len(existing_policy.get('Statement', [])),
            'iam_safe_approach': True
        }
        
        if ssl_policy_exists:
            result['status'] = 'COMPLIANT'
            result['message'] = f'Bucket {bucket_name} already has SSL-only policy enforced'
            
            verification = verify_s3_ssl_compliance(bucket_name, s3)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'S3.5 compliance verified: Bucket {bucket_name} has SSL-only policy enforced (IAM-Safe validation)',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would add SSL-only statement to existing policy with {result["existing_statements_count"]} statements'
            return result
        
        # IAM-SAFE: Create SSL-only statement to ADD to existing policy
        ssl_statement = {
            "Sid": ssl_statement_sid,
            "Effect": "Deny",
            "Principal": "*",
            "Action": "s3:*",
            "Resource": [
                f"arn:aws:s3:::{bucket_name}/*",
                f"arn:aws:s3:::{bucket_name}"
            ],
            "Condition": {
                "Bool": {
                    "aws:SecureTransport": "false"
                }
            }
        }
        
        # IAM-SAFE: ADD statement to existing policy (preserve all existing statements)
        if 'Statement' not in existing_policy:
            existing_policy['Statement'] = []
        
        # Preserve existing statements and add new SSL statement
        updated_policy = existing_policy.copy()
        updated_policy['Statement'].append(ssl_statement)
        
        # Apply updated policy with preserved existing statements
        s3.put_bucket_policy(
            Bucket=bucket_name,
            Policy=json.dumps(updated_policy)
        )
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'IAM-Safe: Added SSL-only statement to existing policy (preserved {result["existing_statements_count"]} existing statements)'
        result['added_statement'] = ssl_statement
        result['final_statements_count'] = len(updated_policy['Statement'])
        
        # Verify remediation was successful
        verification = verify_s3_ssl_compliance(bucket_name, s3)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'S3.5 remediation completed (IAM-Safe): Added SSL-only statement to bucket {bucket_name} policy while preserving existing permissions',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'SSL statement added but verification failed for bucket {bucket_name}'
        
        return result
        
    except Exception as e:
        return {
            'bucket_name': bucket_name,
            'control_id': 'S3.5',
            'status': 'ERROR',
            'message': f'IAM-Safe remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='S3.5 SSL Enforcement Remediation (IAM-Safe)')
    parser.add_argument('--bucket-name', required=True, help='S3 bucket name to remediate')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 S3.5 Remediation: SSL Enforcement (IAM-Safe)")
    print(f"Bucket: {args.bucket_name}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    result = remediate_s3_ssl_enforcement_iam_safe(
        bucket_name=args.bucket_name,
        profile_name=args.profile,
        region=args.region,
        dry_run=args.dry_run,
        finding_arn=args.finding_id
    )
    
    status_icons = {
        'COMPLIANT': '✅',
        'REMEDIATED': '✅',
        'DRY_RUN': '🔍',
        'ERROR': '❌',
        'REMEDIATION_FAILED': '⚠️'
    }
    
    icon = status_icons.get(result['status'], '❓')
    print(f"{icon} {result['status']}: {result['message']}")
    
    if result.get('existing_statements_count') is not None:
        print(f"📋 Existing policy statements: {result['existing_statements_count']}")
    
    if result.get('final_statements_count'):
        print(f"📋 Final policy statements: {result['final_statements_count']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: S3.5 SSL enforcement confirmed (IAM-Safe)")
        else:
            print(f"\n❌ VERIFICATION: S3.5 SSL enforcement failed")
            if verification.get('error'):
                print(f"   Error: {verification['error']}")
    
    if result.get('security_hub_update'):
        hub_update = result['security_hub_update']
        if hub_update.get('success'):
            print(f"\n🔗 SECURITY HUB: Finding marked as RESOLVED")
        else:
            print(f"\n❌ SECURITY HUB: Update failed - {hub_update.get('error')}")
    
    return 0 if result['status'] in ['COMPLIANT', 'REMEDIATED'] else 1

if __name__ == '__main__':
    exit(main())
