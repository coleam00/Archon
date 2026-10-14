# scripts/install.ps1
# Install Archon CLI from GitHub Releases on Windows
#
# Usage: irm https://archon.diy/install.ps1 | iex
#
# Options:
#   -Providers <ids> - Comma-separated providers to add (claude, codex, pi).
#                      An empty value installs none. Without it, the installer asks.
#                      Releases up to 0.11.1 bundle their providers and have no
#                      `archon provider`; pin one with -Providers ''.
#
# Options (via environment variables):
#   $env:VERSION          - Specific version to install (default: latest)
#   $env:INSTALL_DIR      - Installation directory (default: $env:USERPROFILE\.archon\bin)
#   $env:SKIP_CHECKSUM    - Set to "true" to skip checksum verification (not recommended)
#   $env:ARCHON_PROVIDERS - Same as -Providers; the parameter wins
#
# Examples:
#   # Install latest
#   irm https://archon.diy/install.ps1 | iex
#
#   # Install specific version
#   $env:VERSION = "v0.2.0"; irm https://archon.diy/install.ps1 | iex
#
#   # Install to custom directory
#   $env:INSTALL_DIR = "C:\tools\archon"; irm https://archon.diy/install.ps1 | iex
#
#   # Install with the Codex provider, without asking
#   & ([scriptblock]::Create((irm https://archon.diy/install.ps1))) -Providers codex

#Requires -Version 5.1
param([string]$Providers)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
$REPO         = "coleam00/Archon"
$BINARY_NAME  = "archon"
$VERSION      = if ($env:VERSION)     { $env:VERSION }     else { "latest" }
$INSTALL_DIR  = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { "$env:USERPROFILE\.archon\bin" }
$SKIP_CHECKSUM = ($env:SKIP_CHECKSUM -eq "true")
# Must match MAINTAINED_PROVIDER_IDS in packages/provider-contract/src/registration.ts;
# scripts/test-install.sh enforces it.
$PROVIDER_IDS = @('claude', 'codex', 'pi')
# An explicit empty -Providers or ARCHON_PROVIDERS installs none; only an absent one asks.
# Under `irm | iex` the script runs in the caller's scope, where PSBoundParameters is unset.
$boundParameters = Get-Variable -Name PSBoundParameters -ValueOnly -ErrorAction SilentlyContinue
$PROVIDER_SELECTION = if ($null -ne $boundParameters -and $boundParameters.ContainsKey('Providers')) { $boundParameters['Providers'] }
                      elseif (Test-Path Env:ARCHON_PROVIDERS) { $env:ARCHON_PROVIDERS }
                      else { $null }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Info    { param([string]$Msg) Write-Host "[INFO]  $Msg" -ForegroundColor Cyan }
function Write-Warn    { param([string]$Msg) Write-Host "[WARN]  $Msg" -ForegroundColor Yellow }
function Write-Err     { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red }
function Write-Ok      { param([string]$Msg) Write-Host "[OK]    $Msg" -ForegroundColor Green }

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
function Show-Banner {
    Write-Host ""
    Write-Host "  +---------------------------------------+" -ForegroundColor Cyan
    Write-Host "  |      Archon CLI Installer             |" -ForegroundColor Cyan
    Write-Host "  |      Windows (PowerShell)             |" -ForegroundColor Cyan
    Write-Host "  +---------------------------------------+" -ForegroundColor Cyan
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Architecture detection
# ---------------------------------------------------------------------------
function Get-Arch {
    $procArch = $env:PROCESSOR_ARCHITECTURE
    if (-not $procArch) {
        # Fallback: query the registry directly
        try {
            $procArch = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE
        } catch {
            Write-Warn "Could not read processor architecture from registry: $($_.Exception.Message)"
            Write-Warn "Assuming x64 architecture. Set PROCESSOR_ARCHITECTURE env var to override."
            $procArch = "AMD64"
        }
    }

    switch ($procArch.ToUpper()) {
        "ARM64"  {
            Write-Warn "ARM64 architecture detected."
            Write-Warn "Windows ARM64 binaries are not yet available for Archon."
            Write-Warn "You can try running the x64 binary under emulation, or build from source:"
            Write-Warn "  https://github.com/$REPO"
            throw "Unsupported architecture: ARM64 (no binary available yet)"
        }
        default { return "x64" }
    }
}

# ---------------------------------------------------------------------------
# URL helpers
# ---------------------------------------------------------------------------
function Get-DownloadUrl {
    param([string]$Arch, [string]$Ver)
    $filename = "$BINARY_NAME-windows-$Arch.exe"
    if ($Ver -eq "latest") {
        return "https://github.com/$REPO/releases/latest/download/$filename"
    } else {
        return "https://github.com/$REPO/releases/download/$Ver/$filename"
    }
}

function Get-ChecksumsUrl {
    param([string]$Ver)
    if ($Ver -eq "latest") {
        return "https://github.com/$REPO/releases/latest/download/checksums.txt"
    } else {
        return "https://github.com/$REPO/releases/download/$Ver/checksums.txt"
    }
}

# ---------------------------------------------------------------------------
# Download helper (supports progress + resume)
# ---------------------------------------------------------------------------
function Invoke-Download {
    param([string]$Url, [string]$OutFile)

    # Suppress the progress bar to avoid slow rendering in older PowerShell
    $prevProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    } finally {
        $ProgressPreference = $prevProgress
    }
}

# ---------------------------------------------------------------------------
# Checksum verification
# ---------------------------------------------------------------------------
function Confirm-Checksum {
    param([string]$BinaryPath, [string]$Arch, [string]$ChecksumsUrl)

    if ($SKIP_CHECKSUM) {
        Write-Warn "Checksum verification SKIPPED by user request (SKIP_CHECKSUM=true)"
        Write-Warn "This binary has NOT been verified - use at your own risk"
        return
    }

    Write-Info "Verifying checksum..."

    # Download checksums file
    $tmpChecksums = [System.IO.Path]::GetTempFileName()
    try {
        try {
            Invoke-Download -Url $ChecksumsUrl -OutFile $tmpChecksums
        } catch {
            Write-Err "Could not download checksums file from $ChecksumsUrl"
            Write-Err "Cannot verify binary integrity."
            Write-Err "To install anyway (not recommended): `$env:SKIP_CHECKSUM = 'true'; irm ... | iex"
            throw "Checksum download failed"
        }

        $checksumContent = Get-Content -Raw $tmpChecksums

        # Find the line matching our binary filename
        $expectedFilename = "$BINARY_NAME-windows-$Arch.exe"
        $expectedHash = $null
        foreach ($line in ($checksumContent -split "`n")) {
            $line = $line.Trim()
            if ($line -match $expectedFilename) {
                # checksums.txt is typically "<hash>  <filename>" (sha256sum format)
                $expectedHash = ($line -split '\s+')[0]
                break
            }
        }

        if (-not $expectedHash) {
            Write-Err "Could not find checksum for $expectedFilename in checksums file"
            Write-Err "This may indicate a corrupted or incomplete release."
            Write-Err "To install anyway (not recommended): `$env:SKIP_CHECKSUM = 'true'; irm ... | iex"
            throw "Checksum entry not found"
        }

        # Compute actual hash
        $actualHash = (Get-FileHash -Path $BinaryPath -Algorithm SHA256).Hash.ToLower()
        $expectedHash = $expectedHash.ToLower()

        if ($actualHash -ne $expectedHash) {
            Write-Err "Checksum verification FAILED!"
            Write-Err "Expected : $expectedHash"
            Write-Err "Actual   : $actualHash"
            Write-Err "The downloaded binary may be corrupted or tampered with."
            throw "Checksum mismatch"
        }

        Write-Ok "Checksum verified"
    } finally {
        if (Test-Path $tmpChecksums) { Remove-Item $tmpChecksums -Force -ErrorAction SilentlyContinue }
    }
}

# ---------------------------------------------------------------------------
# PATH management
# ---------------------------------------------------------------------------
function Add-ToUserPath {
    param([string]$Dir)
    $currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $pathParts   = @($currentPath -split ';' | Where-Object { $_ -ne '' })

    if ($Dir -notin $pathParts) {
        $pathParts += $Dir
        [Environment]::SetEnvironmentVariable('Path', ($pathParts -join ';'), 'User')
        Write-Ok "Added $Dir to your user PATH"
        Write-Info "Restart your terminal (or open a new one) for the PATH change to take effect"
    } else {
        Write-Info "$Dir is already in your PATH"
    }
}

# ---------------------------------------------------------------------------
# Provider selection
# ---------------------------------------------------------------------------
# Turns a comma- or space-separated selection into provider ids, rejecting anything
# that is not a maintained provider.
function ConvertTo-ProviderIds {
    param([string]$Selection)
    $ids = @($Selection -split '[,\s]+' | Where-Object { $_ -ne '' })
    foreach ($id in $ids) {
        if ($id -notin $PROVIDER_IDS) {
            throw "Unknown provider '$id'. Choose from: $($PROVIDER_IDS -join ', ')"
        }
    }
    return ,$ids
}

# Returns $null when there is no console to ask, so the caller installs none.
function Read-ProviderSelection {
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { return $null }
    while ($true) {
        # Read-Host throws in a -NonInteractive session, which UserInteractive does not reveal.
        try {
            $answer = Read-Host "Which providers should Archon add? ($($PROVIDER_IDS -join ', '), comma-separated; empty for none)"
        } catch {
            return $null
        }
        try {
            return ,(ConvertTo-ProviderIds -Selection $answer)
        } catch {
            Write-Err $_.Exception.Message
        }
    }
}

function Install-Providers {
    param([string]$Archon, [string[]]$Ids)
    Write-Info "Adding a provider connects Archon to your agent CLI or SDK; it does not install that CLI."
    if ($Ids.Count -eq 0) {
        Write-Warn "No providers installed. AI workflows and chat need one; add it with:"
        Write-Host "  archon provider add <$($PROVIDER_IDS -join '|')>"
        Write-Host "  (or run: archon setup)"
        return
    }
    Write-Info "Adding providers: $($Ids -join ' ')"
    & $Archon provider add @Ids
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Archon is installed, but adding providers failed."
        Write-Err "Retry with: archon provider add $($Ids -join ' ')"
        exit 1
    }
    Write-Ok "Providers installed: $($Ids -join ' ')"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
function Main {
    Show-Banner

    # --- Provider selection (validated before anything is downloaded) ---
    $providerIds = $null
    if ($null -ne $PROVIDER_SELECTION) {
        try {
            $providerIds = ConvertTo-ProviderIds -Selection $PROVIDER_SELECTION
        } catch {
            Write-Err $_.Exception.Message
            exit 1
        }
    }

    # --- Architecture ---
    Write-Info "Detecting architecture..."
    try {
        $arch = Get-Arch
    } catch {
        Write-Err $_.Exception.Message
        exit 1
    }
    Write-Ok "Architecture: $arch"

    # --- URLs ---
    $downloadUrl  = Get-DownloadUrl -Arch $arch -Ver $VERSION
    $checksumsUrl = Get-ChecksumsUrl -Ver $VERSION

    Write-Info "Version     : $VERSION"
    Write-Info "Download URL: $downloadUrl"

    # --- Temp file ---
    $tmpDir    = [System.IO.Path]::GetTempPath()
    $tmpBinary = Join-Path $tmpDir "$BINARY_NAME-windows-$arch.exe"

    try {
        # --- Download binary ---
        Write-Info "Downloading binary..."
        try {
            Invoke-Download -Url $downloadUrl -OutFile $tmpBinary
        } catch {
            Write-Err "Failed to download binary from $downloadUrl"
            Write-Err $_.Exception.Message
            exit 1
        }
        Write-Ok "Downloaded successfully"

        # --- Checksum ---
        try {
            Confirm-Checksum -BinaryPath $tmpBinary -Arch $arch -ChecksumsUrl $checksumsUrl
        } catch {
            Write-Err $_.Exception.Message
            exit 1
        }

        # --- Create install directory ---
        if (-not (Test-Path $INSTALL_DIR)) {
            Write-Info "Creating install directory: $INSTALL_DIR"
            try {
                New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
            } catch {
                Write-Err "Failed to create install directory: $INSTALL_DIR"
                Write-Err $_.Exception.Message
                exit 1
            }
        }

        # --- Copy binary ---
        $destBinary = Join-Path $INSTALL_DIR "$BINARY_NAME.exe"
        Write-Info "Installing to $destBinary..."
        try {
            Copy-Item -Path $tmpBinary -Destination $destBinary -Force
        } catch {
            Write-Err "Failed to install binary to $destBinary"
            Write-Err $_.Exception.Message
            exit 1
        }
        Write-Ok "Installed to $destBinary"

        # --- Add to PATH ---
        try {
            Add-ToUserPath -Dir $INSTALL_DIR
        } catch {
            Write-Warn "Could not update PATH automatically: $($_.Exception.Message)"
            Write-Warn "Add the following to your PATH manually: $INSTALL_DIR"
        }

        # --- Verify installation ---
        Write-Host ""
        Write-Info "Verifying installation..."
        try {
            $versionOutput = & $destBinary version 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Err "Installed binary failed its version check (exit $LASTEXITCODE):"
                Write-Host $versionOutput
                exit 1
            }
            Write-Host $versionOutput
            Write-Ok "Installation complete!"
        } catch {
            Write-Warn "Binary installed but version check failed: $($_.Exception.Message)"
            Write-Warn "The binary may not work correctly in this environment."
            Write-Warn "Verify manually with: $destBinary version"
        }

        # --- Providers ---
        if ($null -eq $providerIds) {
            $providerIds = Read-ProviderSelection
            if ($null -eq $providerIds) {
                Write-Info "No console to ask which providers to add; adding none."
                $providerIds = @()
            }
        }
        Install-Providers -Archon $destBinary -Ids $providerIds

        # --- Getting started ---
        Write-Host ""
        Write-Host "  Get started:" -ForegroundColor Cyan
        Write-Host "    archon workflow list"
        Write-Host "    archon workflow run archon-investigate `"Why does the test suite fail?`""
        Write-Host ""
        Write-Host "  Note: Open a new terminal window so the updated PATH takes effect." -ForegroundColor Yellow
        Write-Host ""

    } finally {
        if (Test-Path $tmpBinary) { Remove-Item $tmpBinary -Force -ErrorAction SilentlyContinue }
    }
}

Main
