#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
IAM.18 Remediation: Create AWS Support Role
Addresses SEC-GENERAL-103 (IAM.18)
"""

import boto3
import json
import argparse
from datetime import datetime

def verify_support_role_compliance(role_name, iam_client):
    """Verify AWS Support role exists and has correct policy"""
    try:
        # Check if role exists
        try:
            role = iam_client.get_role(RoleName=role_name)
            role_exists = True
        except iam_client.exceptions.NoSuchEntityException:
            return {
                'overall_compliant': False,
                'error': 'Support role does not exist',
                'verification_timestamp': datetime.now().isoformat()
            }
        
        # Check attached policies
        attached_policies = iam_client.list_attached_role_policies(RoleName=role_name)
        
        has_support_policy = any(
            policy['PolicyArn'] == 'arn:aws:iam::aws:policy/AWSSupportAccess'
            for policy in attached_policies['AttachedPolicies']
        )
        
        return {
            'overall_compliant': role_exists and has_support_policy,
            'settings': {
                'role_exists': {'required': True, 'actual': role_exists, 'compliant': role_exists},
                'support_policy_attached': {'required': True, 'actual': has_support_policy, 'compliant': has_support_policy}
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

def remediate_support_role(role_name, profile_name, region, dry_run=False, finding_arn=None):
    """Create AWS Support role for incident management"""
    try:
        session = boto3.Session(profile_name=profile_name)
        iam_client = session.client('iam', region_name=region)
        
        # Check if role already exists
        try:
            existing_role = iam_client.get_role(RoleName=role_name)
            role_exists = True
        except iam_client.exceptions.NoSuchEntityException:
            role_exists = False
        
        result = {
            'control_id': 'IAM.18',
            'timestamp': datetime.now().isoformat(),
            'role_name': role_name,
            'needs_remediation': not role_exists
        }
        
        if role_exists:
            result['status'] = 'COMPLIANT'
            result['message'] = f'AWS Support role "{role_name}" already exists'
            
            verification = verify_support_role_compliance(role_name, iam_client)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'AWS Support role "{role_name}" verified compliant',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would create AWS Support role "{role_name}"'
            return result
        
        # Trust policy for AWS Support role
        trust_policy = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {
                        "AWS": f"arn:aws:iam::{session.client('sts').get_caller_identity()['Account']}:root"
                    },
                    "Action": "sts:AssumeRole"
                }
            ]
        }
        
        # Create role
        iam_client.create_role(
            RoleName=role_name,
            AssumeRolePolicyDocument=json.dumps(trust_policy),
            Description='IAM role for managing AWS Support incidents',
            Tags=[
                {'Key': 'Purpose', 'Value': 'AWS Support Access'},
                {'Key': 'Compliance', 'Value': 'IAM.18'},
                {'Key': 'ManagedBy', 'Value': 'SecurityComplianceFramework'}
            ]
        )
        
        # Attach AWS Support policy
        iam_client.attach_role_policy(
            RoleName=role_name,
            PolicyArn='arn:aws:iam::aws:policy/AWSSupportAccess'
        )
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'AWS Support role "{role_name}" created successfully'
        result['role_arn'] = f"arn:aws:iam::{session.client('sts').get_caller_identity()['Account']}:role/{role_name}"
        
        # Verify
        verification = verify_support_role_compliance(role_name, iam_client)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'AWS Support role "{role_name}" created and verified',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
        
        return result
        
    except Exception as e:
        return {
            'control_id': 'IAM.18',
            'status': 'ERROR',
            'message': f'Remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='AWS Support Role Remediation (IAM.18)')
    parser.add_argument('--role-name', default='AWSSupportRole', help='Name for AWS Support role')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print("🔧 AWS Support Role Remediation (IAM.18)")
    print(f"Role Name: {args.role_name}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    print("")
    
    result = remediate_support_role(
        role_name=args.role_name,
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
    
    if result.get('role_arn'):
        print(f"\n📋 Role ARN: {result['role_arn']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: AWS Support role compliance confirmed")
        else:
            print(f"\n❌ VERIFICATION: AWS Support role compliance failed")
    
    if result.get('security_hub_update'):
        hub_update = result['security_hub_update']
        if hub_update.get('success'):
            print(f"\n🔗 SECURITY HUB: Finding marked as RESOLVED")
        else:
            print(f"\n❌ SECURITY HUB: Update failed - {hub_update.get('error')}")
    
    return 0 if result['status'] in ['COMPLIANT', 'REMEDIATED'] else 1

if __name__ == '__main__':
    exit(main())
