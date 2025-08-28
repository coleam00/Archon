// test-docker-patch.js - Patches for tests running in Docker environment
// This script modifies test behavior when running in a containerized environment

// Check if we're running in Docker
const isDocker = process.env.NODE_ENV === 'test' && 
                 process.env.ARCHON_SERVER_PORT && 
                 process.env.ARCHON_MCP_PORT;

if (isDocker) {
  console.log('🐳 Running tests in Docker environment');
  console.log('📝 Note: 3 environment-specific tests will be skipped');
  
  // Set a flag that tests can check
  process.env.RUNNING_IN_DOCKER = 'true';
}

export { isDocker };