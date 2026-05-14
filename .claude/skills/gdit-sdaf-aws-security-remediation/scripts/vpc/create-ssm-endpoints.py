#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
EC2-58 Remediation: Create VPC Endpoints for Systems Manager (IAM-Safe)
Creates VPC interface endpoints for SSM services.
"""

import boto3
import argparse
import sys
from datetime import datetime

def create_ssm_vpc_endpoints(vpc_id, subnet_ids, profile='default', region='us-east-1', dry_run=False):
    """Create VPC endpoints for Systems Manager services"""
    
    session = boto3.Session(profile_name=profile)
    ec2 = session.client('ec2', region_name=region)
    
    # SSM services that need VPC endpoints
    ssm_services = [
        f'com.amazonaws.{region}.ssm',
        f'com.amazonaws.{region}.ssmmessages',
        f'com.amazonaws.{region}.ec2messages'
    ]
    
    try:
        # Check existing endpoints
        response = ec2.describe_vpc_endpoints(
            Filters=[
                {'Name': 'vpc-id', 'Values': [vpc_id]},
                {'Name': 'service-name', 'Values': ssm_services}
            ]
        )
        
        existing_services = {ep['ServiceName'] for ep in response['VpcEndpoints']}
        needed_services = [svc for svc in ssm_services if svc not in existing_services]
        
        if not needed_services:
            print(f"✅ COMPLIANT: VPC {vpc_id} already has all required SSM endpoints")
            return True
        
        if dry_run:
            print(f"🔍 DRY RUN: Would create endpoints for: {', '.join(needed_services)}")
            return True
        
        # Get default security group for VPC
        sg_response = ec2.describe_security_groups(
            Filters=[
                {'Name': 'vpc-id', 'Values': [vpc_id]},
                {'Name': 'group-name', 'Values': ['default']}
            ]
        )
        
        if not sg_response['SecurityGroups']:
            print(f"❌ ERROR: No default security group found for VPC {vpc_id}")
            return False
        
        security_group_id = sg_response['SecurityGroups'][0]['GroupId']
        
        # Create endpoints
        created_endpoints = []
        for service in needed_services:
            print(f"🔧 Creating VPC endpoint for {service}...")
            
            try:
                endpoint_response = ec2.create_vpc_endpoint(
                    VpcId=vpc_id,
                    ServiceName=service,
                    VpcEndpointType='Interface',
                    SubnetIds=subnet_ids,
                    SecurityGroupIds=[security_group_id],
                    PrivateDnsEnabled=True
                )
                
                endpoint_id = endpoint_response['VpcEndpoint']['VpcEndpointId']
                created_endpoints.append(f"{service} ({endpoint_id})")
                
            except Exception as e:
                print(f"⚠️ Failed to create endpoint for {service}: {e}")
        
        if created_endpoints:
            print(f"✅ SUCCESS: Created VPC endpoints: {', '.join(created_endpoints)}")
        
        return len(created_endpoints) > 0
        
    except Exception as e:
        print(f"❌ ERROR: Failed to create VPC endpoints for {vpc_id}: {e}")
        return False

def update_security_hub_finding(finding_id, vpc_id, profile='default', region='us-east-1'):
    """Update Security Hub finding status"""
    
    if not finding_id:
        return
    
    try:
        session = boto3.Session(profile_name=profile)
        securityhub = session.client('securityhub', region_name=region)
        
        securityhub.batch_update_findings(
            FindingIdentifiers=[{
                'Id': finding_id,
                'ProductArn': f'arn:aws:securityhub:{region}::product/aws/securityhub'
            }],
            Workflow={'Status': 'RESOLVED'},
            Note={
                'Text': f'VPC endpoints for Systems Manager created in {vpc_id} via automated remediation',
                'UpdatedBy': 'GDIT-Security-Compliance-Automation'
            }
        )
        print(f"✅ Security Hub finding updated: {finding_id}")
        
    except Exception as e:
        print(f"⚠️ Could not update Security Hub finding: {e}")

def main():
    parser = argparse.ArgumentParser(description='Create VPC endpoints for Systems Manager')
    parser.add_argument('--vpc-id', required=True, help='VPC ID')
    parser.add_argument('--subnet-ids', required=True, help='Comma-separated subnet IDs')
    parser.add_argument('--profile', default='default', help='AWS profile')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Dry run mode')
    parser.add_argument('--finding-id', help='Security Hub finding ID to update')
    
    args = parser.parse_args()
    
    subnet_list = [s.strip() for s in args.subnet_ids.split(',')]
    
    print(f"🔧 EC2-58 Remediation: VPC Endpoints for SSM (IAM-Safe)")
    print(f"VPC: {args.vpc_id}")
    print(f"Subnets: {', '.join(subnet_list)}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    print()
    
    success = create_ssm_vpc_endpoints(
        args.vpc_id,
        subnet_list,
        args.profile, 
        args.region, 
        args.dry_run
    )
    
    if success and not args.dry_run:
        update_security_hub_finding(args.finding_id, args.vpc_id, args.profile, args.region)
    
    print(f"\n✅ VERIFICATION: VPC endpoints {'created' if success else 'failed'} (IAM-Safe)")
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
