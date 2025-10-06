[CmdletBinding()]
param(
    [string]$Host = "localhost",
    [string]$Port = "54325",
    [string]$User = "postgres",
    [string]$Password = "postgres",
    [string]$Database = "postgres"
)

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "python not found in PATH. Please install Python or run from the appropriate environment."
    exit 2
}

$env:DB_HOST = $Host
$env:DB_PORT = $Port
$env:DB_USER = $User
$env:DB_PASSWORD = $Password
$env:DB_NAME = $Database

python "$(Join-Path $PSScriptRoot "..\run_migrations.py")" --host $Host --port $Port --user $User --password $Password --database $Database
exit $LASTEXITCODE
