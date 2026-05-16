#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
S3.11 Remediation: S3 general purpose buckets should have event notifications enabled
IAM-Safe approach: Add compliance notifications to existing configuration, preserve all existing notifications
"""

import boto3
import json
import argparse
from datetime import datetime
from botocore.exceptions import ClientError

def verify_s3_notifications_compliance(bucket_name, s3_client):
    """Verify that S3 bucket has event notifications configured"""
    try:
        try:
            notification_response = s3_client.get_bucket_notification_configuration(Bucket=bucket_name)
            
            # Check for any type of notification configuration
            has_notifications = (
                len(notification_response.get('TopicConfigurations', [])) > 0 or
                len(notification_response.get('QueueConfigurations', [])) > 0 or
                len(notification_response.get('LambdaFunctionConfigurations', [])) > 0 or
                'EventBridgeConfiguration' in notification_response  # EventBridge presence indicates compliance
            )
            
            return {
                'overall_compliant': has_notifications,
                'settings': {
                    'event_notifications': {
                        'required': True,
                        'actual': has_notifications,
                        'compliant': has_notifications
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
                # No notification configuration is considered non-compliant
                return {
                    'overall_compliant': False,
                    'settings': {
                        'event_notifications': {
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

def remediate_s3_event_notifications_iam_safe(bucket_name, profile_name, region, dry_run=False, finding_arn=None):
    """
    IAM-Safe S3.11 remediation: Add EventBridge notifications to existing configuration
    Preserves all existing notification configurations
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
                    'control_id': 'S3.11',
                    'status': 'ERROR',
                    'message': f'Bucket {bucket_name} does not exist',
                    'timestamp': datetime.now().isoformat()
                }
            raise
        
        # IAM-SAFE: Get existing notification configuration and preserve it
        existing_config = {}
        try:
            notification_response = s3.get_bucket_notification_configuration(Bucket=bucket_name)
            existing_config = {
                'TopicConfigurations': notification_response.get('TopicConfigurations', []),
                'QueueConfigurations': notification_response.get('QueueConfigurations', []),
                'LambdaFunctionConfigurations': notification_response.get('LambdaFunctionConfigurations', []),
                'EventBridgeConfiguration': notification_response.get('EventBridgeConfiguration', {})
            }
        except ClientError as e:
            # No existing configuration
            existing_config = {
                'TopicConfigurations': [],
                'QueueConfigurations': [],
                'LambdaFunctionConfigurations': [],
                'EventBridgeConfiguration': {}
            }
        
        # Check if any notifications already exist (compliance requirement)
        has_notifications = (
            len(existing_config['TopicConfigurations']) > 0 or
            len(existing_config['QueueConfigurations']) > 0 or
            len(existing_config['LambdaFunctionConfigurations']) > 0 or
            bool(existing_config['EventBridgeConfiguration'])  # EventBridge presence indicates compliance
        )
        
        total_existing = (
            len(existing_config['TopicConfigurations']) +
            len(existing_config['QueueConfigurations']) +
            len(existing_config['LambdaFunctionConfigurations']) +
            (1 if existing_config['EventBridgeConfiguration'] else 0)
        )
        
        result = {
            'bucket_name': bucket_name,
            'control_id': 'S3.11',
            'timestamp': datetime.now().isoformat(),
            'needs_remediation': not has_notifications,
            'existing_notifications_count': total_existing,
            'iam_safe_approach': True
        }
        
        if has_notifications:
            result['status'] = 'COMPLIANT'
            result['message'] = f'Bucket {bucket_name} already has event notifications configured ({total_existing} configurations)'
            
            verification = verify_s3_notifications_compliance(bucket_name, s3)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'S3.11 compliance verified: Bucket {bucket_name} has event notifications configured (IAM-Safe validation)',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would add EventBridge notifications to existing configuration ({total_existing} existing notifications)'
            return result
        
        # IAM-SAFE: Add EventBridge configuration to existing notifications (preserve all existing)
        updated_config = existing_config.copy()
        
        # Add EventBridge configuration if not already present
        if not updated_config['EventBridgeConfiguration']:
            updated_config['EventBridgeConfiguration'] = {}
        
        # Apply updated notification configuration with preserved existing notifications
        s3.put_bucket_notification_configuration(
            Bucket=bucket_name,
            NotificationConfiguration=updated_config
        )
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'IAM-Safe: Added EventBridge notifications (preserved {total_existing} existing notifications)'
        result['added_config'] = {'EventBridgeConfiguration': {}}
        result['final_notifications_count'] = total_existing + 1
        
        # Verify remediation was successful
        verification = verify_s3_notifications_compliance(bucket_name, s3)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'S3.11 remediation completed (IAM-Safe): Added EventBridge notifications to bucket {bucket_name} while preserving existing notification configurations',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'EventBridge notifications added but verification failed for bucket {bucket_name}'
        
        return result
        
    except Exception as e:
        return {
            'bucket_name': bucket_name,
            'control_id': 'S3.11',
            'status': 'ERROR',
            'message': f'IAM-Safe remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='S3.11 Event Notifications Remediation (IAM-Safe)')
    parser.add_argument('--bucket-name', required=True, help='S3 bucket name to remediate')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 S3.11 Remediation: Event Notifications (IAM-Safe)")
    print(f"Bucket: {args.bucket_name}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    result = remediate_s3_event_notifications_iam_safe(
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
    
    if result.get('existing_notifications_count') is not None:
        print(f"📋 Existing notifications: {result['existing_notifications_count']}")
    
    if result.get('final_notifications_count'):
        print(f"📋 Final notifications: {result['final_notifications_count']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: S3.11 event notifications confirmed (IAM-Safe)")
        else:
            print(f"\n❌ VERIFICATION: S3.11 event notifications failed")
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
