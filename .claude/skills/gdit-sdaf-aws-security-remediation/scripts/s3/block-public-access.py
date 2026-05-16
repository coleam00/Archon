#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
S3.8 Remediation: S3 general purpose buckets should block public access
Reusable script for Security Hub finding S3.8 remediation with verification and Security Hub update
"""

import boto3
import json
import argparse
from datetime import datetime

def verify_s3_public_access_compliance(bucket_name, s3_client):
    """
    Verify that S3 bucket meets S3.8 compliance requirements
    
    Returns:
        dict: Verification result with compliance status
    """
    try:
        # Get current configuration after remediation
        current_config = s3_client.get_public_access_block(Bucket=bucket_name)
        current_pab = current_config.get('PublicAccessBlockConfiguration', {})
        
        # Required settings for S3.8 compliance
        required_settings = {
            'BlockPublicAcls': True,
            'IgnorePublicAcls': True,
            'BlockPublicPolicy': True,
            'RestrictPublicBuckets': True
        }
        
        # Verify each setting
        compliance_status = {}
        all_compliant = True
        
        for setting, required_value in required_settings.items():
            actual_value = current_pab.get(setting, False)
            is_compliant = actual_value == required_value
            compliance_status[setting] = {
                'required': required_value,
                'actual': actual_value,
                'compliant': is_compliant
            }
            if not is_compliant:
                all_compliant = False
        
        return {
            'overall_compliant': all_compliant,
            'settings': compliance_status,
            'verification_timestamp': datetime.now().isoformat()
        }
        
    except Exception as e:
        return {
            'overall_compliant': False,
            'error': f'Verification failed: {str(e)}',
            'verification_timestamp': datetime.now().isoformat()
        }

def update_security_hub_finding_status(finding_arn, status, note, profile_name, region):
    """
    Update Security Hub finding status to RESOLVED
    
    Args:
        finding_arn (str): Full Security Hub finding ARN
        status (str): New status (RESOLVED, NEW, etc.)
        note (str): Note explaining the resolution
        profile_name (str): AWS profile name
        region (str): AWS region
    
    Returns:
        dict: Update result
    """
    try:
        session = boto3.Session(profile_name=profile_name)
        securityhub = session.client('securityhub', region_name=region)
        
        # Extract components from finding ARN
        # Format: arn:aws:securityhub:region:account:security-control/ControlId/finding/FindingId
        arn_parts = finding_arn.split('/')
        if len(arn_parts) < 3:
            raise ValueError(f"Invalid finding ARN format: {finding_arn}")
        
        finding_id = arn_parts[-1]  # Last part is the finding ID
        
        # Get the finding details to extract ProductArn
        findings_response = securityhub.get_findings(
            Filters={
                'Id': [{'Value': finding_arn, 'Comparison': 'EQUALS'}]
            }
        )
        
        if not findings_response.get('Findings'):
            raise ValueError(f"Finding not found: {finding_arn}")
        
        finding = findings_response['Findings'][0]
        product_arn = finding.get('ProductArn')
        
        if not product_arn:
            raise ValueError(f"ProductArn not found in finding: {finding_arn}")
        
        # Update finding status
        response = securityhub.batch_update_findings(
            FindingIdentifiers=[
                {
                    'Id': finding_arn,
                    'ProductArn': product_arn
                }
            ],
            Workflow={
                'Status': status
            },
            Note={
                'Text': note,
                'UpdatedBy': 'Security Compliance Remediation Framework'
            }
        )
        
        return {
            'success': True,
            'finding_arn': finding_arn,
            'new_status': status,
            'note': note,
            'response': response
        }
        
    except Exception as e:
        return {
            'success': False,
            'finding_arn': finding_arn,
            'error': f'Security Hub update failed: {str(e)}'
        }

def remediate_s3_public_access(bucket_name, profile_name, region, dry_run=False, finding_arn=None):
    """
    Remediate S3.8 finding by enabling public access block on specific bucket
    Includes verification and Security Hub status update
    
    Args:
        bucket_name (str): Name of S3 bucket to remediate
        profile_name (str): AWS profile name
        region (str): AWS region
        dry_run (bool): If True, only show what would be changed
        finding_arn (str): Security Hub finding ARN for status update
    
    Returns:
        dict: Remediation result with success status and details
    """
    
    try:
        session = boto3.Session(profile_name=profile_name)
        s3 = session.client('s3', region_name=region)
        
        # Get current public access block configuration
        try:
            current_config = s3.get_public_access_block(Bucket=bucket_name)
            current_pab = current_config.get('PublicAccessBlockConfiguration', {})
        except s3.exceptions.NoSuchPublicAccessBlockConfiguration:
            current_pab = {}
        except Exception as e:
            if 'NoSuchBucket' in str(e):
                return {
                    'bucket_name': bucket_name,
                    'control_id': 'S3.8',
                    'status': 'ERROR',
                    'message': f'Bucket {bucket_name} does not exist',
                    'timestamp': datetime.now().isoformat()
                }
            raise
        
        # Required configuration for S3.8 compliance
        required_config = {
            'BlockPublicAcls': True,
            'IgnorePublicAcls': True,
            'BlockPublicPolicy': True,
            'RestrictPublicBuckets': True
        }
        
        # Check if remediation is needed
        needs_remediation = False
        changes = {}
        
        for setting, required_value in required_config.items():
            current_value = current_pab.get(setting, False)
            if current_value != required_value:
                needs_remediation = True
                changes[setting] = {
                    'current': current_value,
                    'required': required_value
                }
        
        result = {
            'bucket_name': bucket_name,
            'control_id': 'S3.8',
            'timestamp': datetime.now().isoformat(),
            'needs_remediation': needs_remediation,
            'changes': changes
        }
        
        if not needs_remediation:
            result['status'] = 'COMPLIANT'
            result['message'] = f'Bucket {bucket_name} already has proper public access block configuration'
            
            # Still verify compliance
            verification = verify_s3_public_access_compliance(bucket_name, s3)
            result['verification'] = verification
            
            # Update Security Hub if finding ARN provided
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'S3.8 compliance verified: Bucket {bucket_name} has proper public access block configuration',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would apply public access block settings to {bucket_name}'
            return result
        
        # Apply remediation
        s3.put_public_access_block(
            Bucket=bucket_name,
            PublicAccessBlockConfiguration=required_config
        )
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'Successfully applied public access block to bucket {bucket_name}'
        result['applied_config'] = required_config
        
        # Verify remediation was successful
        verification = verify_s3_public_access_compliance(bucket_name, s3)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            # Update Security Hub finding status to RESOLVED
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'S3.8 remediation completed and verified: Applied public access block settings to bucket {bucket_name}',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'Remediation applied but verification failed for bucket {bucket_name}'
        
        return result
        
    except Exception as e:
        return {
            'bucket_name': bucket_name,
            'control_id': 'S3.8',
            'status': 'ERROR',
            'message': f'Remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='S3.8 Public Access Block Remediation with Verification')
    parser.add_argument('--bucket-name', required=True, help='S3 bucket name to remediate')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 S3.8 Remediation: Block Public Access (Enhanced)")
    print(f"Bucket: {args.bucket_name}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    # Execute remediation
    result = remediate_s3_public_access(
        bucket_name=args.bucket_name,
        profile_name=args.profile,
        region=args.region,
        dry_run=args.dry_run,
        finding_arn=args.finding_id
    )
    
    # Display results
    status_icons = {
        'COMPLIANT': '✅',
        'REMEDIATED': '✅',
        'DRY_RUN': '🔍',
        'ERROR': '❌',
        'REMEDIATION_FAILED': '⚠️'
    }
    
    icon = status_icons.get(result['status'], '❓')
    print(f"{icon} {result['status']}: {result['message']}")
    
    if result.get('changes'):
        print("\n📋 Applied Changes:")
        for setting, change in result['changes'].items():
            print(f"   {setting}: {change['current']} → {change['required']}")
    
    # Display verification results
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: S3.8 compliance confirmed")
        else:
            print(f"\n❌ VERIFICATION: S3.8 compliance failed")
            if verification.get('settings'):
                print("   Non-compliant settings:")
                for setting, details in verification['settings'].items():
                    if not details.get('compliant'):
                        print(f"     {setting}: {details['actual']} (required: {details['required']})")
    
    # Display Security Hub update results
    if result.get('security_hub_update'):
        hub_update = result['security_hub_update']
        if hub_update.get('success'):
            print(f"\n🔗 SECURITY HUB: Finding marked as RESOLVED")
        else:
            print(f"\n❌ SECURITY HUB: Update failed - {hub_update.get('error')}")
    
    # Return appropriate exit code
    return 0 if result['status'] in ['COMPLIANT', 'REMEDIATED'] else 1

if __name__ == '__main__':
    exit(main())
