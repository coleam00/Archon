#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
S3.6 Remediation: S3 general purpose buckets should have Lifecycle configurations
IAM-Safe approach: Additive lifecycle rules, preserves existing configurations
"""

import boto3
import json
import argparse
from datetime import datetime
from botocore.exceptions import ClientError

def verify_s3_lifecycle_compliance(bucket_name, s3_client):
    """Verify that S3 bucket has lifecycle configuration"""
    try:
        try:
            lifecycle_response = s3_client.get_bucket_lifecycle_configuration(Bucket=bucket_name)
            rules = lifecycle_response.get('Rules', [])
            has_lifecycle = len(rules) > 0
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchLifecycleConfiguration':
                has_lifecycle = False
            else:
                raise
        
        return {
            'overall_compliant': has_lifecycle,
            'settings': {
                'lifecycle_configuration': {
                    'required': True,
                    'actual': has_lifecycle,
                    'compliant': has_lifecycle
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

def remediate_s3_lifecycle_configuration_iam_safe(bucket_name, profile_name, region, dry_run=False, finding_arn=None):
    """
    IAM-Safe S3.6 remediation: Adds compliance lifecycle rule to existing configuration
    Preserves all existing lifecycle rules
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
                    'control_id': 'S3.6',
                    'status': 'ERROR',
                    'message': f'Bucket {bucket_name} does not exist',
                    'timestamp': datetime.now().isoformat()
                }
            raise
        
        # IAM-SAFE: Get existing lifecycle configuration and preserve it
        existing_rules = []
        try:
            lifecycle_response = s3.get_bucket_lifecycle_configuration(Bucket=bucket_name)
            existing_rules = lifecycle_response.get('Rules', [])
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchLifecycleConfiguration':
                existing_rules = []  # No existing configuration
            else:
                raise
        
        # Check if any lifecycle rules exist (compliance requirement)
        has_lifecycle = len(existing_rules) > 0
        compliance_rule_id = "SecurityComplianceLifecycleRule"
        
        # Check if our compliance rule already exists
        compliance_rule_exists = any(rule.get('ID') == compliance_rule_id for rule in existing_rules)
        
        result = {
            'bucket_name': bucket_name,
            'control_id': 'S3.6',
            'timestamp': datetime.now().isoformat(),
            'needs_remediation': not has_lifecycle,
            'existing_rules_count': len(existing_rules),
            'iam_safe_approach': True
        }
        
        if has_lifecycle:
            result['status'] = 'COMPLIANT'
            result['message'] = f'Bucket {bucket_name} already has lifecycle configuration ({len(existing_rules)} rules)'
            
            verification = verify_s3_lifecycle_compliance(bucket_name, s3)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'S3.6 compliance verified: Bucket {bucket_name} has lifecycle configuration (IAM-Safe validation)',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would add compliance lifecycle rule to existing configuration ({len(existing_rules)} existing rules)'
            return result
        
        # IAM-SAFE: Create compliance lifecycle rule to ADD to existing rules
        compliance_rule = {
            'ID': compliance_rule_id,
            'Status': 'Enabled',
            'Filter': {'Prefix': ''},
            'Transitions': [
                {
                    'Days': 30,
                    'StorageClass': 'STANDARD_IA'
                },
                {
                    'Days': 90,
                    'StorageClass': 'GLACIER'
                }
            ],
            'AbortIncompleteMultipartUpload': {
                'DaysAfterInitiation': 7
            }
        }
        
        # IAM-SAFE: Preserve existing rules and add compliance rule
        updated_rules = existing_rules.copy()
        
        # Only add compliance rule if it doesn't already exist
        if not compliance_rule_exists:
            updated_rules.append(compliance_rule)
        
        lifecycle_config = {'Rules': updated_rules}
        
        # Apply updated lifecycle configuration with preserved existing rules
        s3.put_bucket_lifecycle_configuration(
            Bucket=bucket_name,
            LifecycleConfiguration=lifecycle_config
        )
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'IAM-Safe: Added compliance lifecycle rule (preserved {len(existing_rules)} existing rules)'
        result['added_rule'] = compliance_rule
        result['final_rules_count'] = len(updated_rules)
        
        # Verify remediation was successful
        verification = verify_s3_lifecycle_compliance(bucket_name, s3)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'S3.6 remediation completed (IAM-Safe): Added compliance lifecycle rule to bucket {bucket_name} while preserving existing rules',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'Lifecycle rule added but verification failed for bucket {bucket_name}'
        
        return result
        
    except Exception as e:
        return {
            'bucket_name': bucket_name,
            'control_id': 'S3.6',
            'status': 'ERROR',
            'message': f'IAM-Safe remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='S3.6 Lifecycle Configuration Remediation (IAM-Safe)')
    parser.add_argument('--bucket-name', required=True, help='S3 bucket name to remediate')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 S3.6 Remediation: Lifecycle Configuration (IAM-Safe)")
    print(f"Bucket: {args.bucket_name}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    result = remediate_s3_lifecycle_configuration_iam_safe(
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
    
    if result.get('existing_rules_count') is not None:
        print(f"📋 Existing lifecycle rules: {result['existing_rules_count']}")
    
    if result.get('final_rules_count'):
        print(f"📋 Final lifecycle rules: {result['final_rules_count']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: S3.6 lifecycle configuration confirmed (IAM-Safe)")
        else:
            print(f"\n❌ VERIFICATION: S3.6 lifecycle configuration failed")
    
    if result.get('security_hub_update'):
        hub_update = result['security_hub_update']
        if hub_update.get('success'):
            print(f"\n🔗 SECURITY HUB: Finding marked as RESOLVED")
        else:
            print(f"\n❌ SECURITY HUB: Update failed - {hub_update.get('error')}")
    
    return 0 if result['status'] in ['COMPLIANT', 'REMEDIATED'] else 1

if __name__ == '__main__':
    exit(main())
