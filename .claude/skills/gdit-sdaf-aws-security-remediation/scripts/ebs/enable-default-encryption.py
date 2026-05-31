#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
EC2.7 Remediation: EBS default encryption should be enabled
IAM-Safe approach: Only enable if not already configured, preserve existing KMS key if set
"""

import boto3
import argparse
from datetime import datetime
from botocore.exceptions import ClientError

def verify_ebs_encryption_compliance(ec2_client):
    """Verify that EBS default encryption is enabled"""
    try:
        encryption_response = ec2_client.get_ebs_encryption_by_default()
        encryption_enabled = encryption_response.get('EbsEncryptionByDefault', False)
        
        kms_key_response = ec2_client.get_ebs_default_kms_key_id()
        kms_key_id = kms_key_response.get('KmsKeyId', 'None')
        
        return {
            'overall_compliant': encryption_enabled,
            'settings': {
                'default_encryption': {
                    'required': True,
                    'actual': encryption_enabled,
                    'compliant': encryption_enabled,
                    'kms_key_id': kms_key_id
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

def remediate_ebs_default_encryption_iam_safe(profile_name, region, dry_run=False, finding_arn=None):
    """
    IAM-Safe EC2.7 remediation: Only enable encryption if not already configured
    Preserves existing KMS key configuration if present
    """
    
    try:
        session = boto3.Session(profile_name=profile_name)
        ec2 = session.client('ec2', region_name=region)
        
        # IAM-SAFE: Check existing encryption configuration
        try:
            encryption_response = ec2.get_ebs_encryption_by_default()
            encryption_enabled = encryption_response.get('EbsEncryptionByDefault', False)
        except ClientError:
            encryption_enabled = False
        
        try:
            kms_response = ec2.get_ebs_default_kms_key_id()
            existing_kms_key = kms_response.get('KmsKeyId')
        except ClientError:
            existing_kms_key = None
        
        result = {
            'control_id': 'EC2.7',
            'timestamp': datetime.now().isoformat(),
            'existing_encryption': encryption_enabled,
            'existing_kms_key': existing_kms_key,
            'iam_safe_approach': True
        }
        
        if encryption_enabled:
            result['status'] = 'COMPLIANT'
            result['message'] = f'EBS default encryption already enabled (KMS Key: {existing_kms_key or "AWS managed"})'
            result['needs_remediation'] = False
            
            verification = verify_ebs_encryption_compliance(ec2)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'EC2.7 compliance verified: EBS default encryption already enabled (IAM-Safe validation)',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would enable EBS default encryption with AWS managed KMS key'
            return result
        
        # IAM-SAFE: Enable encryption with AWS managed key (safe default)
        ec2.enable_ebs_encryption_by_default()
        
        # Set AWS managed EBS key if no existing key
        if not existing_kms_key:
            ec2.modify_ebs_default_kms_key_id(KmsKeyId='alias/aws/ebs')
            result['kms_key_set'] = 'alias/aws/ebs'
        else:
            result['kms_key_preserved'] = existing_kms_key
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'IAM-Safe: Enabled EBS default encryption (KMS Key: {existing_kms_key or "alias/aws/ebs"})'
        result['needs_remediation'] = True
        
        # Verify remediation was successful
        verification = verify_ebs_encryption_compliance(ec2)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'EC2.7 remediation completed (IAM-Safe): Enabled EBS default encryption with AWS managed KMS key',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'EBS encryption enabled but verification failed'
        
        return result
        
    except Exception as e:
        return {
            'control_id': 'EC2.7',
            'status': 'ERROR',
            'message': f'IAM-Safe remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='EC2.7 EBS Default Encryption Remediation (IAM-Safe)')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 EC2.7 Remediation: EBS Default Encryption (IAM-Safe)")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    result = remediate_ebs_default_encryption_iam_safe(
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
    
    if result.get('existing_encryption') is not None:
        print(f"📋 Previous encryption status: {result['existing_encryption']}")
    
    if result.get('existing_kms_key'):
        print(f"📋 Existing KMS key: {result['existing_kms_key']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: EC2.7 EBS default encryption confirmed (IAM-Safe)")
            settings = verification.get('settings', {}).get('default_encryption', {})
            if settings.get('kms_key_id') != 'None':
                print(f"   KMS Key: {settings.get('kms_key_id')}")
        else:
            print(f"\n❌ VERIFICATION: EC2.7 EBS default encryption failed")
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
