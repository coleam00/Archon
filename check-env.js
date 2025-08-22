#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Secure path resolution
const projectRoot = process.cwd();
const envPath = path.resolve(projectRoot, '.env');

// Security: Validate path is within project
if (!envPath.startsWith(projectRoot)) {
  console.error('Security error: Invalid .env path');
  process.exit(1);
}

// Check if .env exists
if (!fs.existsSync(envPath)) {
  console.error('ERROR: .env file not found!');
  console.error('Copy .env.example to .env and add your credentials:');
  console.error('  cp .env.example .env');
  process.exit(1);
}

// Parse .env file
const envContent = fs.readFileSync(envPath, 'utf8');
const envVars = {};

envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  
  const [key, ...valueParts] = trimmed.split('=');
  if (key) {
    const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
    envVars[key.trim()] = value;
  }
});

// Only check ESSENTIAL variables
const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const errors = [];

required.forEach(varName => {
  if (!envVars[varName] || envVars[varName] === '') {
    errors.push(`Missing: ${varName}`);
  }
});

if (errors.length > 0) {
  console.error('ERROR: Required environment variables missing:');
  errors.forEach(err => console.error(`  - ${err}`));
  console.error('\nPlease add these to your .env file');
  process.exit(1);
}

// Validate URL format
try {
  new URL(envVars['SUPABASE_URL']);
} catch (e) {
  console.error('ERROR: SUPABASE_URL is not a valid URL');
  console.error(`  Found: ${envVars['SUPABASE_URL']}`);
  console.error('  Expected format: https://your-project.supabase.co');
  process.exit(1);
}

// Basic validation for service key
if (envVars['SUPABASE_SERVICE_KEY'].length < 10) {
  console.error('ERROR: SUPABASE_SERVICE_KEY appears to be invalid (too short)');
  console.error('  Please check your Supabase project settings');
  process.exit(1);
}

console.log('✓ Environment configured correctly');