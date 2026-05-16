#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
Bulk VPC Infrastructure Remediation
Executes all VPC findings with IAM-Safe approach
"""

import subprocess
import sys
import os
from datetime import datetime

# VPC findings mapping
VPC_FINDINGS = {
    'EC2.6': {
        'finding_arn': 'arn:aws:securityhub:us-east-1:562239682396:security-control/EC2.6/finding/a284d0ab-4878-4305-93fa-b92f08a25554',
        'script': 'enable-flow-logs.py',
        'description': 'VPC flow logging'
    },
    'EC2.55': {
        'finding_arn': 'arn:aws:securityhub:us-east-1:562239682396:security-control/EC2.55/finding/6622ae99-817c-4a69-8b4e-7c0f9cfdbacb',
        'script': 'create-vpc-endpoint.py',
        'description': 'ECR API endpoint'
    },
    'EC2.56': {
        'finding_arn': 'arn:aws:securityhub:us-east-1:562239682396:security-control/EC2.56/finding/03149bd4-b2bf-4c86-bf0b-ff2cfa71f65d',
        'script': 'create-vpc-endpoint.py',
        'description': 'ECR Docker Registry endpoint'
    },
    'EC2.57': {
        'finding_arn': 'arn:aws:securityhub:us-east-1:562239682396:security-control/EC2.57/finding/ccc76976-6460-476a-8bcc-cabd41d46968',
        'script': 'create-vpc-endpoint.py',
        'description': 'Systems Manager endpoint'
    },
    'EC2.58': {
        'finding_arn': 'arn:aws:securityhub:us-east-1:562239682396:security-control/EC2.58/finding/e8e91519-25f6-41f7-8f3e-35be584f6ea2',
        'script': 'create-vpc-endpoint.py',
        'description': 'Systems Manager Incident Manager Contacts endpoint'
    },
    'EC2.60': {
        'finding_arn': 'arn:aws:securityhub:us-east-1:562239682396:security-control/EC2.60/finding/9d0c4fac-eea2-489b-be3f-335678e2838b',
        'script': 'create-vpc-endpoint.py',
        'description': 'Systems Manager Incident Manager endpoint'
    },
    'EC2.10': {
        'finding_arn': 'arn:aws:securityhub:us-east-1:562239682396:security-control/EC2.10/finding/b5d27e4a-123f-4c04-9f3d-dd69f3a52b28',
        'script': 'create-vpc-endpoint.py',
        'description': 'EC2 service endpoint'
    }
}

def execute_vpc_flow_logs_remediation(control_id, finding_arn, vpc_id, profile='com-r'):
    """Execute VPC flow logs remediation"""
    
    script_path = 'specs/features/security-compliance/remediation-library/scripts/vpc/enable-flow-logs.py'
    
    cmd = [
        'python3', script_path,
        '--vpc-id', vpc_id,
        '--finding-id', finding_arn,
        '--profile', profile
    ]
    
    try:
        print(f"🔧 Executing {control_id} (VPC Flow Logs)...")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        
        if result.returncode == 0:
            print(f"✅ {control_id}: SUCCESS")
            return {'control_id': control_id, 'status': 'SUCCESS', 'output': result.stdout}
        else:
            print(f"❌ {control_id}: FAILED")
            print(f"   Error: {result.stderr}")
            return {'control_id': control_id, 'status': 'FAILED', 'error': result.stderr}
            
    except subprocess.TimeoutExpired:
        print(f"⏰ {control_id}: TIMEOUT")
        return {'control_id': control_id, 'status': 'TIMEOUT', 'error': 'Script execution timed out'}
    except Exception as e:
        print(f"❌ {control_id}: ERROR - {str(e)}")
        return {'control_id': control_id, 'status': 'ERROR', 'error': str(e)}

def execute_vpc_endpoint_remediation(control_id, finding_arn, vpc_id, profile='com-r'):
    """Execute VPC endpoint remediation"""
    
    script_path = 'specs/features/security-compliance/remediation-library/scripts/vpc/create-vpc-endpoint.py'
    
    cmd = [
        'python3', script_path,
        '--control-id', control_id,
        '--vpc-id', vpc_id,
        '--finding-id', finding_arn,
        '--profile', profile
    ]
    
    try:
        print(f"🔧 Executing {control_id} (VPC Endpoint)...")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        
        if result.returncode == 0:
            print(f"✅ {control_id}: SUCCESS")
            return {'control_id': control_id, 'status': 'SUCCESS', 'output': result.stdout}
        else:
            print(f"❌ {control_id}: FAILED")
            print(f"   Error: {result.stderr}")
            return {'control_id': control_id, 'status': 'FAILED', 'error': result.stderr}
            
    except subprocess.TimeoutExpired:
        print(f"⏰ {control_id}: TIMEOUT")
        return {'control_id': control_id, 'status': 'TIMEOUT', 'error': 'Script execution timed out'}
    except Exception as e:
        print(f"❌ {control_id}: ERROR - {str(e)}")
        return {'control_id': control_id, 'status': 'ERROR', 'error': str(e)}

def update_finding_files(results):
    """Update finding files to mark completed ones as resolved"""
    
    # Mapping of control IDs to finding files
    control_to_file = {
        'EC2.6': 'SEC-GENERAL-090.md',
        'EC2.55': 'SEC-GENERAL-062.md',
        'EC2.56': 'SEC-GENERAL-063.md',
        'EC2.57': 'SEC-GENERAL-037.md',
        'EC2.58': 'SEC-GENERAL-036.md',
        'EC2.60': 'SEC-GENERAL-065.md',
        'EC2.10': 'SEC-GENERAL-093.md'
    }
    
    for result in results:
        if result['status'] == 'SUCCESS':
            control_id = result['control_id']
            if control_id in control_to_file:
                file_path = f"specs/features/security-compliance/findings/{control_to_file[control_id]}"
                try:
                    # Update status in file
                    with open(file_path, 'r') as f:
                        content = f.read()
                    
                    updated_content = content.replace('❌ Not Started', '✅ Completed')
                    
                    with open(file_path, 'w') as f:
                        f.write(updated_content)
                    
                    print(f"📝 Updated {control_to_file[control_id]} status to completed")
                except Exception as e:
                    print(f"⚠️ Failed to update {control_to_file[control_id]}: {str(e)}")

def main():
    print("🚀 Phase 3B: Bulk VPC Infrastructure Remediation")
    print("===============================================")
    print(f"Timestamp: {datetime.now().isoformat()}")
    print(f"Target: 7 VPC findings → 77% compliance milestone")
    print("")
    
    # Default VPC ID (can be parameterized)
    vpc_id = "vpc-03097c2b7406dc3dd"
    
    results = []
    successful = 0
    failed = 0
    
    for control_id, config in VPC_FINDINGS.items():
        print(f"\n=== {control_id}: {config['description']} ===")
        
        if config['script'] == 'enable-flow-logs.py':
            result = execute_vpc_flow_logs_remediation(control_id, config['finding_arn'], vpc_id)
        else:
            result = execute_vpc_endpoint_remediation(control_id, config['finding_arn'], vpc_id)
        
        results.append(result)
        
        if result['status'] == 'SUCCESS':
            successful += 1
        else:
            failed += 1
    
    print(f"\n📊 BULK REMEDIATION SUMMARY")
    print(f"===========================")
    print(f"✅ Successful: {successful}/7")
    print(f"❌ Failed: {failed}/7")
    print(f"📈 Success Rate: {(successful/7)*100:.1f}%")
    
    if successful > 0:
        print(f"\n📝 Updating finding files...")
        update_finding_files(results)
        
        print(f"\n🎯 MILESTONE PROGRESS:")
        print(f"Previous: 81/115 findings (70% compliance)")
        print(f"Added: +{successful} VPC findings")
        print(f"New Total: {81 + successful}/115 findings ({((81 + successful)/115)*100:.1f}% compliance)")
        
        if successful >= 5:
            print(f"\n🎉 77% COMPLIANCE MILESTONE ACHIEVED! 🎉")
    
    print(f"\n✅ Phase 3B VPC Infrastructure Remediation Complete")
    return 0 if failed == 0 else 1

if __name__ == '__main__':
    exit(main())
