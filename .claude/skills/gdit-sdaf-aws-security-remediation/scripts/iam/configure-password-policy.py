#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
IAM.10/IAM.16 Remediation: Configure Strong IAM Password Policy
Addresses SEC-GENERAL-102 (IAM.10) and SEC-GENERAL-095 (IAM.16)
"""

import boto3
import argparse
from datetime import datetime

def verify_password_policy_compliance(iam_client):
    """Verify IAM password policy meets compliance requirements"""
    try:
        response = iam_client.get_account_password_policy()
        policy = response['PasswordPolicy']
        
        required = {
            'MinimumPasswordLength': 14,
            'RequireUppercaseCharacters': True,
            'RequireLowercaseCharacters': True,
            'RequireNumbers': True,
            'RequireSymbols': True,
            'PasswordReusePrevention': 24,
            'MaxPasswordAge': 90
        }
        
        compliance = {}
        all_compliant = True
        
        for setting, required_value in required.items():
            actual_value = policy.get(setting)
            compliant = actual_value == required_value if isinstance(required_value, bool) else actual_value >= required_value
            compliance[setting] = {
                'required': required_value,
                'actual': actual_value,
                'compliant': compliant
            }
            if not compliant:
                all_compliant = False
        
        return {
            'overall_compliant': all_compliant,
            'settings': compliance,
            'verification_timestamp': datetime.now().isoformat()
        }
    except Exception as e:
        return {
            'overall_compliant': False,
            'error': f'Verification failed: {str(e)}',
            'verification_timestamp': datetime.now().isoformat()
        }

def update_security_hub_finding_status(finding_arn, status, note, profile_name, region):
    """Update Security Hub finding status"""
    try:
        session = boto3.Session(profile_name=profile_name)
        securityhub = session.client('securityhub', region_name=region)
        
        findings_response = securityhub.get_findings(
            Filters={'Id': [{'Value': finding_arn, 'Comparison': 'EQUALS'}]}
        )
        
        if not findings_response.get('Findings'):
            raise ValueError(f"Finding not found: {finding_arn}")
        
        product_arn = findings_response['Findings'][0].get('ProductArn')
        
        response = securityhub.batch_update_findings(
            FindingIdentifiers=[{'Id': finding_arn, 'ProductArn': product_arn}],
            Workflow={'Status': status},
            Note={'Text': note, 'UpdatedBy': 'Security Compliance Remediation Framework'}
        )
        
        return {'success': True, 'finding_arn': finding_arn, 'new_status': status}
    except Exception as e:
        return {'success': False, 'finding_arn': finding_arn, 'error': str(e)}

def remediate_password_policy(profile_name, region, dry_run=False, finding_arns=None):
    """Configure IAM password policy to meet compliance requirements"""
    try:
        session = boto3.Session(profile_name=profile_name)
        iam_client = session.client('iam', region_name=region)
        
        # Check current policy
        try:
            response = iam_client.get_account_password_policy()
            current_policy = response['PasswordPolicy']
            has_policy = True
        except iam_client.exceptions.NoSuchEntityException:
            current_policy = {}
            has_policy = False
        
        # Required configuration
        required_config = {
            'MinimumPasswordLength': 14,
            'RequireUppercaseCharacters': True,
            'RequireLowercaseCharacters': True,
            'RequireNumbers': True,
            'RequireSymbols': True,
            'PasswordReusePrevention': 24,
            'MaxPasswordAge': 90,
            'AllowUsersToChangePassword': True,
            'HardExpiry': True
        }
        
        # Determine changes needed
        changes = {}
        for setting, required_value in required_config.items():
            current_value = current_policy.get(setting)
            if current_value != required_value:
                changes[setting] = {'current': current_value, 'required': required_value}
        
        result = {
            'control_id': 'IAM.10/IAM.16',
            'timestamp': datetime.now().isoformat(),
            'needs_remediation': bool(changes),
            'changes': changes
        }
        
        if not changes:
            result['status'] = 'COMPLIANT'
            result['message'] = 'IAM password policy already meets compliance requirements'
            verification = verify_password_policy_compliance(iam_client)
            result['verification'] = verification
            
            if finding_arns and verification.get('overall_compliant'):
                result['security_hub_updates'] = []
                for arn in finding_arns:
                    hub_update = update_security_hub_finding_status(
                        arn, 'RESOLVED', 
                        'IAM password policy verified compliant with requirements',
                        profile_name, region
                    )
                    result['security_hub_updates'].append(hub_update)
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would update password policy with {len(changes)} changes'
            return result
        
        # Apply remediation
        iam_client.update_account_password_policy(**required_config)
        
        result['status'] = 'REMEDIATED'
        result['message'] = 'IAM password policy updated successfully'
        result['applied_config'] = required_config
        
        # Verify
        verification = verify_password_policy_compliance(iam_client)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arns:
                result['security_hub_updates'] = []
                for arn in finding_arns:
                    hub_update = update_security_hub_finding_status(
                        arn, 'RESOLVED',
                        'IAM password policy remediated and verified compliant',
                        profile_name, region
                    )
                    result['security_hub_updates'].append(hub_update)
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
        
        return result
        
    except Exception as e:
        return {
            'control_id': 'IAM.10/IAM.16',
            'status': 'ERROR',
            'message': f'Remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='IAM Password Policy Remediation (IAM.10/IAM.16)')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-ids', nargs='+', help='Security Hub finding ARNs for status update')
    
    args = parser.parse_args()
    
    print("🔧 IAM Password Policy Remediation (IAM.10/IAM.16)")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    print("")
    
    result = remediate_password_policy(
        profile_name=args.profile,
        region=args.region,
        dry_run=args.dry_run,
        finding_arns=args.finding_ids
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
            print(f"   {setting}: {change.get('current', 'N/A')} → {change.get('required')}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: Password policy compliance confirmed")
        else:
            print(f"\n❌ VERIFICATION: Password policy compliance failed")
    
    if result.get('security_hub_updates'):
        print(f"\n🔗 SECURITY HUB: Updated {len(result['security_hub_updates'])} finding(s)")
    
    return 0 if result['status'] in ['COMPLIANT', 'REMEDIATED'] else 1

if __name__ == '__main__':
    exit(main())
