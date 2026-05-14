#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
EC2.6 Remediation: VPC flow logging should be enabled in all VPCs
IAM-Safe approach: Only enable if not already configured, preserve existing flow logs
"""

import boto3
import json
import argparse
from datetime import datetime
from botocore.exceptions import ClientError

def verify_vpc_flow_logs_compliance(ec2_client, vpc_id):
    """Verify that VPC has flow logging enabled"""
    try:
        flow_logs_response = ec2_client.describe_flow_logs(
            Filters=[
                {'Name': 'resource-id', 'Values': [vpc_id]}
            ]
        )
        
        flow_logs = flow_logs_response.get('FlowLogs', [])
        active_flow_logs = [fl for fl in flow_logs if fl.get('FlowLogStatus') == 'ACTIVE']
        flow_logs_enabled = len(active_flow_logs) > 0
        
        return {
            'overall_compliant': flow_logs_enabled,
            'settings': {
                'flow_logs': {
                    'required': True,
                    'actual': flow_logs_enabled,
                    'compliant': flow_logs_enabled,
                    'vpc_id': vpc_id,
                    'active_logs': len(active_flow_logs)
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

def create_flow_logs_role(iam_client):
    """Create IAM role for VPC Flow Logs if it doesn't exist"""
    role_name = 'VPCFlowLogsRole'
    
    try:
        # Check if role exists
        iam_client.get_role(RoleName=role_name)
        return f'arn:aws:iam::{iam_client.get_user()["User"]["Arn"].split(":")[4]}:role/{role_name}'
    except ClientError as e:
        if e.response['Error']['Code'] == 'NoSuchEntity':
            # Create role
            trust_policy = {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Principal": {
                            "Service": "vpc-flow-logs.amazonaws.com"
                        },
                        "Action": "sts:AssumeRole"
                    }
                ]
            }
            
            role_response = iam_client.create_role(
                RoleName=role_name,
                AssumeRolePolicyDocument=json.dumps(trust_policy),
                Description='Role for VPC Flow Logs to deliver logs to CloudWatch'
            )
            
            # Attach policy
            policy_document = {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Action": [
                            "logs:CreateLogGroup",
                            "logs:CreateLogStream",
                            "logs:PutLogEvents",
                            "logs:DescribeLogGroups",
                            "logs:DescribeLogStreams"
                        ],
                        "Resource": "*"
                    }
                ]
            }
            
            iam_client.put_role_policy(
                RoleName=role_name,
                PolicyName='VPCFlowLogsPolicy',
                PolicyDocument=json.dumps(policy_document)
            )
            
            return role_response['Role']['Arn']
        else:
            raise

def remediate_vpc_flow_logs_iam_safe(vpc_id, profile_name, region, dry_run=False, finding_arn=None):
    """
    IAM-Safe VPC flow logs remediation: Only enable if not already configured
    Preserves existing flow logs configuration
    """
    
    try:
        session = boto3.Session(profile_name=profile_name)
        ec2 = session.client('ec2', region_name=region)
        logs = session.client('logs', region_name=region)
        iam = session.client('iam', region_name=region)
        
        # Check if VPC exists
        try:
            vpc_response = ec2.describe_vpcs(VpcIds=[vpc_id])
            if not vpc_response['Vpcs']:
                return {
                    'control_id': 'EC2.6',
                    'vpc_id': vpc_id,
                    'status': 'ERROR',
                    'message': f'VPC {vpc_id} not found',
                    'timestamp': datetime.now().isoformat()
                }
        except ClientError as e:
            return {
                'control_id': 'EC2.6',
                'vpc_id': vpc_id,
                'status': 'ERROR',
                'message': f'VPC {vpc_id} not accessible: {str(e)}',
                'timestamp': datetime.now().isoformat()
            }
        
        # IAM-SAFE: Check existing flow logs
        try:
            flow_logs_response = ec2.describe_flow_logs(
                Filters=[
                    {'Name': 'resource-id', 'Values': [vpc_id]}
                ]
            )
            existing_flow_logs = flow_logs_response.get('FlowLogs', [])
            active_flow_logs = [fl for fl in existing_flow_logs if fl.get('FlowLogStatus') == 'ACTIVE']
            flow_logs_enabled = len(active_flow_logs) > 0
        except ClientError:
            flow_logs_enabled = False
            existing_flow_logs = []
            active_flow_logs = []
        
        result = {
            'control_id': 'EC2.6',
            'vpc_id': vpc_id,
            'timestamp': datetime.now().isoformat(),
            'existing_flow_logs': len(active_flow_logs),
            'iam_safe_approach': True
        }
        
        if flow_logs_enabled:
            result['status'] = 'COMPLIANT'
            result['message'] = f'VPC flow logging already enabled for VPC {vpc_id} ({len(active_flow_logs)} active logs)'
            result['needs_remediation'] = False
            
            verification = verify_vpc_flow_logs_compliance(ec2, vpc_id)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'EC2.6 compliance verified: VPC flow logging already enabled for VPC {vpc_id} (IAM-Safe validation)',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would enable VPC flow logging for VPC {vpc_id}'
            return result
        
        # Create log group for flow logs
        log_group_name = f'/aws/vpc/flowlogs/{vpc_id}'
        try:
            logs.create_log_group(logGroupName=log_group_name)
        except ClientError as e:
            if e.response['Error']['Code'] != 'ResourceAlreadyExistsException':
                raise
        
        # Create IAM role for flow logs
        role_arn = create_flow_logs_role(iam)
        
        # IAM-SAFE: Create VPC flow logs (additive, preserves existing)
        flow_log_response = ec2.create_flow_logs(
            ResourceIds=[vpc_id],
            ResourceType='VPC',
            TrafficType='ALL',
            LogDestinationType='cloud-watch-logs',
            LogGroupName=log_group_name,
            DeliverLogsPermissionArn=role_arn,
            LogFormat='${version} ${account-id} ${interface-id} ${srcaddr} ${dstaddr} ${srcport} ${dstport} ${protocol} ${packets} ${bytes} ${start} ${end} ${action} ${log-status}'
        )
        
        flow_log_ids = flow_log_response.get('FlowLogIds', [])
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'IAM-Safe: Enabled VPC flow logging for VPC {vpc_id} (Log Group: {log_group_name})'
        result['needs_remediation'] = True
        result['flow_log_ids'] = flow_log_ids
        result['log_group'] = log_group_name
        
        # Verify remediation was successful
        verification = verify_vpc_flow_logs_compliance(ec2, vpc_id)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'EC2.6 remediation completed (IAM-Safe): Enabled VPC flow logging for VPC {vpc_id} with log group {log_group_name}',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'VPC flow logging enabled but verification failed for VPC {vpc_id}'
        
        return result
        
    except Exception as e:
        return {
            'control_id': 'EC2.6',
            'vpc_id': vpc_id,
            'status': 'ERROR',
            'message': f'IAM-Safe remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='VPC Flow Logs Remediation (IAM-Safe)')
    parser.add_argument('--vpc-id', required=True, help='VPC ID to enable flow logs for')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 VPC Remediation: Flow Logs (IAM-Safe)")
    print(f"VPC: {args.vpc_id}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    result = remediate_vpc_flow_logs_iam_safe(
        vpc_id=args.vpc_id,
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
    
    if result.get('existing_flow_logs') is not None:
        print(f"📋 Existing flow logs: {result['existing_flow_logs']}")
    
    if result.get('log_group'):
        print(f"📋 Log group: {result['log_group']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: EC2.6 VPC flow logging confirmed (IAM-Safe)")
        else:
            print(f"\n❌ VERIFICATION: EC2.6 VPC flow logging failed")
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
