#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
VPC Endpoint Remediation: Create VPC interface endpoints for AWS services
IAM-Safe approach: Only create if not already configured, preserve existing endpoints
"""

import boto3
import json
import argparse
from datetime import datetime
from botocore.exceptions import ClientError

# VPC Endpoint service configurations
VPC_ENDPOINT_CONFIGS = {
    'EC2.55': {
        'service_name': 'com.amazonaws.us-east-1.ecr.api',
        'endpoint_type': 'Interface',
        'description': 'ECR API endpoint for container registry access'
    },
    'EC2.56': {
        'service_name': 'com.amazonaws.us-east-1.ecr.dkr',
        'endpoint_type': 'Interface',
        'description': 'ECR Docker Registry endpoint'
    },
    'EC2.57': {
        'service_name': 'com.amazonaws.us-east-1.ssm',
        'endpoint_type': 'Interface',
        'description': 'Systems Manager endpoint'
    },
    'EC2.58': {
        'service_name': 'com.amazonaws.us-east-1.ssm-contacts',
        'endpoint_type': 'Interface',
        'description': 'Systems Manager Incident Manager Contacts endpoint'
    },
    'EC2.60': {
        'service_name': 'com.amazonaws.us-east-1.ssm-incidents',
        'endpoint_type': 'Interface',
        'description': 'Systems Manager Incident Manager endpoint'
    },
    'EC2.10': {
        'service_name': 'com.amazonaws.us-east-1.ec2',
        'endpoint_type': 'Interface',
        'description': 'EC2 service endpoint'
    }
}

def verify_vpc_endpoint_compliance(ec2_client, vpc_id, service_name):
    """Verify that VPC endpoint exists for the service"""
    try:
        endpoints_response = ec2_client.describe_vpc_endpoints(
            Filters=[
                {'Name': 'vpc-id', 'Values': [vpc_id]},
                {'Name': 'service-name', 'Values': [service_name]}
            ]
        )
        
        endpoints = endpoints_response.get('VpcEndpoints', [])
        endpoint_exists = len(endpoints) > 0 and any(ep['State'] == 'available' for ep in endpoints)
        
        return {
            'overall_compliant': endpoint_exists,
            'settings': {
                'vpc_endpoint': {
                    'required': True,
                    'actual': endpoint_exists,
                    'compliant': endpoint_exists,
                    'service_name': service_name,
                    'vpc_id': vpc_id
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

def remediate_vpc_endpoint_iam_safe(control_id, vpc_id, profile_name, region, dry_run=False, finding_arn=None):
    """
    IAM-Safe VPC endpoint remediation: Only create if not already configured
    Preserves existing VPC endpoints
    """
    
    try:
        session = boto3.Session(profile_name=profile_name)
        ec2 = session.client('ec2', region_name=region)
        
        # Get endpoint configuration
        if control_id not in VPC_ENDPOINT_CONFIGS:
            return {
                'control_id': control_id,
                'status': 'ERROR',
                'message': f'No configuration found for control {control_id}',
                'timestamp': datetime.now().isoformat()
            }
        
        config = VPC_ENDPOINT_CONFIGS[control_id]
        service_name = config['service_name']
        
        # Check if VPC exists
        try:
            vpc_response = ec2.describe_vpcs(VpcIds=[vpc_id])
            if not vpc_response['Vpcs']:
                return {
                    'control_id': control_id,
                    'vpc_id': vpc_id,
                    'status': 'ERROR',
                    'message': f'VPC {vpc_id} not found',
                    'timestamp': datetime.now().isoformat()
                }
        except ClientError as e:
            return {
                'control_id': control_id,
                'vpc_id': vpc_id,
                'status': 'ERROR',
                'message': f'VPC {vpc_id} not accessible: {str(e)}',
                'timestamp': datetime.now().isoformat()
            }
        
        # IAM-SAFE: Check existing VPC endpoints
        try:
            endpoints_response = ec2.describe_vpc_endpoints(
                Filters=[
                    {'Name': 'vpc-id', 'Values': [vpc_id]},
                    {'Name': 'service-name', 'Values': [service_name]}
                ]
            )
            existing_endpoints = endpoints_response.get('VpcEndpoints', [])
            endpoint_exists = len(existing_endpoints) > 0 and any(ep['State'] == 'available' for ep in existing_endpoints)
        except ClientError:
            endpoint_exists = False
        
        result = {
            'control_id': control_id,
            'vpc_id': vpc_id,
            'service_name': service_name,
            'timestamp': datetime.now().isoformat(),
            'existing_endpoint': endpoint_exists,
            'iam_safe_approach': True
        }
        
        if endpoint_exists:
            result['status'] = 'COMPLIANT'
            result['message'] = f'VPC endpoint for {service_name} already exists in VPC {vpc_id}'
            result['needs_remediation'] = False
            
            verification = verify_vpc_endpoint_compliance(ec2, vpc_id, service_name)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'{control_id} compliance verified: VPC endpoint for {service_name} already exists (IAM-Safe validation)',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would create VPC endpoint for {service_name} in VPC {vpc_id}'
            return result
        
        # Get subnets for the VPC
        subnets_response = ec2.describe_subnets(
            Filters=[{'Name': 'vpc-id', 'Values': [vpc_id]}]
        )
        subnet_ids = [subnet['SubnetId'] for subnet in subnets_response['Subnets']]
        
        if not subnet_ids:
            return {
                'control_id': control_id,
                'vpc_id': vpc_id,
                'status': 'ERROR',
                'message': f'No subnets found in VPC {vpc_id}',
                'timestamp': datetime.now().isoformat()
            }
        
        # IAM-SAFE: Create VPC endpoint (additive, preserves existing)
        endpoint_response = ec2.create_vpc_endpoint(
            VpcId=vpc_id,
            ServiceName=service_name,
            VpcEndpointType=config['endpoint_type'],
            SubnetIds=subnet_ids[:2],  # Use first 2 subnets for HA
            PrivateDnsEnabled=False,  # Disable to avoid DNS conflicts
            PolicyDocument=json.dumps({
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Principal": "*",
                        "Action": "*",
                        "Resource": "*"
                    }
                ]
            })
        )
        
        endpoint_id = endpoint_response['VpcEndpoint']['VpcEndpointId']
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'IAM-Safe: Created VPC endpoint {endpoint_id} for {service_name}'
        result['needs_remediation'] = True
        result['endpoint_id'] = endpoint_id
        
        # Verify remediation was successful
        verification = verify_vpc_endpoint_compliance(ec2, vpc_id, service_name)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'{control_id} remediation completed (IAM-Safe): Created VPC endpoint {endpoint_id} for {service_name}',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'VPC endpoint created but verification failed for {service_name}'
        
        return result
        
    except Exception as e:
        return {
            'control_id': control_id,
            'status': 'ERROR',
            'message': f'IAM-Safe remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='VPC Endpoint Remediation (IAM-Safe)')
    parser.add_argument('--control-id', required=True, help='VPC control ID (e.g., EC2.55)')
    parser.add_argument('--vpc-id', required=True, help='VPC ID to create endpoint in')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 VPC Remediation: VPC Endpoint Creation (IAM-Safe)")
    print(f"Control: {args.control_id}")
    print(f"VPC: {args.vpc_id}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    result = remediate_vpc_endpoint_iam_safe(
        control_id=args.control_id,
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
    
    if result.get('existing_endpoint') is not None:
        print(f"📋 Previous endpoint status: {result['existing_endpoint']}")
    
    if result.get('endpoint_id'):
        print(f"📋 Endpoint created: {result['endpoint_id']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: {args.control_id} VPC endpoint confirmed (IAM-Safe)")
        else:
            print(f"\n❌ VERIFICATION: {args.control_id} VPC endpoint failed")
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
