#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
Inspector-3 Remediation: Amazon Inspector Lambda code scanning should be enabled
Reusable script for Security Hub finding Inspector-3 remediation
"""

import boto3
import json
import argparse
from datetime import datetime

def verify_inspector_compliance(inspector_client):
    """
    Verify that Inspector Lambda scanning meets compliance requirements
    
    Returns:
        dict: Verification result with compliance status
    """
    try:
        # Get current configuration
        response = inspector_client.describe_configuration()
        
        # Check if Lambda scanning is enabled
        lambda_scanning = response.get('LambdaCodeScanningConfiguration', {}).get('Status') == 'ENABLED'
        
        compliance_status = {
            'lambda_scanning': {
                'required': True,
                'actual': lambda_scanning,
                'compliant': lambda_scanning
            }
        }
        
        return {
            'overall_compliant': lambda_scanning,
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
        return {'success': False, 'finding_arn': finding_arn, 'error': str(e)}

def remediate_inspector_lambda_scanning(profile_name, region, dry_run=False, finding_arn=None):
    """
    Remediate Inspector-3 finding by enabling Lambda code scanning
    """
    
    try:
        session = boto3.Session(profile_name=profile_name)
        inspector_client = session.client('inspector2', region_name=region)
        
        # Get current configuration
        try:
            response = inspector_client.describe_configuration()
            current_lambda_scanning = response.get('LambdaCodeScanningConfiguration', {}).get('Status') == 'ENABLED'
        except Exception:
            current_lambda_scanning = False
        
        changes = {}
        needs_remediation = not current_lambda_scanning
        
        if needs_remediation:
            changes['lambda_scanning'] = {'current': False, 'required': True}
        
        result = {
            'control_id': 'Inspector-3',
            'timestamp': datetime.now().isoformat(),
            'needs_remediation': needs_remediation,
            'changes': changes
        }
        
        if not needs_remediation:
            result['status'] = 'COMPLIANT'
            result['message'] = 'Inspector Lambda code scanning already enabled'
            
            verification = verify_inspector_compliance(inspector_client)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    'Inspector Lambda code scanning verified as enabled',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = 'Would enable Inspector Lambda code scanning'
            return result
        
        # Apply remediation - Enable Inspector Lambda scanning
        try:
            # First enable Inspector if not already enabled
            inspector_client.enable(
                resourceTypes=['LAMBDA_CODE']
            )
            
            # Update configuration to enable Lambda scanning
            inspector_client.update_configuration(
                LambdaCodeScanningConfiguration={
                    'Status': 'ENABLED'
                }
            )
            
            applied_config = {'lambda_scanning': True}
            
        except inspector_client.exceptions.ValidationException as e:
            if 'already enabled' in str(e).lower():
                # Inspector already enabled, just update configuration
                inspector_client.update_configuration(
                    LambdaCodeScanningConfiguration={
                        'Status': 'ENABLED'
                    }
                )
                applied_config = {'lambda_scanning': True}
            else:
                raise e
        
        result['status'] = 'REMEDIATED'
        result['message'] = 'Inspector Lambda code scanning enabled successfully'
        result['applied_config'] = applied_config
        
        # Verify remediation
        verification = verify_inspector_compliance(inspector_client)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    'Inspector Lambda code scanning enabled and verified',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
        
        return result
        
    except Exception as e:
        return {
            'control_id': 'Inspector-3',
            'status': 'ERROR',
            'message': f'Remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='Inspector-3 Lambda Code Scanning Remediation')
    parser.add_argument('--profile', default='com-d', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 Inspector-3 Remediation: Lambda Code Scanning")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    print("")
    
    result = remediate_inspector_lambda_scanning(
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
    
    if result.get('changes'):
        print("\n📋 Applied Changes:")
        for setting, change in result['changes'].items():
            print(f"   {setting}: {change.get('current')} → {change.get('required')}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: Inspector Lambda scanning compliance confirmed")
        else:
            print(f"\n❌ VERIFICATION: Inspector Lambda scanning compliance failed")
    
    if result.get('security_hub_update'):
        hub_update = result['security_hub_update']
        if hub_update.get('success'):
            print(f"\n🔗 SECURITY HUB: Finding marked as RESOLVED")
        else:
            print(f"\n❌ SECURITY HUB: Update failed - {hub_update.get('error')}")
    
    return 0 if result['status'] in ['COMPLIANT', 'REMEDIATED'] else 1

if __name__ == '__main__':
    exit(main())
