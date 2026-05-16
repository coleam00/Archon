#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
IAM.3/IAM.8/IAM.22 Audit: Access Key Age Report
Identifies access keys requiring rotation or removal
"""

import boto3
import argparse
import json
import os
from datetime import datetime, timedelta
from pathlib import Path

def audit_access_keys(profile_name, region, threshold_days=90, output_format='text'):
    """
    Generate access key age report
    
    SECURITY: Report files are NEVER saved in scripts directory.
    All output goes to project temp/ directory to prevent sensitive data
    from being committed to git or stored in framework directories.
    """
    try:
        session = boto3.Session(profile_name=profile_name)
        iam_client = session.client('iam', region_name=region)
        sts_client = session.client('sts', region_name=region)
        
        # Get account number
        account_id = sts_client.get_caller_identity()['Account']
        
        users_response = iam_client.list_users()
        users = users_response['Users']
        
        threshold_date = datetime.now(datetime.now().astimezone().tzinfo) - timedelta(days=threshold_days)
        
        results = {
            'timestamp': datetime.now().isoformat(),
            'account_id': account_id,
            'region': region,
            'threshold_days': threshold_days,
            'total_users': len(users),
            'total_keys': 0,
            'keys_over_threshold': 0,
            'keys': []
        }
        
        for user in users:
            username = user['UserName']
            
            keys_response = iam_client.list_access_keys(UserName=username)
            
            for key in keys_response['AccessKeyMetadata']:
                key_id = key['AccessKeyId']
                created_date = key['CreateDate']
                status = key['Status']
                age_days = (datetime.now(datetime.now().astimezone().tzinfo) - created_date).days
                
                # Get last used info
                try:
                    last_used_response = iam_client.get_access_key_last_used(AccessKeyId=key_id)
                    last_used = last_used_response.get('AccessKeyLastUsed', {}).get('LastUsedDate')
                    last_used_str = last_used.isoformat() if last_used else 'Never'
                    last_used_days = (datetime.now(datetime.now().astimezone().tzinfo) - last_used).days if last_used else None
                except:
                    last_used_str = 'Unknown'
                    last_used_days = None
                
                # SECURITY: Mask access key ID to prevent Gitleaks violations
                # CRITICAL: Never include AKIA prefix - triggers Gitleaks AWS key detection
                # Show only last 4 characters with generic prefix
                masked_key_id = f"****{key_id[-4:]}" if len(key_id) >= 4 else "****"
                
                key_info = {
                    'username': username,
                    'access_key_id_masked': masked_key_id,
                    'created_date': created_date.isoformat(),
                    'age_days': age_days,
                    'status': status,
                    'last_used': last_used_str,
                    'last_used_days': last_used_days,
                    'over_threshold': age_days > threshold_days,
                    'unused': last_used_days is None or last_used_days > threshold_days
                }
                
                results['keys'].append(key_info)
                results['total_keys'] += 1
                
                if age_days > threshold_days:
                    results['keys_over_threshold'] += 1
        
        results['compliance_rate'] = ((results['total_keys'] - results['keys_over_threshold']) / results['total_keys'] * 100) if results['total_keys'] > 0 else 100
        
        return results
        
    except Exception as e:
        return {
            'status': 'ERROR',
            'message': f'Audit failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='IAM Access Key Age Audit (IAM.3/IAM.8/IAM.22)')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--threshold', type=int, default=90, help='Age threshold in days (default: 90)')
    parser.add_argument('--format', choices=['text', 'json', 'csv'], default='text', help='Output format')
    parser.add_argument('--output', help='Output file (default: access-keys-{account}-{region}-{threshold}day-{date}.{ext})')
    
    args = parser.parse_args()
    
    print(f"🔍 IAM Access Key Age Audit (Threshold: {args.threshold} days)")
    print(f"Profile: {args.profile}, Region: {args.region}")
    print("")
    
    results = audit_access_keys(args.profile, args.region, args.threshold, args.format)
    
    if results.get('status') == 'ERROR':
        print(f"❌ {results['message']}")
        return 1
    
    # Generate default filename if not provided
    if not args.output:
        account_id = results.get('account_id', 'unknown')
        region = results.get('region', 'unknown')
        date_str = datetime.now().strftime('%Y%m%d')
        ext = 'json' if args.format == 'json' else 'csv' if args.format == 'csv' else 'txt'
        filename = f"access-keys-{account_id}-{region}-{args.threshold}day-{date_str}.{ext}"
        
        # CRITICAL: Always save to project temp/ directory (never in scripts directory)
        # Find project root (look for .netra-framework directory)
        script_dir = Path(__file__).resolve().parent
        project_root = script_dir
        while project_root.parent != project_root:
            if (project_root / '.netra-framework').exists():
                break
            project_root = project_root.parent
        
        # Use project temp folder (outside git, outside scripts directory)
        temp_dir = project_root / 'temp'
        temp_dir.mkdir(exist_ok=True)
        args.output = str(temp_dir / filename)
        
        print(f"📁 Output location: {args.output}")
        print(f"   (Saved to project temp/ directory, not scripts directory)")
    
    # Display results
    if args.format == 'json':
        output = json.dumps(results, indent=2)
    elif args.format == 'csv':
        output = "Username,AccessKeyIdMasked,CreatedDate,AgeDays,Status,LastUsed,LastUsedDays,OverThreshold,Unused\n"
        for key in results['keys']:
            output += f"{key['username']},{key['access_key_id_masked']},{key['created_date']},{key['age_days']},{key['status']},{key['last_used']},{key['last_used_days']},{key['over_threshold']},{key['unused']}\n"
    else:  # text
        output = f"📊 Access Key Age Report\n"
        output += f"{'='*80}\n"
        output += f"Threshold: {results['threshold_days']} days\n"
        output += f"Total Keys: {results['total_keys']}\n"
        output += f"✅ Within Threshold: {results['total_keys'] - results['keys_over_threshold']}\n"
        output += f"❌ Over Threshold: {results['keys_over_threshold']}\n"
        output += f"Compliance Rate: {results['compliance_rate']:.1f}%\n\n"
        
        if results['keys_over_threshold'] > 0:
            output += "❌ Keys Requiring Action:\n"
            for key in results['keys']:
                if key['over_threshold']:
                    output += f"  • {key['username']}: {key['access_key_id_masked']}\n"
                    output += f"    Age: {key['age_days']} days, Last Used: {key['last_used']}\n"
        else:
            output += "✅ All access keys within threshold!\n"
    
    if args.output:
        with open(args.output, 'w') as f:
            f.write(output)
        print(f"📄 Report saved to: {args.output}")
    else:
        print(output)
    
    return 0 if results['keys_over_threshold'] == 0 else 1

if __name__ == '__main__':
    exit(main())
