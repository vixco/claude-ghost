# claude-ghost installer.
#
# One-line install (downloads, installs deps, wires up PowerShell):
#   iwr -useb https://raw.githubusercontent.com/PrincNL/claude-ghost/main/install.ps1 | iex
#
# Or if you've already cloned the repo, just run this script directly.

$ErrorActionPreference = 'Stop'

$REPO_ZIP = 'https://github.com/PrincNL/claude-ghost/archive/refs/heads/main.zip'

function Require-Command($name, $hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Write-Host "[claude-ghost] missing dependency: $name" -ForegroundColor Red
        Write-Host "               $hint" -ForegroundColor Yellow
        throw "missing $name"
    }
}

Require-Command node "Install Node.js 18+ from https://nodejs.org/"
Require-Command npm  "npm comes with Node.js"
Require-Command claude "Install Claude Code from https://claude.com/claude-code"

# ---------------------------------------------------------------------------
# Resolve install root. If this script lives next to bin/claude-ghost.js,
# use that directory (developer flow). Otherwise download the zip and use
# ~/.claude-ghost (one-liner flow via iwr | iex).
# ---------------------------------------------------------------------------
$localScriptDir = $null
if ($MyInvocation.MyCommand.Path) {
    $localScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

if ($localScriptDir -and (Test-Path (Join-Path $localScriptDir 'bin\claude-ghost.js'))) {
    $installRoot = $localScriptDir
    Write-Host "[claude-ghost] using local source: $installRoot" -ForegroundColor Cyan
}
else {
    $installRoot = Join-Path $env:USERPROFILE '.claude-ghost'
    $zipPath     = Join-Path $env:TEMP "claude-ghost-$([guid]::NewGuid()).zip"
    $extractTmp  = Join-Path $env:TEMP "claude-ghost-$([guid]::NewGuid())"

    Write-Host "[claude-ghost] downloading source..." -ForegroundColor Cyan
    Invoke-WebRequest -UseBasicParsing -Uri $REPO_ZIP -OutFile $zipPath

    New-Item -ItemType Directory -Force -Path $extractTmp | Out-Null
    Expand-Archive -Path $zipPath -DestinationPath $extractTmp -Force

    $extractedRoot = Get-ChildItem $extractTmp -Directory | Select-Object -First 1
    if (-not $extractedRoot) { throw "extraction failed: no folder inside $extractTmp" }

    if (Test-Path $installRoot) {
        Write-Host "[claude-ghost] refreshing existing install at $installRoot" -ForegroundColor Cyan
        Remove-Item -Recurse -Force $installRoot
    }
    Move-Item $extractedRoot.FullName $installRoot

    Remove-Item -Recurse -Force $extractTmp
    Remove-Item $zipPath
    Write-Host "[claude-ghost] installed source to: $installRoot" -ForegroundColor Green
}

Set-Location $installRoot

# ---------------------------------------------------------------------------
# Install node dependencies
# ---------------------------------------------------------------------------
Write-Host "[claude-ghost] installing node dependencies..." -ForegroundColor Cyan
npm install --silent --no-audit --no-fund

$entry = Join-Path $installRoot 'bin\claude-ghost.js'
if (-not (Test-Path $entry)) { throw "entry script missing: $entry" }

# ---------------------------------------------------------------------------
# Cmd shim on PATH (for non-PowerShell shells)
# ---------------------------------------------------------------------------
$npmPrefix = (npm config get prefix).Trim()
$shimPath  = Join-Path $npmPrefix 'claude-ghost.cmd'
$shim = @"
@echo off
node "$entry" %*
"@
Set-Content -Path $shimPath -Value $shim -Encoding ASCII
Write-Host "[claude-ghost] cmd shim:  $shimPath" -ForegroundColor Green

# ---------------------------------------------------------------------------
# PowerShell function in $PROFILE — keeps stdin as a real TTY for node,
# which is required for raw-mode keystroke interception (Shift+Tab).
# ---------------------------------------------------------------------------
if (-not (Test-Path $PROFILE)) {
    New-Item -ItemType File -Path $PROFILE -Force | Out-Null
}

$marker     = '# >>> claude-ghost >>>'
$endMarker  = '# <<< claude-ghost <<<'
$profileContent = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
if ($null -eq $profileContent) { $profileContent = '' }

$pattern = "(?s)$([regex]::Escape($marker)).*?$([regex]::Escape($endMarker))\r?\n?"
$profileContent = [regex]::Replace($profileContent, $pattern, '')

$block = @"
$marker
function claude-ghost {
    & node "$entry" @args
}
$endMarker
"@

Set-Content -Path $PROFILE -Value ($profileContent.TrimEnd() + "`r`n`r`n" + $block + "`r`n") -Encoding UTF8
Write-Host "[claude-ghost] PowerShell function added to: $PROFILE" -ForegroundColor Green

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "claude-ghost installed." -ForegroundColor Green
Write-Host "Restart PowerShell (or run: . `$PROFILE) then type: claude-ghost" -ForegroundColor Cyan
Write-Host "Tip: use Windows Terminal — the legacy Windows PowerShell console has poor Shift+Tab support." -ForegroundColor Yellow
