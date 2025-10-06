<#
set_supabase_secrets.ps1

Purpose:
- Inspect running Docker containers and local .env files to find SUPABASE_URL and SUPABASE_SERVICE_KEY.
- Generate a secure POSTGRES_PASSWORD.
- Prompt the user to confirm and then set GitHub Actions secrets in the repo `jluna0413/Archon` using `gh secret set`.

Security notes:
- Run this script locally only. Do not copy secrets into chat or commit them to the repo.
- Ensure you are authenticated with `gh auth login` and that the account has access to the target repo.
#>

param(
    [string]$Repo = 'jluna0413/Archon',
    [switch]$Force
)

function Write-Note($msg){ Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Warn($msg){ Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg){ Write-Host "[ERROR] $msg" -ForegroundColor Red }

Write-Note "This helper will attempt to locate SUPABASE env vars and set GitHub Actions secrets for $Repo"

# Check prerequisites
foreach ($cmd in @('docker','gh')){
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)){
        Write-Err "Required command '$cmd' not found in PATH. Install it before running this script."
        exit 2
    }
}

# Check gh auth
$auth = gh auth status 2>&1
if ($LASTEXITCODE -ne 0){
    Write-Warn "gh auth appears not authenticated or failed. Run 'gh auth login' first and try again."
    Write-Host $auth
    exit 3
}

Write-Note "Searching running Docker containers for SUPABASE env vars..."

$candidates = docker ps --format "{{.Names}}\t{{.Image}}" | ForEach-Object {
    $parts = $_ -split "\t"
    @{ Name = $parts[0]; Image = $parts[1] }
}

$found = @{}

foreach ($c in $candidates){
    $name = $c.Name
    try{
        $envJson = docker inspect --format '{{json .Config.Env}}' $name 2>$null
        if (-not $envJson){ continue }
        $envArr = $envJson | ConvertFrom-Json
        foreach ($e in $envArr){
            if ($e -match '^SUPABASE_URL='){
                $found.SUPABASE_URL = ($e -replace '^SUPABASE_URL=','')
                $found.Container = $name
            }
            if ($e -match '^SUPABASE_SERVICE_KEY='){
                $found.SUPABASE_SERVICE_KEY = ($e -replace '^SUPABASE_SERVICE_KEY=','')
                $found.Container = $name
            }
        }
    } catch {
        # ignore inspection errors
    }
    if ($found.SUPABASE_SERVICE_KEY -and $found.SUPABASE_URL){ break }
}

if (-not $found.SUPABASE_SERVICE_KEY){
    Write-Warn "No SUPABASE_SERVICE_KEY found in running containers. Searching common .env files in repo..."
    $envFiles = Get-ChildItem -Path (Resolve-Path .) -Filter '*.env*' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 10
    foreach ($f in $envFiles){
        try{
            $lines = Get-Content $f.FullName -ErrorAction SilentlyContinue
            foreach ($l in $lines){
                if ($l -match '^SUPABASE_SERVICE_KEY=(.+)$'){
                    $found.SUPABASE_SERVICE_KEY = $matches[1].Trim()
                    $found.EnvFile = $f.FullName
                }
                if ($l -match '^SUPABASE_URL=(.+)$'){
                    $found.SUPABASE_URL = $matches[1].Trim()
                    $found.EnvFile = $f.FullName
                }
            }
            if ($found.SUPABASE_SERVICE_KEY -and $found.SUPABASE_URL){ break }
        } catch { }
    }
}

if ($found.SUPABASE_SERVICE_KEY){
    Write-Note "Found SUPABASE_SERVICE_KEY in: $($found.Container -or $found.EnvFile)"
    $maskedKey = $found.SUPABASE_SERVICE_KEY.Substring(0,8) + '...' + $found.SUPABASE_SERVICE_KEY.Substring($found.SUPABASE_SERVICE_KEY.Length-6)
    Write-Note "Service key (masked): $maskedKey"
} else {
    Write-Warn "No SUPABASE_SERVICE_KEY discovered automatically. You can copy it from the Supabase dashboard or provide it when prompted."
}

if ($found.SUPABASE_URL){ Write-Note "Found SUPABASE_URL: $($found.SUPABASE_URL)" } else { Write-Warn "No SUPABASE_URL found automatically." }

# Generate a secure POSTGRES_PASSWORD
[byte[]]$b = 0..31 | ForEach-Object {0}
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$pgpw = [Convert]::ToBase64String($b)
Write-Note "Generated a random POSTGRES_PASSWORD (will be stored as secret)."

Write-Host "`nSummary of values found:" -ForegroundColor Green
if ($found.SUPABASE_URL){ Write-Host "  SUPABASE_URL: $($found.SUPABASE_URL)" }
if ($found.SUPABASE_SERVICE_KEY){ Write-Host "  SUPABASE_SERVICE_KEY: (found and masked) $maskedKey" }
Write-Host "  POSTGRES_PASSWORD: (generated and will be set) [masked: $($pgpw.Substring(0,6))...]"

if (-not $Force){
    $confirm = Read-Host "Proceed to set these values as GitHub Actions secrets in repo $Repo? (y/N)"
    if ($confirm.ToLower() -ne 'y'){ Write-Note "Aborting as requested."; exit 0 }
}

# Prompt for SERVICE_KEY if not found
if (-not $found.SUPABASE_SERVICE_KEY){
    $manualKey = Read-Host -AsSecureString "SUPABASE_SERVICE_KEY not found; paste it now (will be hidden)"
    $found.SUPABASE_SERVICE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($manualKey))
}

# Prompt for URL if not found
if (-not $found.SUPABASE_URL){
    $found.SUPABASE_URL = Read-Host "SUPABASE_URL not found; enter it now (e.g. https://your-project.supabase.co)"
}

Write-Note "Setting repository secrets using gh for $Repo. This requires that your gh account has push/admin access to the repo."

try{
    gh secret set POSTGRES_PASSWORD --repo $Repo --body "$pgpw"
    Write-Note "Set POSTGRES_PASSWORD"
} catch { Write-Err "Failed to set POSTGRES_PASSWORD: $_" }

try{
    gh secret set SUPABASE_SERVICE_KEY --repo $Repo --body "$($found.SUPABASE_SERVICE_KEY)"
    Write-Note "Set SUPABASE_SERVICE_KEY"
} catch { Write-Err "Failed to set SUPABASE_SERVICE_KEY: $_" }

try{
    gh secret set SUPABASE_URL --repo $Repo --body "$($found.SUPABASE_URL)"
    Write-Note "Set SUPABASE_URL"
} catch { Write-Err "Failed to set SUPABASE_URL: $_" }

Write-Note "Listing repository secrets (names only)"
gh secret list --repo $Repo

Write-Note "Done. The workflow should now have required secrets in $Repo. Trigger the CI run by opening the PR or pushing another commit."
