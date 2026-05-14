#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
S3.17 Remediation: S3 general purpose buckets should be encrypted at rest with AWS KMS keys
IAM-Safe approach: Enable KMS encryption while preserving existing bucket configuration
"""

import boto3
import json
import argparse
from datetime import datetime
from botocore.exceptions import ClientError

def verify_s3_kms_encryption_compliance(s3_client, bucket_name):
    """Verify that S3 bucket has KMS encryption enabled"""
    try:
        encryption_response = s3_client.get_bucket_encryption(Bucket=bucket_name)
        encryption_config = encryption_response.get('ServerSideEncryptionConfiguration', {})
        rules = encryption_config.get('Rules', [])
        
        has_kms_encryption = False
        for rule in rules:
            sse_config = rule.get('ApplyServerSideEncryptionByDefault', {})
            if sse_config.get('SSEAlgorithm') == 'aws:kms':
                has_kms_encryption = True
                break
        
        return {
            'overall_compliant': has_kms_encryption,
            'settings': {
                'kms_encryption': {
                    'required': True,
                    'actual': has_kms_encryption,
                    'compliant': has_kms_encryption,
                    'encryption_rules': len(rules)
                }
            },
            'verification_timestamp': datetime.now().isoformat()
        }
        
    except ClientError as e:
        if e.response['Error']['Code'] == 'ServerSideEncryptionConfigurationNotFoundError':
            return {
                'overall_compliant': False,
                'settings': {
                    'kms_encryption': {
                        'required': True,
                        'actual': False,
                        'compliant': False,
                        'encryption_rules': 0
                    }
                },
                'verification_timestamp': datetime.now().isoformat()
            }
        else:
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
        
        response = securityhub.batch_update_findings(
            FindingIdentifiers=[{'Id': finding_arn, 'ProductArn': product_arn}],
            Workflow={'Status': status},
            Note={'Text': note, 'UpdatedBy': 'Security Compliance Remediation Framework'}
        )
        
        return {'success': True, 'finding_arn': finding_arn, 'new_status': status}
        
    except Exception as e:
        return {'success': False, 'finding_arn': finding_arn, 'error': f'Security Hub update failed: {str(e)}'}

def remediate_s3_kms_encryption_iam_safe(bucket_name, profile_name, region, dry_run=False, finding_arn=None):
    """
    IAM-Safe S3.17 remediation: Enable KMS encryption while preserving existing configuration
    """
    
    try:
        session = boto3.Session(profile_name=profile_name)
        s3 = session.client('s3', region_name=region)
        
        # Check if bucket exists
        try:
            s3.head_bucket(Bucket=bucket_name)
        except ClientError as e:
            return {
                'control_id': 'S3.17',
                'bucket_name': bucket_name,
                'status': 'ERROR',
                'message': f'Bucket {bucket_name} not accessible: {str(e)}',
                'timestamp': datetime.now().isoformat()
            }
        
        # IAM-SAFE: Check existing encryption configuration
        try:
            encryption_response = s3.get_bucket_encryption(Bucket=bucket_name)
            existing_config = encryption_response.get('ServerSideEncryptionConfiguration', {})
            existing_rules = existing_config.get('Rules', [])
            
            # Check if KMS encryption already exists
            has_kms = any(
                rule.get('ApplyServerSideEncryptionByDefault', {}).get('SSEAlgorithm') == 'aws:kms'
                for rule in existing_rules
            )
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'ServerSideEncryptionConfigurationNotFoundError':
                existing_rules = []
                has_kms = False
            else:
                raise
        
        result = {
            'control_id': 'S3.17',
            'bucket_name': bucket_name,
            'timestamp': datetime.now().isoformat(),
            'existing_kms_encryption': has_kms,
            'existing_rules_count': len(existing_rules),
            'iam_safe_approach': True
        }
        
        if has_kms:
            result['status'] = 'COMPLIANT'
            result['message'] = f'Bucket {bucket_name} already has KMS encryption enabled'
            result['needs_remediation'] = False
            
            verification = verify_s3_kms_encryption_compliance(s3, bucket_name)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'S3.17 compliance verified: Bucket {bucket_name} already has KMS encryption (IAM-Safe validation)',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would enable KMS encryption for bucket {bucket_name}'
            return result
        
        # IAM-SAFE: Enable KMS encryption (preserve existing rules if any)
        encryption_config = {
            'Rules': [
                {
                    'ApplyServerSideEncryptionByDefault': {
                        'SSEAlgorithm': 'aws:kms',
                        'KMSMasterKeyID': 'alias/aws/s3'  # Use AWS managed S3 KMS key
                    },
                    'BucketKeyEnabled': True  # Enable S3 Bucket Key for cost optimization
                }
            ]
        }
        
        # If there were existing rules, preserve them alongside KMS
        if existing_rules:
            # Add existing rules that aren't KMS (preserve AES256 if present)
            for rule in existing_rules:
                sse_config = rule.get('ApplyServerSideEncryptionByDefault', {})
                if sse_config.get('SSEAlgorithm') != 'aws:kms':
                    encryption_config['Rules'].append(rule)
        
        s3.put_bucket_encryption(
            Bucket=bucket_name,
            ServerSideEncryptionConfiguration=encryption_config
        )
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'IAM-Safe: Enabled KMS encryption for bucket {bucket_name} using AWS managed S3 key'
        result['needs_remediation'] = True
        result['kms_key'] = 'alias/aws/s3'
        
        # Verify remediation was successful
        verification = verify_s3_kms_encryption_compliance(s3, bucket_name)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'S3.17 remediation completed (IAM-Safe): Enabled KMS encryption for bucket {bucket_name} using AWS managed S3 key',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'KMS encryption enabled but verification failed for bucket {bucket_name}'
        
        return result
        
    except Exception as e:
        return {
            'control_id': 'S3.17',
            'bucket_name': bucket_name,
            'status': 'ERROR',
            'message': f'IAM-Safe remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='S3.17 KMS Encryption Remediation (IAM-Safe)')
    parser.add_argument('--bucket-name', required=True, help='S3 bucket name')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 S3.17 Remediation: KMS Encryption (IAM-Safe)")
    print(f"Bucket: {args.bucket_name}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    result = remediate_s3_kms_encryption_iam_safe(
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
    
    if result.get('existing_kms_encryption') is not None:
        print(f"📋 Previous KMS encryption: {result['existing_kms_encryption']}")
    
    if result.get('kms_key'):
        print(f"📋 KMS Key: {result['kms_key']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: S3.17 KMS encryption confirmed (IAM-Safe)")
        else:
            print(f"\n❌ VERIFICATION: S3.17 KMS encryption failed")
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
