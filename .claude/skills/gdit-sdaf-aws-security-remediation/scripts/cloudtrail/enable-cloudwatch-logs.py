#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
CloudTrail.5 Remediation: CloudTrail trails should be integrated with Amazon CloudWatch Logs
IAM-Safe approach: Only enable if not already configured, preserve existing trail configuration
"""

import boto3
import json
import argparse
from datetime import datetime
from botocore.exceptions import ClientError

def verify_cloudtrail_cloudwatch_compliance(cloudtrail_client, trail_name):
    """Verify that CloudTrail has CloudWatch Logs integration"""
    try:
        trail_response = cloudtrail_client.describe_trails(trailNameList=[trail_name])
        trails = trail_response.get('trailList', [])
        
        if not trails:
            return {
                'overall_compliant': False,
                'error': f'Trail {trail_name} not found',
                'verification_timestamp': datetime.now().isoformat()
            }
        
        trail = trails[0]
        cloudwatch_logs_arn = trail.get('CloudWatchLogsLogGroupArn')
        has_cloudwatch_integration = bool(cloudwatch_logs_arn)
        
        return {
            'overall_compliant': has_cloudwatch_integration,
            'settings': {
                'cloudwatch_integration': {
                    'required': True,
                    'actual': has_cloudwatch_integration,
                    'compliant': has_cloudwatch_integration,
                    'log_group_arn': cloudwatch_logs_arn or 'None'
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

def create_cloudwatch_logs_role(iam_client, account_id):
    """Create IAM role for CloudTrail CloudWatch Logs if it doesn't exist"""
    role_name = 'CloudTrailLogsRole'
    
    try:
        # Check if role exists
        role_response = iam_client.get_role(RoleName=role_name)
        return role_response['Role']['Arn']
    except ClientError as e:
        if e.response['Error']['Code'] == 'NoSuchEntity':
            # Create role
            trust_policy = {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Principal": {
                            "Service": "cloudtrail.amazonaws.com"
                        },
                        "Action": "sts:AssumeRole"
                    }
                ]
            }
            
            role_response = iam_client.create_role(
                RoleName=role_name,
                AssumeRolePolicyDocument=json.dumps(trust_policy),
                Description='Role for CloudTrail to deliver logs to CloudWatch'
            )
            
            # Attach policy
            policy_document = {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Action": [
                            "logs:CreateLogStream",
                            "logs:PutLogEvents"
                        ],
                        "Resource": f"arn:aws:logs:*:{account_id}:log-group:/aws/cloudtrail/*"
                    }
                ]
            }
            
            iam_client.put_role_policy(
                RoleName=role_name,
                PolicyName='CloudTrailLogsPolicy',
                PolicyDocument=json.dumps(policy_document)
            )
            
            return role_response['Role']['Arn']
        else:
            raise

def remediate_cloudtrail_cloudwatch_iam_safe(trail_name, profile_name, region, dry_run=False, finding_arn=None):
    """
    IAM-Safe CloudTrail CloudWatch integration: Only enable if not already configured
    Preserves existing trail configuration
    """
    
    try:
        session = boto3.Session(profile_name=profile_name)
        cloudtrail = session.client('cloudtrail', region_name=region)
        logs = session.client('logs', region_name=region)
        iam = session.client('iam', region_name=region)
        sts = session.client('sts', region_name=region)
        
        # Get account ID
        account_id = sts.get_caller_identity()['Account']
        
        # Check if trail exists
        try:
            trail_response = cloudtrail.describe_trails(trailNameList=[trail_name])
            trails = trail_response.get('trailList', [])
            if not trails:
                return {
                    'control_id': 'CloudTrail.5',
                    'trail_name': trail_name,
                    'status': 'ERROR',
                    'message': f'Trail {trail_name} not found',
                    'timestamp': datetime.now().isoformat()
                }
            trail = trails[0]
        except ClientError as e:
            return {
                'control_id': 'CloudTrail.5',
                'trail_name': trail_name,
                'status': 'ERROR',
                'message': f'Trail {trail_name} not accessible: {str(e)}',
                'timestamp': datetime.now().isoformat()
            }
        
        # IAM-SAFE: Check existing CloudWatch integration
        existing_log_group_arn = trail.get('CloudWatchLogsLogGroupArn')
        has_cloudwatch_integration = bool(existing_log_group_arn)
        
        result = {
            'control_id': 'CloudTrail.5',
            'trail_name': trail_name,
            'timestamp': datetime.now().isoformat(),
            'existing_integration': has_cloudwatch_integration,
            'iam_safe_approach': True
        }
        
        if has_cloudwatch_integration:
            result['status'] = 'COMPLIANT'
            result['message'] = f'CloudTrail {trail_name} already integrated with CloudWatch Logs ({existing_log_group_arn})'
            result['needs_remediation'] = False
            
            verification = verify_cloudtrail_cloudwatch_compliance(cloudtrail, trail_name)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'CloudTrail.5 compliance verified: CloudTrail {trail_name} already integrated with CloudWatch Logs (IAM-Safe validation)',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would enable CloudWatch Logs integration for CloudTrail {trail_name}'
            return result
        
        # Create log group for CloudTrail
        # Extract trail name from ARN for log group naming
        if trail_name.startswith('arn:'):
            trail_simple_name = trail_name.split('/')[-1]
        else:
            trail_simple_name = trail_name
        
        log_group_name = f'/aws/cloudtrail/{trail_simple_name}'
        try:
            logs.create_log_group(logGroupName=log_group_name)
        except ClientError as e:
            if e.response['Error']['Code'] != 'ResourceAlreadyExistsException':
                raise
        
        # Create IAM role for CloudTrail
        role_arn = create_cloudwatch_logs_role(iam, account_id)
        
        # IAM-SAFE: Update CloudTrail with CloudWatch integration
        cloudtrail.update_trail(
            Name=trail_name,
            CloudWatchLogsLogGroupArn=f'arn:aws:logs:{region}:{account_id}:log-group:{log_group_name}:*',
            CloudWatchLogsRoleArn=role_arn
        )
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'IAM-Safe: Enabled CloudWatch Logs integration for CloudTrail {trail_name}'
        result['needs_remediation'] = True
        result['log_group'] = log_group_name
        result['role_arn'] = role_arn
        
        # Verify remediation was successful
        verification = verify_cloudtrail_cloudwatch_compliance(cloudtrail, trail_name)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'CloudTrail.5 remediation completed (IAM-Safe): Enabled CloudWatch Logs integration for CloudTrail {trail_name}',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'CloudWatch integration enabled but verification failed for CloudTrail {trail_name}'
        
        return result
        
    except Exception as e:
        return {
            'control_id': 'CloudTrail.5',
            'trail_name': trail_name,
            'status': 'ERROR',
            'message': f'IAM-Safe remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='CloudTrail CloudWatch Logs Integration (IAM-Safe)')
    parser.add_argument('--trail-name', required=True, help='CloudTrail trail name')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 CloudTrail Remediation: CloudWatch Logs Integration (IAM-Safe)")
    print(f"Trail: {args.trail_name}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    result = remediate_cloudtrail_cloudwatch_iam_safe(
        trail_name=args.trail_name,
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
    
    if result.get('existing_integration') is not None:
        print(f"📋 Previous integration: {result['existing_integration']}")
    
    if result.get('log_group'):
        print(f"📋 Log group: {result['log_group']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: CloudTrail.5 CloudWatch integration confirmed (IAM-Safe)")
        else:
            print(f"\n❌ VERIFICATION: CloudTrail.5 CloudWatch integration failed")
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
