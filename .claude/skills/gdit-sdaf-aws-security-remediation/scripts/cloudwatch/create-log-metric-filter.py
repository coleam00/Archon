#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
CloudWatch Remediation: Create log metric filters and alarms for security monitoring
IAM-Safe approach: Only create if not already configured, preserve existing filters
"""

import boto3
import json
import argparse
from datetime import datetime
from botocore.exceptions import ClientError

# Predefined metric filter configurations
METRIC_FILTER_CONFIGS = {
    'CloudWatch.1': {
        'filter_name': 'RootUserUsage',
        'filter_pattern': '{ $.userIdentity.type = "Root" && $.userIdentity.invokedBy NOT EXISTS && $.eventType != "AwsServiceEvent" }',
        'metric_name': 'RootUserUsageCount',
        'description': 'Monitors usage of root user account'
    },
    'CloudWatch.2': {
        'filter_name': 'UnauthorizedAPICalls',
        'filter_pattern': '{ ($.errorCode = "*UnauthorizedOperation") || ($.errorCode = "AccessDenied*") }',
        'metric_name': 'UnauthorizedAPICallsCount',
        'description': 'Monitors unauthorized API calls'
    },
    'CloudWatch.4': {
        'filter_name': 'IAMPolicyChanges',
        'filter_pattern': '{ ($.eventName=DeleteGroupPolicy) || ($.eventName=DeleteRolePolicy) || ($.eventName=DeleteUserPolicy) || ($.eventName=PutGroupPolicy) || ($.eventName=PutRolePolicy) || ($.eventName=PutUserPolicy) || ($.eventName=CreateRole) || ($.eventName=DeleteRole) || ($.eventName=CreatePolicy) || ($.eventName=DeletePolicy) || ($.eventName=CreatePolicyVersion) || ($.eventName=DeletePolicyVersion) || ($.eventName=AttachRolePolicy) || ($.eventName=DetachRolePolicy) || ($.eventName=AttachUserPolicy) || ($.eventName=DetachUserPolicy) || ($.eventName=AttachGroupPolicy) || ($.eventName=DetachGroupPolicy) }',
        'metric_name': 'IAMPolicyChangesCount',
        'description': 'Monitors IAM policy changes'
    },
    'CloudWatch.5': {
        'filter_name': 'CloudTrailConfigChanges',
        'filter_pattern': '{ ($.eventName = CreateTrail) || ($.eventName = UpdateTrail) || ($.eventName = DeleteTrail) || ($.eventName = StartLogging) || ($.eventName = StopLogging) }',
        'metric_name': 'CloudTrailConfigChangesCount',
        'description': 'Monitors CloudTrail configuration changes'
    },
    'CloudWatch.6': {
        'filter_name': 'ConsoleAuthFailures',
        'filter_pattern': '{ ($.eventName = ConsoleLogin) && ($.errorMessage = "Failed authentication") }',
        'metric_name': 'ConsoleAuthFailuresCount',
        'description': 'Monitors console authentication failures'
    },
    'CloudWatch.7': {
        'filter_name': 'CMKDeletion',
        'filter_pattern': '{ ($.eventSource = kms.amazonaws.com) && (($.eventName=DisableKey) || ($.eventName=ScheduleKeyDeletion)) }',
        'metric_name': 'CMKDeletionCount',
        'description': 'Monitors CMK deletion or disabling'
    },
    'CloudWatch.8': {
        'filter_name': 'S3BucketPolicyChanges',
        'filter_pattern': '{ ($.eventSource = s3.amazonaws.com) && (($.eventName = PutBucketAcl) || ($.eventName = PutBucketPolicy) || ($.eventName = PutBucketCors) || ($.eventName = PutBucketLifecycle) || ($.eventName = PutBucketReplication) || ($.eventName = DeleteBucketPolicy) || ($.eventName = DeleteBucketCors) || ($.eventName = DeleteBucketLifecycle) || ($.eventName = DeleteBucketReplication)) }',
        'metric_name': 'S3BucketPolicyChangesCount',
        'description': 'Monitors S3 bucket policy changes'
    },
    'CloudWatch.9': {
        'filter_name': 'AWSConfigChanges',
        'filter_pattern': '{ ($.eventSource = config.amazonaws.com) && (($.eventName=StopConfigurationRecorder) || ($.eventName=DeleteDeliveryChannel) || ($.eventName=PutDeliveryChannel) || ($.eventName=PutConfigurationRecorder)) }',
        'metric_name': 'AWSConfigChangesCount',
        'description': 'Monitors AWS Config changes'
    },
    'CloudWatch.10': {
        'filter_name': 'SecurityGroupChanges',
        'filter_pattern': '{ ($.eventName = AuthorizeSecurityGroupIngress) || ($.eventName = AuthorizeSecurityGroupEgress) || ($.eventName = RevokeSecurityGroupIngress) || ($.eventName = RevokeSecurityGroupEgress) || ($.eventName = CreateSecurityGroup) || ($.eventName = DeleteSecurityGroup) }',
        'metric_name': 'SecurityGroupChangesCount',
        'description': 'Monitors security group changes'
    },
    'CloudWatch.11': {
        'filter_name': 'NACLChanges',
        'filter_pattern': '{ ($.eventName = CreateNetworkAcl) || ($.eventName = CreateNetworkAclEntry) || ($.eventName = DeleteNetworkAcl) || ($.eventName = DeleteNetworkAclEntry) || ($.eventName = ReplaceNetworkAclEntry) || ($.eventName = ReplaceNetworkAclAssociation) }',
        'metric_name': 'NACLChangesCount',
        'description': 'Monitors Network ACL changes'
    },
    'CloudWatch.12': {
        'filter_name': 'NetworkGatewayChanges',
        'filter_pattern': '{ ($.eventName = CreateCustomerGateway) || ($.eventName = DeleteCustomerGateway) || ($.eventName = AttachInternetGateway) || ($.eventName = CreateInternetGateway) || ($.eventName = DeleteInternetGateway) || ($.eventName = DetachInternetGateway) }',
        'metric_name': 'NetworkGatewayChangesCount',
        'description': 'Monitors network gateway changes'
    },
    'CloudWatch.13': {
        'filter_name': 'RouteTableChanges',
        'filter_pattern': '{ ($.eventName = CreateRoute) || ($.eventName = CreateRouteTable) || ($.eventName = ReplaceRoute) || ($.eventName = ReplaceRouteTableAssociation) || ($.eventName = DeleteRouteTable) || ($.eventName = DeleteRoute) || ($.eventName = DisassociateRouteTable) }',
        'metric_name': 'RouteTableChangesCount',
        'description': 'Monitors route table changes'
    },
    'CloudWatch.14': {
        'filter_name': 'VPCChanges',
        'filter_pattern': '{ ($.eventName = CreateVpc) || ($.eventName = DeleteVpc) || ($.eventName = ModifyVpcAttribute) || ($.eventName = AcceptVpcPeeringConnection) || ($.eventName = CreateVpcPeeringConnection) || ($.eventName = DeleteVpcPeeringConnection) || ($.eventName = RejectVpcPeeringConnection) || ($.eventName = AttachClassicLinkVpc) || ($.eventName = DetachClassicLinkVpc) || ($.eventName = DisableVpcClassicLink) || ($.eventName = EnableVpcClassicLink) }',
        'metric_name': 'VPCChangesCount',
        'description': 'Monitors VPC changes'
    }
}

def verify_metric_filter_compliance(logs_client, log_group_name, filter_name):
    """Verify that metric filter exists"""
    try:
        filters_response = logs_client.describe_metric_filters(
            logGroupName=log_group_name,
            filterNamePrefix=filter_name
        )
        
        filters = filters_response.get('metricFilters', [])
        filter_exists = any(f['filterName'] == filter_name for f in filters)
        
        return {
            'overall_compliant': filter_exists,
            'settings': {
                'metric_filter': {
                    'required': True,
                    'actual': filter_exists,
                    'compliant': filter_exists,
                    'filter_name': filter_name
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

def remediate_cloudwatch_metric_filter_iam_safe(control_id, log_group_name, profile_name, region, dry_run=False, finding_arn=None):
    """
    IAM-Safe CloudWatch remediation: Only create metric filter if not already configured
    Preserves existing metric filters
    """
    
    try:
        session = boto3.Session(profile_name=profile_name)
        logs = session.client('logs', region_name=region)
        cloudwatch = session.client('cloudwatch', region_name=region)
        
        # Get metric filter configuration
        if control_id not in METRIC_FILTER_CONFIGS:
            return {
                'control_id': control_id,
                'status': 'ERROR',
                'message': f'No configuration found for control {control_id}',
                'timestamp': datetime.now().isoformat()
            }
        
        config = METRIC_FILTER_CONFIGS[control_id]
        filter_name = config['filter_name']
        
        # Check if log group exists, create if needed
        try:
            logs.describe_log_groups(logGroupNamePrefix=log_group_name, limit=1)
            log_groups = logs.describe_log_groups(logGroupNamePrefix=log_group_name, limit=1)['logGroups']
            log_group_exists = any(lg['logGroupName'] == log_group_name for lg in log_groups)
        except ClientError:
            log_group_exists = False
        
        if not log_group_exists:
            if dry_run:
                return {
                    'control_id': control_id,
                    'log_group': log_group_name,
                    'status': 'DRY_RUN',
                    'message': f'Would create log group {log_group_name} and metric filter {filter_name}',
                    'timestamp': datetime.now().isoformat()
                }
            
            # Create log group
            logs.create_log_group(logGroupName=log_group_name)
        
        # IAM-SAFE: Check existing metric filters
        try:
            filters_response = logs.describe_metric_filters(
                logGroupName=log_group_name,
                filterNamePrefix=filter_name
            )
            existing_filters = filters_response.get('metricFilters', [])
            filter_exists = any(f['filterName'] == filter_name for f in existing_filters)
        except ClientError:
            filter_exists = False
        
        result = {
            'control_id': control_id,
            'log_group': log_group_name,
            'filter_name': filter_name,
            'timestamp': datetime.now().isoformat(),
            'existing_filter': filter_exists,
            'iam_safe_approach': True
        }
        
        if filter_exists:
            result['status'] = 'COMPLIANT'
            result['message'] = f'Metric filter {filter_name} already exists in log group {log_group_name}'
            result['needs_remediation'] = False
            
            verification = verify_metric_filter_compliance(logs, log_group_name, filter_name)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'{control_id} compliance verified: Metric filter {filter_name} already exists (IAM-Safe validation)',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would create metric filter {filter_name} in log group {log_group_name}'
            return result
        
        # IAM-SAFE: Create metric filter (additive, preserves existing)
        metric_transformation = {
            'metricName': config['metric_name'],
            'metricNamespace': 'SecurityCompliance',
            'metricValue': '1',
            'defaultValue': 0
        }
        
        logs.put_metric_filter(
            logGroupName=log_group_name,
            filterName=filter_name,
            filterPattern=config['filter_pattern'],
            metricTransformations=[metric_transformation]
        )
        
        # Create CloudWatch alarm
        alarm_name = f'SecurityCompliance-{config["metric_name"]}'
        cloudwatch.put_metric_alarm(
            AlarmName=alarm_name,
            AlarmDescription=config['description'],
            ActionsEnabled=True,
            MetricName=config['metric_name'],
            Namespace='SecurityCompliance',
            Statistic='Sum',
            Period=300,
            EvaluationPeriods=1,
            Threshold=1.0,
            ComparisonOperator='GreaterThanOrEqualToThreshold',
            TreatMissingData='notBreaching'
        )
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'IAM-Safe: Created metric filter {filter_name} and alarm {alarm_name}'
        result['needs_remediation'] = True
        result['alarm_name'] = alarm_name
        
        # Verify remediation was successful
        verification = verify_metric_filter_compliance(logs, log_group_name, filter_name)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'{control_id} remediation completed (IAM-Safe): Created metric filter {filter_name} and alarm {alarm_name}',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'Metric filter created but verification failed for {filter_name}'
        
        return result
        
    except Exception as e:
        return {
            'control_id': control_id,
            'status': 'ERROR',
            'message': f'IAM-Safe remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='CloudWatch Log Metric Filter Remediation (IAM-Safe)')
    parser.add_argument('--control-id', required=True, help='CloudWatch control ID (e.g., CloudWatch.1)')
    parser.add_argument('--log-group', default='/aws/cloudtrail/security-logs', help='CloudWatch log group name')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 CloudWatch Remediation: Log Metric Filter (IAM-Safe)")
    print(f"Control: {args.control_id}")
    print(f"Log Group: {args.log_group}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    result = remediate_cloudwatch_metric_filter_iam_safe(
        control_id=args.control_id,
        log_group_name=args.log_group,
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
    
    if result.get('existing_filter') is not None:
        print(f"📋 Previous filter status: {result['existing_filter']}")
    
    if result.get('alarm_name'):
        print(f"📋 Alarm created: {result['alarm_name']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: {args.control_id} metric filter confirmed (IAM-Safe)")
        else:
            print(f"\n❌ VERIFICATION: {args.control_id} metric filter failed")
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
