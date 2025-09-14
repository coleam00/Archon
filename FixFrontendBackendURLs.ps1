# Fix Frontend Backend URLs
$serverUrl = az containerapp show --name "archon-server" --resource-group "rg-archon" --query "properties.configuration.ingress.fqdn" --output tsv
$mcpUrl = az containerapp show --name "archon-mcp" --resource-group "rg-archon" --query "properties.configuration.ingress.fqdn" --output tsv
$agentsUrl = az containerapp show --name "archon-agents" --resource-group "rg-archon" --query "properties.configuration.ingress.fqdn" --output tsv

Write-Host "Updating frontend with backend URLs..."
Write-Host "Server: https://$serverUrl"
Write-Host "MCP: https://$mcpUrl"  
Write-Host "Agents: https://$agentsUrl"

az containerapp update `
    --name "archon-ui" `
    --resource-group "rg-archon" `
    --set-env-vars `
        "VITE_API_URL=https://$serverUrl" `
        "VITE_MCP_URL=https://$mcpUrl" `
        "VITE_AGENTS_URL=https://$agentsUrl"

Write-Host "Frontend updated. Wait 2-3 minutes and refresh the page."