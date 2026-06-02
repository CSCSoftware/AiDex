# Verify identity before killing, then stop PID 29184 (foreign session's old-build MCP server)
$target = 29184
$ourMcp = 36880

$p = Get-CimInstance Win32_Process -Filter "ProcessId=$target" -ErrorAction SilentlyContinue
if (-not $p) { Write-Host "PID $target not running (already gone)."; exit 0 }

Write-Host "About to kill PID $target"
Write-Host ("  Cmd: " + $p.CommandLine)
Write-Host ("  Parent PID: " + $p.ParentProcessId)

# Safety: never kill our own MCP server
if ($target -eq $ourMcp) { Write-Host "REFUSING: that is our own MCP server."; exit 1 }
if ($p.CommandLine -notlike "*Aidex/build/index.js*") { Write-Host "REFUSING: not an AiDex MCP node process."; exit 1 }

Stop-Process -Id $target -Force
Start-Sleep -Milliseconds 400
$still = Get-Process -Id $target -ErrorAction SilentlyContinue
if ($still) { Write-Host "Still alive?!" } else { Write-Host "Killed PID $target." }

Write-Host ""
Write-Host "--- Ports after kill ---"
foreach ($port in 3333, 3335) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($c) { Write-Host ("Port $port still LISTEN by PID " + ($c | Select-Object -First 1).OwningProcess) }
    else { Write-Host ("Port $port FREE") }
}
