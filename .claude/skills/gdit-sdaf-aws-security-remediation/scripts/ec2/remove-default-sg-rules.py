#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
EC2.2 Remediation: VPC default security groups should not allow inbound or outbound traffic
IAM-Safe approach: Remove all rules from default security group while preserving the group itself
"""

import boto3
import argparse
from datetime import datetime
from botocore.exceptions import ClientError

def verify_default_sg_compliance(ec2_client, sg_id):
    """Verify that default security group has no rules"""
    try:
        sg_response = ec2_client.describe_security_groups(GroupIds=[sg_id])
        security_groups = sg_response.get('SecurityGroups', [])
        
        if not security_groups:
            return {
                'overall_compliant': False,
                'error': f'Security group {sg_id} not found',
                'verification_timestamp': datetime.now().isoformat()
            }
        
        sg = security_groups[0]
        inbound_rules = sg.get('IpPermissions', [])
        outbound_rules = sg.get('IpPermissionsEgress', [])
        
        has_no_rules = len(inbound_rules) == 0 and len(outbound_rules) == 0
        
        return {
            'overall_compliant': has_no_rules,
            'settings': {
                'default_security_group': {
                    'required': True,
                    'actual': has_no_rules,
                    'compliant': has_no_rules,
                    'inbound_rules_count': len(inbound_rules),
                    'outbound_rules_count': len(outbound_rules)
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
        
        response = securityhub.batch_update_findings(
            FindingIdentifiers=[{'Id': finding_arn, 'ProductArn': product_arn}],
            Workflow={'Status': status},
            Note={'Text': note, 'UpdatedBy': 'Security Compliance Remediation Framework'}
        )
        
        return {'success': True, 'finding_arn': finding_arn, 'new_status': status}
        
    except Exception as e:
        return {'success': False, 'finding_arn': finding_arn, 'error': f'Security Hub update failed: {str(e)}'}

def remediate_default_sg_iam_safe(sg_id, profile_name, region, dry_run=False, finding_arn=None):
    """
    IAM-Safe EC2.2 remediation: Remove all rules from default security group
    Preserves the security group itself, only removes rules
    """
    
    try:
        session = boto3.Session(profile_name=profile_name)
        ec2 = session.client('ec2', region_name=region)
        
        # Check if security group exists and get current rules
        try:
            sg_response = ec2.describe_security_groups(GroupIds=[sg_id])
            security_groups = sg_response.get('SecurityGroups', [])
            if not security_groups:
                return {
                    'control_id': 'EC2.2',
                    'sg_id': sg_id,
                    'status': 'ERROR',
                    'message': f'Security group {sg_id} not found',
                    'timestamp': datetime.now().isoformat()
                }
            sg = security_groups[0]
        except ClientError as e:
            return {
                'control_id': 'EC2.2',
                'sg_id': sg_id,
                'status': 'ERROR',
                'message': f'Security group {sg_id} not accessible: {str(e)}',
                'timestamp': datetime.now().isoformat()
            }
        
        # IAM-SAFE: Check existing rules
        inbound_rules = sg.get('IpPermissions', [])
        outbound_rules = sg.get('IpPermissionsEgress', [])
        
        result = {
            'control_id': 'EC2.2',
            'sg_id': sg_id,
            'timestamp': datetime.now().isoformat(),
            'existing_inbound_rules': len(inbound_rules),
            'existing_outbound_rules': len(outbound_rules),
            'iam_safe_approach': True
        }
        
        if len(inbound_rules) == 0 and len(outbound_rules) == 0:
            result['status'] = 'COMPLIANT'
            result['message'] = f'Default security group {sg_id} already has no rules'
            result['needs_remediation'] = False
            
            verification = verify_default_sg_compliance(ec2, sg_id)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'EC2.2 compliance verified: Default security group {sg_id} already has no rules (IAM-Safe validation)',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would remove {len(inbound_rules)} inbound and {len(outbound_rules)} outbound rules from default security group {sg_id}'
            return result
        
        # IAM-SAFE: Remove rules (preserve security group itself)
        rules_removed = []
        
        # Remove inbound rules
        if inbound_rules:
            try:
                ec2.revoke_security_group_ingress(
                    GroupId=sg_id,
                    IpPermissions=inbound_rules
                )
                rules_removed.append(f'{len(inbound_rules)} inbound rules')
            except ClientError as e:
                if 'InvalidGroup.NotFound' not in str(e):
                    raise
        
        # Remove outbound rules
        if outbound_rules:
            try:
                ec2.revoke_security_group_egress(
                    GroupId=sg_id,
                    IpPermissions=outbound_rules
                )
                rules_removed.append(f'{len(outbound_rules)} outbound rules')
            except ClientError as e:
                if 'InvalidGroup.NotFound' not in str(e):
                    raise
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'IAM-Safe: Removed {", ".join(rules_removed)} from default security group {sg_id}'
        result['needs_remediation'] = True
        result['rules_removed'] = rules_removed
        
        # Verify remediation was successful
        verification = verify_default_sg_compliance(ec2, sg_id)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'EC2.2 remediation completed (IAM-Safe): Removed all rules from default security group {sg_id}',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'Rules removed but verification failed for security group {sg_id}'
        
        return result
        
    except Exception as e:
        return {
            'control_id': 'EC2.2',
            'sg_id': sg_id,
            'status': 'ERROR',
            'message': f'IAM-Safe remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='EC2.2 Default Security Group Remediation (IAM-Safe)')
    parser.add_argument('--sg-id', required=True, help='Default security group ID')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 EC2.2 Remediation: Default Security Group Rules (IAM-Safe)")
    print(f"Security Group: {args.sg_id}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    result = remediate_default_sg_iam_safe(
        sg_id=args.sg_id,
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
    
    if result.get('existing_inbound_rules') is not None:
        print(f"📋 Previous inbound rules: {result['existing_inbound_rules']}")
    
    if result.get('existing_outbound_rules') is not None:
        print(f"📋 Previous outbound rules: {result['existing_outbound_rules']}")
    
    if result.get('rules_removed'):
        print(f"📋 Rules removed: {result['rules_removed']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: EC2.2 default security group compliance confirmed (IAM-Safe)")
        else:
            print(f"\n❌ VERIFICATION: EC2.2 default security group compliance failed")
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
