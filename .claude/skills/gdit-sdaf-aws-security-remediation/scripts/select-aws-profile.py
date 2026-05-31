#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
AWS Profile Selection for Security Compliance Operations
Manages session-based AWS profile configuration
"""

import boto3
import json
import os
from pathlib import Path
from datetime import datetime
from configparser import ConfigParser

SESSION_FILE = Path.home() / '.netra-security-session.json'

def get_available_profiles():
    """Get list of available AWS CLI profiles"""
    profiles = []
    
    # Check ~/.aws/config
    config_file = Path.home() / '.aws' / 'config'
    if config_file.exists():
        config = ConfigParser()
        config.read(config_file)
        for section in config.sections():
            if section.startswith('profile '):
                profiles.append(section.replace('profile ', ''))
    
    # Check ~/.aws/credentials
    creds_file = Path.home() / '.aws' / 'credentials'
    if creds_file.exists():
        config = ConfigParser()
        config.read(creds_file)
        for section in config.sections():
            if section not in profiles:
                profiles.append(section)
    
    return sorted(profiles)

def validate_profile(profile_name):
    """Validate profile and get account/region info"""
    try:
        session = boto3.Session(profile_name=profile_name)
        sts = session.client('sts')
        
        identity = sts.get_caller_identity()
        account_id = identity['Account']
        
        region = session.region_name or 'us-east-1'
        
        return {
            'valid': True,
            'profile_name': profile_name,
            'account_id': account_id,
            'region': region,
            'arn': identity['Arn']
        }
    except Exception as e:
        return {
            'valid': False,
            'profile_name': profile_name,
            'error': str(e)
        }

def save_session(profile_info):
    """Save profile session to file"""
    session_data = {
        'profile_name': profile_info['profile_name'],
        'account_id': profile_info['account_id'],
        'region': profile_info['region'],
        'arn': profile_info['arn'],
        'validated_at': datetime.now().isoformat()
    }
    
    with open(SESSION_FILE, 'w') as f:
        json.dump(session_data, f, indent=2)
    
    return session_data

def load_session():
    """Load current session"""
    if SESSION_FILE.exists():
        with open(SESSION_FILE, 'r') as f:
            return json.load(f)
    return None

def main():
    print("⚙️  AWS Profile Selection for Security Compliance")
    print()
    
    # Show current session if exists
    current = load_session()
    if current:
        print(f"📍 Current Profile: {current['profile_name']}")
        print(f"   Account: {current['account_id']}")
        print(f"   Region: {current['region']}")
        print(f"   Validated: {current['validated_at']}")
        print()
    
    # Get available profiles
    profiles = get_available_profiles()
    
    if not profiles:
        print("❌ No AWS profiles found in ~/.aws/config or ~/.aws/credentials")
        print("   Configure AWS CLI first: aws configure --profile <profile-name>")
        return
    
    print("📋 Available AWS Profiles:")
    for i, profile in enumerate(profiles, 1):
        marker = "✓" if current and current['profile_name'] == profile else " "
        print(f"   {i}. [{marker}] {profile}")
    print()
    
    # Get user selection
    try:
        choice = input("Select profile number (or 'q' to quit): ").strip()
        
        if choice.lower() == 'q':
            print("Cancelled")
            return
        
        idx = int(choice) - 1
        if idx < 0 or idx >= len(profiles):
            print("❌ Invalid selection")
            return
        
        selected_profile = profiles[idx]
        
    except (ValueError, KeyboardInterrupt):
        print("\n❌ Invalid input")
        return
    
    # Validate profile
    print(f"\n🔍 Validating profile: {selected_profile}...")
    validation = validate_profile(selected_profile)
    
    if not validation['valid']:
        print(f"❌ Profile validation failed: {validation['error']}")
        return
    
    # Save session
    session = save_session(validation)
    
    print(f"\n✅ Profile configured successfully!")
    print(f"   Profile: {session['profile_name']}")
    print(f"   Account: {session['account_id']}")
    print(f"   Region: {session['region']}")
    print(f"   ARN: {session['arn']}")
    print()
    print("💡 This profile will be used for all security compliance operations")
    print(f"   Session saved to: {SESSION_FILE}")

if __name__ == '__main__':
    main()
