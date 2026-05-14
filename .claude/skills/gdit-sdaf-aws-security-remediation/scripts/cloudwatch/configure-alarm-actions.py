#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
CloudWatch.15 Remediation: CloudWatch alarms should have specified actions configured
IAM-Safe approach: Add actions to existing alarms, preserve existing alarm configuration
Uses existing SNS topic from CloudFormation: Marketplace-Messaging-dev
"""

import boto3
import argparse
from datetime import datetime
from botocore.exceptions import ClientError

def verify_alarm_actions_compliance(cloudwatch_client, alarm_name):
    """Verify that CloudWatch alarm has actions configured"""
    try:
        alarms_response = cloudwatch_client.describe_alarms(AlarmNames=[alarm_name])
        alarms = alarms_response.get('MetricAlarms', [])
        
        if not alarms:
            return {
                'overall_compliant': False,
                'error': f'Alarm {alarm_name} not found',
                'verification_timestamp': datetime.now().isoformat()
            }
        
        alarm = alarms[0]
        alarm_actions = alarm.get('AlarmActions', [])
        ok_actions = alarm.get('OKActions', [])
        insufficient_data_actions = alarm.get('InsufficientDataActions', [])
        
        has_actions = len(alarm_actions) > 0 or len(ok_actions) > 0 or len(insufficient_data_actions) > 0
        
        return {
            'overall_compliant': has_actions,
            'settings': {
                'alarm_actions': {
                    'required': True,
                    'actual': has_actions,
                    'compliant': has_actions,
                    'alarm_actions_count': len(alarm_actions),
                    'ok_actions_count': len(ok_actions),
                    'insufficient_data_actions_count': len(insufficient_data_actions)
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

def get_marketplace_sns_topic_arn(sns_client, environment='dev'):
    """Get the existing Marketplace SNS topic ARN from CloudFormation deployment"""
    try:
        topics_response = sns_client.list_topics()
        topics = topics_response.get('Topics', [])
        
        # Look for the Marketplace-Messaging topic
        marketplace_topic_name = f'Marketplace-Messaging-{environment}'
        
        for topic in topics:
            topic_arn = topic['TopicArn']
            if marketplace_topic_name in topic_arn:
                return topic_arn
        
        return None
        
    except Exception as e:
        raise Exception(f'Failed to find Marketplace SNS topic: {str(e)}')

def remediate_alarm_actions_iam_safe(alarm_name, profile_name, region, environment='dev', dry_run=False, finding_arn=None):
    """
    IAM-Safe CloudWatch alarm actions remediation: Add actions to existing alarms
    Preserves existing alarm configuration, uses existing SNS topic from CloudFormation
    """
    
    try:
        session = boto3.Session(profile_name=profile_name)
        cloudwatch = session.client('cloudwatch', region_name=region)
        sns = session.client('sns', region_name=region)
        
        # Get existing Marketplace SNS topic from CloudFormation
        sns_topic_arn = get_marketplace_sns_topic_arn(sns, environment)
        if not sns_topic_arn:
            return {
                'control_id': 'CloudWatch.15',
                'alarm_name': alarm_name,
                'status': 'ERROR',
                'message': f'Marketplace SNS topic not found for environment {environment}',
                'timestamp': datetime.now().isoformat()
            }
        
        # Check if alarm exists
        try:
            alarms_response = cloudwatch.describe_alarms(AlarmNames=[alarm_name])
            alarms = alarms_response.get('MetricAlarms', [])
            if not alarms:
                return {
                    'control_id': 'CloudWatch.15',
                    'alarm_name': alarm_name,
                    'status': 'ERROR',
                    'message': f'Alarm {alarm_name} not found',
                    'timestamp': datetime.now().isoformat()
                }
            alarm = alarms[0]
        except ClientError as e:
            return {
                'control_id': 'CloudWatch.15',
                'alarm_name': alarm_name,
                'status': 'ERROR',
                'message': f'Alarm {alarm_name} not accessible: {str(e)}',
                'timestamp': datetime.now().isoformat()
            }
        
        # IAM-SAFE: Check existing alarm actions
        existing_alarm_actions = alarm.get('AlarmActions', [])
        existing_ok_actions = alarm.get('OKActions', [])
        existing_insufficient_data_actions = alarm.get('InsufficientDataActions', [])
        
        has_actions = (len(existing_alarm_actions) > 0 or 
                      len(existing_ok_actions) > 0 or 
                      len(existing_insufficient_data_actions) > 0)
        
        result = {
            'control_id': 'CloudWatch.15',
            'alarm_name': alarm_name,
            'timestamp': datetime.now().isoformat(),
            'existing_actions': has_actions,
            'sns_topic_arn': sns_topic_arn,
            'iam_safe_approach': True
        }
        
        if has_actions:
            result['status'] = 'COMPLIANT'
            result['message'] = f'Alarm {alarm_name} already has actions configured'
            result['needs_remediation'] = False
            
            verification = verify_alarm_actions_compliance(cloudwatch, alarm_name)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'CloudWatch.15 compliance verified: Alarm {alarm_name} already has actions configured (IAM-Safe validation)',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would add SNS action to alarm {alarm_name} using existing topic {sns_topic_arn}'
            return result
        
        # IAM-SAFE: Add actions to existing alarm (preserve all existing configuration)
        # Get all current alarm properties to preserve them
        alarm_kwargs = {
            'AlarmName': alarm['AlarmName'],
            'AlarmDescription': alarm.get('AlarmDescription', ''),
            'ActionsEnabled': alarm.get('ActionsEnabled', True),
            'MetricName': alarm.get('MetricName'),
            'Namespace': alarm.get('Namespace'),
            'Statistic': alarm.get('Statistic'),
            'Dimensions': alarm.get('Dimensions', []),
            'Period': alarm.get('Period'),
            'EvaluationPeriods': alarm.get('EvaluationPeriods'),
            'Threshold': alarm.get('Threshold'),
            'ComparisonOperator': alarm.get('ComparisonOperator'),
            'TreatMissingData': alarm.get('TreatMissingData', 'missing'),
            # IAM-SAFE: Preserve existing actions and add new ones
            'AlarmActions': existing_alarm_actions + [sns_topic_arn] if sns_topic_arn not in existing_alarm_actions else existing_alarm_actions,
            'OKActions': existing_ok_actions,
            'InsufficientDataActions': existing_insufficient_data_actions
        }
        
        # Remove None values
        alarm_kwargs = {k: v for k, v in alarm_kwargs.items() if v is not None}
        
        cloudwatch.put_metric_alarm(**alarm_kwargs)
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'IAM-Safe: Added SNS action to alarm {alarm_name} using existing Marketplace topic'
        result['needs_remediation'] = True
        
        # Verify remediation was successful
        verification = verify_alarm_actions_compliance(cloudwatch, alarm_name)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'CloudWatch.15 remediation completed (IAM-Safe): Added SNS action to alarm {alarm_name} using existing Marketplace topic',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'Actions added but verification failed for alarm {alarm_name}'
        
        return result
        
    except Exception as e:
        return {
            'control_id': 'CloudWatch.15',
            'alarm_name': alarm_name,
            'status': 'ERROR',
            'message': f'IAM-Safe remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='CloudWatch Alarm Actions Remediation (IAM-Safe)')
    parser.add_argument('--alarm-name', required=True, help='CloudWatch alarm name')
    parser.add_argument('--environment', default='dev', help='Environment (dev/test/prod)')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 CloudWatch Remediation: Alarm Actions (IAM-Safe)")
    print(f"Alarm: {args.alarm_name}")
    print(f"Environment: {args.environment}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    result = remediate_alarm_actions_iam_safe(
        alarm_name=args.alarm_name,
        profile_name=args.profile,
        region=args.region,
        environment=args.environment,
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
    
    if result.get('existing_actions') is not None:
        print(f"📋 Previous actions: {result['existing_actions']}")
    
    if result.get('sns_topic_arn'):
        print(f"📋 SNS Topic: {result['sns_topic_arn']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: CloudWatch.15 alarm actions confirmed (IAM-Safe)")
        else:
            print(f"\n❌ VERIFICATION: CloudWatch.15 alarm actions failed")
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
