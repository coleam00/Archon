/**
 * Setup Authentication Script
 *
 * Creates ~/.codex/auth.json from environment variables
 * Used for Docker container startup to configure Codex authentication
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface AuthJson {
  OPENAI_API_KEY: null;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh: string;
}

function setupAuth(): void {
  // Get environment variables
  const idToken = process.env.CODEX_ID_TOKEN;
  const accessToken = process.env.CODEX_ACCESS_TOKEN;
  const refreshToken = process.env.CODEX_REFRESH_TOKEN;
  const accountId = process.env.CODEX_ACCOUNT_ID;

  // Skip if Codex credentials not provided
  if (!idToken || !accessToken || !refreshToken || !accountId) {
    console.log('⏭️  Skipping Codex auth setup - credentials not provided');
    console.log('   Codex assistant will be unavailable');
    return;
  }

  console.log('🔐 Setting up Codex authentication...');

  // Create auth.json structure
  const authData: AuthJson = {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };

  // Determine Codex home directory
  const codexHome = path.join(os.homedir(), '.codex');
  const authPath = path.join(codexHome, 'auth.json');

  // Create directory if it doesn't exist
  if (!fs.existsSync(codexHome)) {
    fs.mkdirSync(codexHome, { recursive: true });
    console.log(`✅ Created directory: ${codexHome}`);
  }

  // Write auth.json file
  try {
    fs.writeFileSync(authPath, JSON.stringify(authData, null, 2));
    console.log(`✅ Successfully created auth.json at: ${authPath}`);
  } catch (error: unknown) {
    console.error(`❌ Failed to write auth.json: ${String(error)}`);
    process.exit(1);
  }

  // Create config.toml with YOLO mode (approval_policy="never", sandbox_mode="danger-full-access")
  const configPath = path.join(codexHome, 'config.toml');
  const configContent = `# Codex Configuration - YOLO Mode (Full Automation)
# approval_policy = "never" - No approval prompts
# sandbox_mode = "danger-full-access" - Full system access

approval_policy = "never"
sandbox_mode = "danger-full-access"

[sandbox_workspace_write]
network_access = true
`;

  try {
    fs.writeFileSync(configPath, configContent);
    console.log(`✅ Successfully created config.toml at: ${configPath}`);
    console.log(
      '✅ Codex YOLO mode enabled (approval_policy="never", sandbox_mode="danger-full-access")'
    );
  } catch (error: unknown) {
    console.error(`❌ Failed to write config.toml: ${String(error)}`);
    process.exit(1);
  }

  console.log('✅ Codex authentication and configuration complete');
}

// Run the setup
setupAuth();
