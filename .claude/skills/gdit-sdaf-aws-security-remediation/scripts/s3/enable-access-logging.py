#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
S3.9 Remediation: S3 general purpose buckets should have server access logging enabled
IAM-Safe approach: Only enable if not already configured, preserve existing logging configuration
"""

import boto3
import json
import argparse
import time
from datetime import datetime
from botocore.exceptions import ClientError

def verify_s3_access_logging_compliance(bucket_name, s3_client):
    """Verify that S3 bucket has server access logging enabled"""
    try:
        try:
            logging_response = s3_client.get_bucket_logging(Bucket=bucket_name)
            logging_config = logging_response.get('LoggingEnabled', {})
            
            has_logging = bool(logging_config.get('TargetBucket'))
            
            return {
                'overall_compliant': has_logging,
                'settings': {
                    'access_logging': {
                        'required': True,
                        'actual': has_logging,
                        'compliant': has_logging,
                        'target_bucket': logging_config.get('TargetBucket', 'None'),
                        'target_prefix': logging_config.get('TargetPrefix', 'None')
                    }
                },
                'verification_timestamp': datetime.now().isoformat()
            }
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchBucket':
                return {
                    'overall_compliant': False,
                    'error': 'Bucket does not exist',
                    'verification_timestamp': datetime.now().isoformat()
                }
            else:
                # No logging configuration is considered non-compliant
                return {
                    'overall_compliant': False,
                    'settings': {
                        'access_logging': {
                            'required': True,
                            'actual': False,
                            'compliant': False
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

def remediate_s3_access_logging_iam_safe(bucket_name, profile_name, region, dry_run=False, finding_arn=None):
    """
    IAM-Safe S3.9 remediation: Only enable logging if not already configured
    Preserves existing logging configuration if present
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
                    'control_id': 'S3.9',
                    'status': 'ERROR',
                    'message': f'Bucket {bucket_name} does not exist',
                    'timestamp': datetime.now().isoformat()
                }
            raise
        
        # IAM-SAFE: Get existing logging configuration and preserve it
        existing_logging = {}
        has_existing_logging = False
        
        try:
            logging_response = s3.get_bucket_logging(Bucket=bucket_name)
            existing_logging = logging_response.get('LoggingEnabled', {})
            has_existing_logging = bool(existing_logging.get('TargetBucket'))
        except ClientError as e:
            # No existing logging configuration
            existing_logging = {}
            has_existing_logging = False
        
        result = {
            'bucket_name': bucket_name,
            'control_id': 'S3.9',
            'timestamp': datetime.now().isoformat(),
            'needs_remediation': not has_existing_logging,
            'existing_logging': existing_logging,
            'iam_safe_approach': True
        }
        
        if has_existing_logging:
            result['status'] = 'COMPLIANT'
            result['message'] = f'Bucket {bucket_name} already has server access logging enabled (Target: {existing_logging.get("TargetBucket")})'
            
            verification = verify_s3_access_logging_compliance(bucket_name, s3)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'S3.9 compliance verified: Bucket {bucket_name} has server access logging enabled (IAM-Safe validation)',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would enable server access logging on bucket {bucket_name} (no existing logging found)'
            return result
        
        # IAM-SAFE: Create logging bucket name (use existing pattern if available)
        logging_bucket_name = f"{bucket_name}-access-logs"
        
        # Check if logging bucket exists, create if needed
        logging_bucket_created = False
        try:
            s3.head_bucket(Bucket=logging_bucket_name)
        except ClientError as e:
            if e.response['Error']['Code'] in ['NoSuchBucket', '404']:
                # Create logging bucket
                try:
                    if region == 'us-east-1':
                        s3.create_bucket(Bucket=logging_bucket_name)
                    else:
                        s3.create_bucket(
                            Bucket=logging_bucket_name,
                            CreateBucketConfiguration={'LocationConstraint': region}
                        )
                    
                    logging_bucket_created = True
                    
                    # Wait a moment for bucket to be available
                    time.sleep(2)
                    
                    # Enable versioning on logging bucket
                    s3.put_bucket_versioning(
                        Bucket=logging_bucket_name,
                        VersioningConfiguration={'Status': 'Enabled'}
                    )
                    
                except ClientError as create_error:
                    if create_error.response['Error']['Code'] == 'BucketAlreadyExists':
                        # Bucket exists but we don't have access - use alternative naming
                        logging_bucket_name = f"{bucket_name}-logs-{datetime.now().strftime('%Y%m%d%H%M')}"
                        try:
                            if region == 'us-east-1':
                                s3.create_bucket(Bucket=logging_bucket_name)
                            else:
                                s3.create_bucket(
                                    Bucket=logging_bucket_name,
                                    CreateBucketConfiguration={'LocationConstraint': region}
                                )
                            logging_bucket_created = True
                            time.sleep(2)
                        except Exception as alt_error:
                            return {
                                'bucket_name': bucket_name,
                                'control_id': 'S3.9',
                                'status': 'ERROR',
                                'message': f'Failed to create logging bucket: {str(alt_error)}',
                                'timestamp': datetime.now().isoformat()
                            }
                    else:
                        return {
                            'bucket_name': bucket_name,
                            'control_id': 'S3.9',
                            'status': 'ERROR',
                            'message': f'Failed to create logging bucket: {str(create_error)}',
                            'timestamp': datetime.now().isoformat()
                        }
        
        # IAM-SAFE: Enable server access logging
        logging_config = {
            'LoggingEnabled': {
                'TargetBucket': logging_bucket_name,
                'TargetPrefix': f'access-logs/{bucket_name}/'
            }
        }
        
        s3.put_bucket_logging(
            Bucket=bucket_name,
            BucketLoggingStatus=logging_config
        )
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'IAM-Safe: Enabled server access logging on bucket {bucket_name} (Target: {logging_bucket_name})'
        result['applied_config'] = logging_config
        result['logging_bucket'] = logging_bucket_name
        
        # Verify remediation was successful
        verification = verify_s3_access_logging_compliance(bucket_name, s3)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'S3.9 remediation completed (IAM-Safe): Enabled server access logging on bucket {bucket_name} with target bucket {logging_bucket_name}',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'Server access logging configured but verification failed for bucket {bucket_name}'
        
        return result
        
    except Exception as e:
        return {
            'bucket_name': bucket_name,
            'control_id': 'S3.9',
            'status': 'ERROR',
            'message': f'IAM-Safe remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='S3.9 Server Access Logging Remediation (IAM-Safe)')
    parser.add_argument('--bucket-name', required=True, help='S3 bucket name to remediate')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 S3.9 Remediation: Server Access Logging (IAM-Safe)")
    print(f"Bucket: {args.bucket_name}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    result = remediate_s3_access_logging_iam_safe(
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
    
    if result.get('existing_logging'):
        existing = result['existing_logging']
        if existing.get('TargetBucket'):
            print(f"📋 Existing logging: {existing['TargetBucket']}/{existing.get('TargetPrefix', '')}")
    
    if result.get('logging_bucket'):
        print(f"📋 Logging bucket: {result['logging_bucket']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: S3.9 server access logging confirmed (IAM-Safe)")
            settings = verification.get('settings', {}).get('access_logging', {})
            if settings.get('target_bucket') != 'None':
                print(f"   Target: {settings.get('target_bucket')}/{settings.get('target_prefix', '')}")
        else:
            print(f"\n❌ VERIFICATION: S3.9 server access logging failed")
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
