#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
Macie.1 Remediation: Macie should be enabled
IAM-Safe approach: Only enable if not already configured, preserve existing configuration
"""

import boto3
import argparse
from datetime import datetime
from botocore.exceptions import ClientError

def verify_macie_compliance(macie_client):
    """Verify that Macie is enabled"""
    try:
        session_response = macie_client.get_macie_session()
        status = session_response.get('status', 'DISABLED')
        service_role = session_response.get('serviceRole', 'None')
        
        return {
            'overall_compliant': status == 'ENABLED',
            'settings': {
                'macie_service': {
                    'required': True,
                    'actual': status == 'ENABLED',
                    'compliant': status == 'ENABLED',
                    'status': status,
                    'service_role': service_role
                }
            },
            'verification_timestamp': datetime.now().isoformat()
        }
        
    except ClientError as e:
        if e.response['Error']['Code'] == 'ResourceNotFoundException':
            return {
                'overall_compliant': False,
                'settings': {
                    'macie_service': {
                        'required': True,
                        'actual': False,
                        'compliant': False,
                        'status': 'DISABLED'
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

def remediate_macie_enablement_iam_safe(profile_name, region, dry_run=False, finding_arn=None):
    """
    IAM-Safe Macie.1 remediation: Only enable if not already configured
    Preserves existing Macie configuration if present
    """
    
    try:
        session = boto3.Session(profile_name=profile_name)
        macie = session.client('macie2', region_name=region)
        
        # IAM-SAFE: Check existing Macie status
        try:
            session_response = macie.get_macie_session()
            current_status = session_response.get('status', 'DISABLED')
            service_role = session_response.get('serviceRole')
        except ClientError as e:
            if e.response['Error']['Code'] == 'ResourceNotFoundException':
                current_status = 'DISABLED'
                service_role = None
            else:
                raise
        
        result = {
            'control_id': 'Macie.1',
            'timestamp': datetime.now().isoformat(),
            'existing_status': current_status,
            'existing_service_role': service_role,
            'iam_safe_approach': True
        }
        
        if current_status == 'ENABLED':
            result['status'] = 'COMPLIANT'
            result['message'] = f'Macie already enabled (Service Role: {service_role})'
            result['needs_remediation'] = False
            
            verification = verify_macie_compliance(macie)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'Macie.1 compliance verified: Macie service already enabled (IAM-Safe validation)',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would enable Macie service for data security and privacy monitoring'
            return result
        
        # IAM-SAFE: Enable Macie service
        try:
            macie.enable_macie()
            result['status'] = 'REMEDIATED'
            result['message'] = f'IAM-Safe: Enabled Macie service for data security monitoring'
            result['needs_remediation'] = True
        except ClientError as e:
            if e.response['Error']['Code'] == 'ConflictException':
                # Macie already enabled
                result['status'] = 'COMPLIANT'
                result['message'] = f'Macie already enabled (detected during enablement)'
                result['needs_remediation'] = False
            else:
                raise
        
        # Verify remediation was successful
        verification = verify_macie_compliance(macie)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'Macie.1 remediation completed (IAM-Safe): Enabled Macie service for data security and privacy monitoring',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'Macie enablement attempted but verification failed'
        
        return result
        
    except Exception as e:
        return {
            'control_id': 'Macie.1',
            'status': 'ERROR',
            'message': f'IAM-Safe remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='Macie.1 Macie Enablement Remediation (IAM-Safe)')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 Macie.1 Remediation: Macie Enablement (IAM-Safe)")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    result = remediate_macie_enablement_iam_safe(
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
    
    if result.get('existing_status'):
        print(f"📋 Previous status: {result['existing_status']}")
    
    if result.get('existing_service_role'):
        print(f"📋 Service role: {result['existing_service_role']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: Macie.1 service enablement confirmed (IAM-Safe)")
            settings = verification.get('settings', {}).get('macie_service', {})
            if settings.get('service_role') != 'None':
                print(f"   Service Role: {settings.get('service_role')}")
        else:
            print(f"\n❌ VERIFICATION: Macie.1 service enablement failed")
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
