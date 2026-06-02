# AiDex Debug Dashboard - one-command showcase launcher.
#
# Checks that LogHub is reachable, reminds you to open the Debug tab, then runs
# the endless demo loop. Press Ctrl+C to stop (the demo clears the dashboard).
#
#   .\scripts\demo-dashboard.ps1
#   .\scripts\demo-dashboard.ps1 -Port 3336

param([int]$Port = 3335)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host ""
Write-Host "  AiDex Debug Dashboard - Demo" -ForegroundColor Cyan
Write-Host "  ============================" -ForegroundColor DarkCyan
Write-Host ""

# 1. Is LogHub up?
$hubUp = $false
try {
    $h = Invoke-RestMethod -Uri ("http://localhost:$Port/health") -TimeoutSec 2 -ErrorAction Stop
    $hubUp = $true
    Write-Host ("  [ok] LogHub reachable on port $Port") -ForegroundColor Green
} catch {
    Write-Host ("  [!] LogHub not reachable on port $Port") -ForegroundColor Yellow
    Write-Host "      Start it from Claude:  aidex_log({ action: 'init' })" -ForegroundColor Gray
    Write-Host "      (the demo will still run and retry silently once it is up)" -ForegroundColor Gray
}

Write-Host ""
Write-Host "  Open the dashboard:  aidex_viewer({ path: '.' })  ->  Debug tab" -ForegroundColor Gray
Write-Host "  Then watch the widgets animate. Press Ctrl+C here to stop." -ForegroundColor Gray
Write-Host ""

# 2. Run the demo (blocks until Ctrl+C).
$env:LOGHUB_PORT = "$Port"
node (Join-Path $root "scripts\demo-dashboard.mjs")
