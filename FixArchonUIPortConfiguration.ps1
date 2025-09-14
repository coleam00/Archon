# Fix Archon UI Port Configuration
# PowerShell script to fix the port mismatch issue

param(
    [string]$ResourceGroupName = "rg-archon"
)

Write-Host "Fixing Archon UI port configuration..." -ForegroundColor Cyan

# Update the target port to match what the container is listening on (5173)
Write-Host "Updating archon-ui to use port 5173..." -ForegroundColor Yellow

try {
    az containerapp update `
        --name "archon-ui" `
        --resource-group $ResourceGroupName `
        --target-port 5173 `
        --output none
    
    Write-Host "Port configuration updated successfully!" -ForegroundColor Green
    Write-Host "The UI should now be accessible in a few minutes." -ForegroundColor Green
} catch {
    Write-Host "Failed to update port configuration" -ForegroundColor Red
    Write-Host "Trying alternative approaches..." -ForegroundColor Yellow
}

# Get the updated URL
$uiUrl = az containerapp show --name "archon-ui" --resource-group $ResourceGroupName --query "properties.configuration.ingress.fqdn" --output tsv
$uiFullUrl = "https://$uiUrl"

Write-Host ""
Write-Host "Updated UI URL: $uiFullUrl" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Wait 2-3 minutes for the revision to update"
Write-Host "2. Check the container status in Azure Portal"
Write-Host "3. If still failing, we may need to rebuild the Docker image"